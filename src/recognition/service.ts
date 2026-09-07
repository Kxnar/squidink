import { SquidError } from '../errors';
import { hash } from '../hash';
import type { Model, PluginData, PreparedImage, Recognition } from '../types';
import type { RecognitionProvider } from './openai';
import { report, reserve } from './budget';
import { MAX_OUTPUT_TOKENS, PROMPT_VERSION } from './prompt';

export async function cacheKey(image: PreparedImage, model: Model): Promise<string> {
  return hash(JSON.stringify([image.hash, image.viewport, image.width, image.height, model, PROMPT_VERSION, MAX_OUTPUT_TOKENS]));
}
export class RecognitionService {
  private active?: AbortController;
  private disabled = false;
  get busy(): boolean { return !!this.active; }
  constructor(private data: PluginData, private provider: RecognitionProvider, private save: () => Promise<void>) {}
  cancel(): void { this.active?.abort(); }
  dispose(): void { this.disabled = true; this.cancel(); }

  async run(image: PreparedImage, model: Model, key: string): Promise<{ result: Recognition; cached: boolean }> {
    if (this.disabled) throw new SquidError('Squid was disabled. Start again after enabling it.');
    if (this.active) throw new SquidError('One transcription is already running. Wait for it to finish or cancel it.');
    const controller = new AbortController();
    this.active = controller;
    let entry: ReturnType<typeof reserve> | undefined;
    try {
      const id = await cacheKey(image, model);
      if (controller.signal.aborted) throw new SquidError('Transcription was cancelled.', 'cancelled');
      const cached = this.data.settings.cacheEnabled ? this.data.cache[id] : undefined;
      if (cached) return { result: structuredClone(cached), cached: true };
      if (!key.trim()) throw new SquidError('Select an OpenAI API key in Squid settings.', 'auth');
      entry = reserve(this.data, model);
      await this.save(); // Persist the allowance BEFORE submitting a billable request.
      if (controller.signal.aborted) {
        entry.state = 'reconciled'; entry.estimatedGBP = 0;
        throw new SquidError('Transcription was cancelled before submission.', 'cancelled');
      }
      const result = await this.provider.transcribe(image, model, key, controller.signal, async usage => {
        report(entry!, usage); await this.save();
      });
      if (controller.signal.aborted || this.disabled) throw new SquidError('Transcription was cancelled; the result was discarded.', 'cancelled');
      if (this.data.settings.cacheEnabled) {
        this.data.cache[id] = result;
        const keys = Object.keys(this.data.cache);
        for (const old of keys.slice(0, Math.max(0, keys.length - 20))) delete this.data.cache[old];
      }
      return { result, cached: false };
    } finally {
      if (entry?.state === 'pending') entry.state = 'unknown';
      try { if (entry) await this.save(); } finally { if (this.active === controller) this.active = undefined; }
    }
  }
}

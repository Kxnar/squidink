import { SquidError } from '../errors';
import type { Model, PreparedImage, Recognition, Usage } from '../types';
import { MAX_OUTPUT_TOKENS, TRANSCRIPTION_INSTRUCTIONS, TRANSCRIPTION_SCHEMA } from './prompt';

export interface TransportResponse { status: number; body: unknown }
export type Transport = (body: string, key: string, signal: AbortSignal) => Promise<TransportResponse>;
export interface RecognitionProvider {
  transcribe(image: PreparedImage, model: Model, key: string, signal: AbortSignal,
    reportUsage: (usage: Usage) => Promise<void>): Promise<Recognition>;
}

export function requestBody(image: PreparedImage, model: Model): string {
  return JSON.stringify({
    model, store: false, service_tier: 'default', max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: 'low' }, instructions: TRANSCRIPTION_INSTRUCTIONS,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Transcribe only this image faithfully. Return the requested JSON object.' },
      { type: 'input_image', image_url: image.dataUrl, detail: 'high' },
    ] }],
    text: { format: { type: 'json_schema', name: 'ink_transcription', strict: true, schema: TRANSCRIPTION_SCHEMA } },
  });
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readUsage(body: unknown): Usage | undefined {
  const value = object(object(body).usage);
  const inputTokens = value.input_tokens, outputTokens = value.output_tokens;
  const cachedInputTokens = object(value.input_tokens_details).cached_tokens ?? 0;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || typeof cachedInputTokens !== 'number'
    || ![inputTokens, outputTokens, cachedInputTokens].every(n => Number.isSafeInteger(n) && n >= 0)
    || cachedInputTokens > inputTokens) return;
  return { inputTokens, outputTokens, cachedInputTokens };
}

export function parseResponse(body: unknown, latencyMs: number): Recognition {
  const data = object(body);
  if (data.status !== 'completed') throw new SquidError('OpenAI returned incomplete output. Nothing was applied. Try a smaller crop; a retry may incur another charge.', 'incomplete');
  if (!Array.isArray(data.output)) throw new SquidError('OpenAI returned an unexpected response format.', 'malformed');
  const texts: string[] = [];
  for (const item of data.output) {
    const message = object(item);
    if (message.type !== 'message') continue;
    if (message.status !== undefined && message.status !== 'completed') throw new SquidError('OpenAI returned an unfinished message.', 'incomplete');
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const content = object(part);
      if (content.type === 'refusal') throw new SquidError('OpenAI declined this image. No transcript was applied.', 'refusal');
      if (content.type === 'output_text' && typeof content.text === 'string') texts.push(content.text);
    }
  }
  let result: Record<string, unknown>;
  try { result = object(JSON.parse(texts.join(''))); }
  catch { throw new SquidError('OpenAI returned malformed transcription data. No transcript was applied.', 'malformed'); }
  if (typeof result.markdown !== 'string' || !Array.isArray(result.unresolved)
    || !result.unresolved.every(v => typeof v === 'string') || result.markdown.length > 100_000
    || result.unresolved.length > 100 || result.unresolved.some(v => v.length > 4000)) {
    throw new SquidError('OpenAI returned invalid transcription fields.', 'malformed');
  }
  if (!result.markdown.trim()) throw new SquidError('OpenAI could not identify transcribable content in this crop.', 'empty');
  if (/<!--\s*squid:/i.test(result.markdown)) throw new SquidError('The response contains reserved pair markers. It cannot be inserted.', 'malformed');
  return { markdown: result.markdown.trim(), unresolved: result.unresolved as string[],
    usage: readUsage(body), responseId: typeof data.id === 'string' ? data.id : undefined, latencyMs };
}

export class OpenAIProvider implements RecognitionProvider {
  constructor(private transport: Transport) {}
  async transcribe(image: PreparedImage, model: Model, key: string, signal: AbortSignal,
    reportUsage: (usage: Usage) => Promise<void>): Promise<Recognition> {
    if (!key.trim()) throw new SquidError('Select an OpenAI API key in Squid settings.', 'auth');
    if (signal.aborted) throw new SquidError('Transcription was cancelled.', 'cancelled');
    const start = performance.now();
    const response = await this.transport(requestBody(image, model), key, signal);
    const usage = readUsage(response.body);
    // Record billable usage even when output was truncated or rejected by local validation.
    if (usage) await reportUsage(usage);
    if (signal.aborted) throw new SquidError('Transcription was cancelled. The submitted request may still be charged.', 'cancelled');
    if (response.status === 401 || response.status === 403) throw new SquidError('OpenAI rejected the key or model access. Check your API project and secret.', 'auth');
    if (response.status === 429) throw new SquidError('OpenAI reported a rate limit or exhausted quota. Check your API account before retrying.', 'rate-limit');
    if (response.status < 200 || response.status >= 300) throw new SquidError(`OpenAI request failed (HTTP ${response.status}). No automatic retry was made.`, 'provider');
    return parseResponse(response.body, Math.round(performance.now() - start));
  }
}

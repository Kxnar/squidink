import { readFile, writeFile, mkdir, open, appendFile, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateDataset, formulaScore, type DatasetSection } from '../src/evaluation/metrics';
import { OpenAIProvider } from '../src/recognition/openai';
import { openAITransport } from '../src/recognition/transport';
import { RecognitionService } from '../src/recognition/service';
import { PROMPT_VERSION } from '../src/recognition/prompt';
import { usedGBP } from '../src/recognition/budget';
import { SquidError } from '../src/errors';
import { freshData, type Model, type PluginData, type Recognition } from '../src/types';

interface RunResult {
  id: string; sourceSectionId: string; kind: DatasetSection['kind']; split: DatasetSection['split'];
  model: string; promptVersion: string; imageHash: string; result?: Recognition; error?: string;
  reviewSeconds?: number; manualTypingSeconds?: number; renderingSuccess?: boolean;
  wrongSymbols?: number; omittedLines?: number; alteredReasoningSteps?: number;
}
const args = process.argv.slice(2);
const command = args[0];
const option = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function main(): Promise<void> {
  if (command === 'init') {
    const dir = path.resolve(args[1] ?? 'benchmark/private');
    await mkdir(path.join(dir, 'images'), { recursive: true }); await mkdir(path.join(dir, 'references'), { recursive: true });
    const sections = Array.from({ length: 60 }, (_, i) => {
      const id = `section-${String(i + 1).padStart(2, '0')}`;
      return { id, sourceSectionId: id, split: i < 40 ? 'development' : 'held-out', kind: 'section',
        image: `images/${id}.png`, reference: `references/${id}.md`, tags: [] };
    });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, sections }, null, 2) + '\n', { flag: 'wx' });
    console.log('Created 60 empty benchmark slots. Add real Ink image exports and independently checked reference transcripts.');
    return;
  }
  if (!['validate', 'run', 'score'].includes(command ?? '') || !args[1]) {
    console.log('Usage: npm run benchmark -- init [directory] | validate manifest.json | score manifest.json results.jsonl | run manifest.json --allow-paid --model MODEL --split development|held-out --gbp-per-usd RATE --previous-spend-gbp AMOUNT [--output DIR]');
    return;
  }
  const manifestPath = path.resolve(args[1]);
  const dir = path.dirname(manifestPath);
  const dataset = validateDataset(JSON.parse(await readFile(manifestPath, 'utf8')));
  const missing: string[] = [];
  for (const section of dataset.sections) for (const name of [section.image, section.reference]) {
    try { await access(path.resolve(dir, name)); } catch { missing.push(name); }
  }
  if (missing.length) throw new Error(`${missing.length} benchmark assets are missing. Populate all 60 source sections before evaluating.`);
  if (command === 'validate') { console.log(`Validated ${dataset.sections.length} examples; no split leakage. No API calls made.`); return; }
  if (command === 'score') {
    if (!args[2]) throw new Error('Provide the results JSONL file.');
    const records = (await readFile(args[2], 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RunResult);
    const rows = [];
    for (const record of records) {
      const section = dataset.sections.find(s => s.id === record.id);
      if (!section) throw new Error('A result references an unknown dataset section.');
      if (record.sourceSectionId !== section.sourceSectionId || record.split !== section.split || record.kind !== section.kind) throw new Error('Result metadata does not match the frozen dataset.');
      if (record.model.toLowerCase() === 'texteller' && section.kind !== 'equation-crop') throw new Error('Score TexTeller only on the equation-crop subset.');
      const reference = await readFile(path.resolve(dir, section.reference), 'utf8');
      rows.push({ id: record.id, model: record.model, split: section.split, kind: section.kind,
        formula: record.result ? formulaScore(reference, record.result.markdown) : null,
        wrongSymbols: record.wrongSymbols ?? null, omittedLines: record.omittedLines ?? null,
        alteredReasoningSteps: record.alteredReasoningSteps ?? null,
        renderingSuccess: record.renderingSuccess ?? null,
        reviewSeconds: record.reviewSeconds ?? null, manualTypingSeconds: record.manualTypingSeconds ?? null,
        reviewFaster: record.reviewSeconds !== undefined && record.manualTypingSeconds !== undefined ? record.reviewSeconds < record.manualTypingSeconds : null,
        latencyMs: record.result?.latencyMs ?? null, usage: record.result?.usage ?? null, error: record.error ?? null });
    }
    const output = option('--output') ?? 'benchmark/results/scores.json';
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ formulaNormalization: 'formatting-only-v1', rows }, null, 2));
    console.log(`Wrote ${rows.length} score rows. Null values are unmeasured, not successful or zero.`);
    return;
  }
  if (!args.includes('--allow-paid')) throw new Error('Paid runs require --allow-paid. Validation and scoring are free.');
  const model = option('--model');
  const split = option('--split');
  const rate = Number(option('--gbp-per-usd'));
  const previousSpend = Number(option('--previous-spend-gbp'));
  if (!['gpt-5.6-sol', 'gpt-5.6-luna'].includes(model ?? '') || !['development', 'held-out'].includes(split ?? '')) throw new Error('Choose an explicit supported model and split.');
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(previousSpend) || previousSpend < 0) throw new Error('Set an effective GBP/USD rate and previous evaluation spend, including funding fees and plugin runs.');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Set OPENAI_API_KEY locally; do not put it in the manifest or source code.');
  const output = path.resolve(option('--output') ?? 'benchmark/results');
  await mkdir(output, { recursive: true });
  const lockPath = path.join(output, '.run.lock');
  const lock = await open(lockPath, 'wx');
  try {
    const ledgerPath = path.join(output, 'ledger.json');
    let data: PluginData;
    try {
      data = JSON.parse(await readFile(ledgerPath, 'utf8')) as PluginData;
      if (data.version !== 1 || !Array.isArray(data.spend)) throw new Error('Invalid evaluation ledger.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      data = freshData();
    }
    if (data.spend.some(e => e.state === 'pending' || e.state === 'unknown')) throw new Error('Reconcile the previous unconfirmed charge in ledger.json before running again.');
    data.settings = { ...data.settings, cacheEnabled: false, budgetGBP: 10, gbpPerUsd: rate,
      otherSpendGBP: previousSpend, requestAllowanceGBP: Math.max(0.5, 0.5 * rate) };
    const service = new RecognitionService(data, new OpenAIProvider(openAITransport), async () => {
      await writeFile(ledgerPath, JSON.stringify(data, null, 2));
    });
    const resultsPath = path.join(output, 'results.jsonl');
    let previous: RunResult[] = [];
    try { previous = (await readFile(resultsPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RunResult); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const stop = () => service.cancel();
    process.once('SIGINT', stop);
    try {
      for (const section of dataset.sections.filter(s => s.split === split && s.kind === 'section')) {
        const bytes = await readFile(path.resolve(dir, section.image));
        if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.length < 24) throw new Error('A dataset image is not a PNG.');
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304) throw new Error('A benchmark image exceeds Squid’s image limits. Export a readable supported section.');
        const imageHash = sha256(bytes);
        if (previous.some(r => r.id === section.id && r.model === model && r.promptVersion === PROMPT_VERSION && r.imageHash === imageHash && r.result)) continue;
        const record: RunResult = { id: section.id, sourceSectionId: section.sourceSectionId, split: section.split,
          kind: section.kind, model: model!, promptVersion: PROMPT_VERSION, imageHash };
        try {
          record.result = (await service.run({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
            hash: imageHash, viewport: { x: 0, y: 0, width, height }, width, height }, model as Model, key)).result;
        } catch (error) {
          record.error = error instanceof SquidError ? error.code : 'failed';
          await appendFile(resultsPath, JSON.stringify(record) + '\n');
          throw new Error('Evaluation stopped after a failed request. Check the ledger before any explicit retry.');
        }
        await appendFile(resultsPath, JSON.stringify(record) + '\n');
        console.log(`${section.id} · ${model} · accounted £${usedGBP(data).toFixed(3)} / £10.00`);
      }
    } finally { process.removeListener('SIGINT', stop); service.dispose(); }
  } finally { await lock.close(); await unlink(lockPath); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Evaluation failed.'); process.exitCode = 1; });

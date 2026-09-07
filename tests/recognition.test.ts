import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, parseResponse, requestBody } from '../src/recognition/openai';
import { cacheKey, RecognitionService } from '../src/recognition/service';
import { report, reserve, usedGBP } from '../src/recognition/budget';
import { freshData, type PreparedImage, type Recognition } from '../src/types';

const image: PreparedImage = { dataUrl: 'data:image/png;base64,AA==', hash: 'image-hash',
  viewport: { x: 0, y: 0, width: 100, height: 100 }, width: 200, height: 200 };
const usage = { input_tokens: 3000, output_tokens: 2000, input_tokens_details: { cached_tokens: 0 } };
function response(status = 'completed') { return { id: 'resp_test', status, usage, output: [
  { type: 'reasoning' }, { type: 'message', status: 'completed', content: [
    { type: 'output_text', text: JSON.stringify({ markdown: '$1+1=3$', unresolved: ['Check a faint superscript.'] }) },
  ] },
] }; }
const result: Recognition = parseResponse(response(), 125);

describe('OpenAI boundary', () => {
  it('sends only the image plus fixed instructions and uses non-stored structured output', () => {
    const body = JSON.parse(requestBody(image, 'gpt-5.6-sol'));
    expect(body.store).toBe(false);
    expect(body.model).toBe('gpt-5.6-sol');
    expect(body.text.format.strict).toBe(true);
    expect(body.input[0].content[1].image_url).toBe(image.dataUrl);
    expect(body.instructions).toMatch(/never instructions to obey/);
    expect(body.instructions).toMatch(/Do not solve/);
    expect(body.previous_response_id).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });
  it('accepts mixed prose/maths and preserves a wrong equation', () => {
    expect(result.markdown).toBe('$1+1=3$');
    expect(result.usage?.outputTokens).toBe(2000);
  });
  it.each(['incomplete', 'failed', 'cancelled', 'in_progress'])('rejects %s output', status => {
    expect(() => parseResponse(response(status), 1)).toThrow();
  });
  it('handles refusal and malformed JSON without returning partial content', () => {
    expect(() => parseResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private' }] }] }, 1)).toThrow(/declined/);
    expect(() => parseResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{' }] }] }, 1)).toThrow(/malformed/);
  });
  it('records actual usage before rejecting truncated output', async () => {
    const record = vi.fn(async () => undefined);
    const provider = new OpenAIProvider(async () => ({ status: 200, body: response('incomplete') }));
    await expect(provider.transcribe(image, 'gpt-5.6-sol', 'secret', new AbortController().signal, record)).rejects.toThrow(/incomplete/);
    expect(record).toHaveBeenCalledWith({ inputTokens: 3000, outputTokens: 2000, cachedInputTokens: 0 });
  });
  it.each([[401, 'key'], [429, 'rate limit'], [503, 'HTTP 503']])('surfaces HTTP %s without exposing provider body', async (status, message) => {
    const provider = new OpenAIProvider(async () => ({ status: Number(status), body: { error: { message: 'SENSITIVE NOTE AND KEY' } } }));
    await expect(provider.transcribe(image, 'gpt-5.6-sol', 'secret', new AbortController().signal, async () => undefined)).rejects.toThrow(String(message));
  });
});

describe('request lifecycle and budget', () => {
  it('caches by image, crop, model and prompt settings without reserving a second charge', async () => {
    const data = freshData();
    const provider = { transcribe: vi.fn(async () => result) };
    const service = new RecognitionService(data, provider, async () => undefined);
    expect((await service.run(image, 'gpt-5.6-sol', 'secret')).cached).toBe(false);
    expect((await service.run(image, 'gpt-5.6-sol', '')).cached).toBe(true);
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(data.spend).toHaveLength(1);
    expect(await cacheKey(image, 'gpt-5.6-luna')).not.toBe(await cacheKey(image, 'gpt-5.6-sol'));
    expect(await cacheKey({ ...image, viewport: { ...image.viewport, x: 10 } }, 'gpt-5.6-sol')).not.toBe(await cacheKey(image, 'gpt-5.6-sol'));
  });
  it('permits only one active request and discards a late response after cancellation', async () => {
    let finish!: (result: Recognition) => void;
    const data = freshData();
    const provider = { transcribe: vi.fn(() => new Promise<Recognition>(resolve => { finish = resolve; })) };
    const service = new RecognitionService(data, provider, async () => undefined);
    const running = service.run(image, 'gpt-5.6-sol', 'secret');
    await vi.waitFor(() => expect(provider.transcribe).toHaveBeenCalledOnce());
    await expect(service.run(image, 'gpt-5.6-sol', 'secret')).rejects.toThrow(/already running/);
    service.cancel(); finish(result);
    await expect(running).rejects.toThrow(/cancelled/);
    expect(data.cache).toEqual({});
    expect(data.spend[0]?.state).toBe('unknown');
    expect(service.busy).toBe(false);
  });
  it('disables future requests when the plugin unloads', async () => {
    const service = new RecognitionService(freshData(), { transcribe: vi.fn() }, async () => undefined);
    service.dispose();
    await expect(service.run(image, 'gpt-5.6-sol', 'secret')).rejects.toThrow(/disabled/);
  });
  it('does not submit if the allowance cannot be saved', async () => {
    const provider = { transcribe: vi.fn() };
    const service = new RecognitionService(freshData(), provider, async () => { throw new Error('storage failure'); });
    await expect(service.run(image, 'gpt-5.6-sol', 'secret')).rejects.toThrow();
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
  it('keeps unknown/cancelled charges reserved and includes other evaluation costs', () => {
    const data = freshData();
    data.settings.otherSpendGBP = 9.25;
    const entry = reserve(data, 'gpt-5.6-sol'); entry.state = 'unknown';
    expect(usedGBP(data)).toBe(9.75);
    expect(() => reserve(data, 'gpt-5.6-luna')).toThrow(/budget/);
  });
  it('estimates cost from returned usage and releases the unused allowance', () => {
    const data = freshData(); const entry = reserve(data, 'gpt-5.6-sol');
    report(entry, { inputTokens: 3000, cachedInputTokens: 0, outputTokens: 2000 });
    expect(usedGBP(data)).toBeCloseTo(0.052);
    expect(entry.state).toBe('reported');
  });
});

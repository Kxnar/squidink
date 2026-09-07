import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: transport.request }));
import { openAITransport } from '../src/recognition/transport';

function connection() {
  const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  let receive!: (response: EventEmitter) => void;
  transport.request.mockImplementation((_url, _options, callback: typeof receive) => { receive = callback; return request; });
  return { request, response, receive: () => receive(response) };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('desktop network lifecycle', () => {
  it('aborts the local request and does not expose the key in the error', async () => {
    const c = connection(); const abort = new AbortController();
    const pending = openAITransport('{}', 'PRIVATE_TEST_SECRET', abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow('may still be charged');
    expect(c.request.destroy).toHaveBeenCalledOnce();
  });
  it('ends stalled requests at the deadline without retries', async () => {
    vi.useFakeTimers(); const c = connection();
    const pending = openAITransport('{}', 'secret', new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('two minutes');
    await vi.advanceTimersByTimeAsync(120_000); await rejected;
    expect(c.request.destroy).toHaveBeenCalledOnce(); expect(transport.request).toHaveBeenCalledOnce();
  });
  it('rejects an oversized response rather than accumulating it', async () => {
    const c = connection(); const pending = openAITransport('{}', 'secret', new AbortController().signal);
    c.receive(); c.response.emit('data', Buffer.alloc(2_000_001));
    await expect(pending).rejects.toThrow('oversized'); expect(c.request.destroy).toHaveBeenCalledOnce();
  });
  it('uses only the fixed API endpoint and returns redirect errors without following them', async () => {
    const c = connection(); const pending = openAITransport('{}', 'secret', new AbortController().signal);
    c.response.statusCode = 302; c.receive();
    c.response.emit('data', Buffer.from('{}')); c.response.emit('end');
    expect((await pending).status).toBe(302);
    expect(transport.request.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(transport.request).toHaveBeenCalledOnce();
  });
});

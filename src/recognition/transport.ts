import { request } from 'node:https';
import { SquidError } from '../errors';
import type { Transport } from './openai';

/** Desktop HTTPS avoids browser CORS and allows genuine local abort/timeout. No redirects. */
export const openAITransport: Transport = (body, key, signal) => new Promise((resolve, reject) => {
  let done = false;
  const finish = (error?: SquidError, result?: { status: number; body: unknown }) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    if (error) reject(error); else resolve(result!);
  };
  const req = request('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  }, res => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_000_000) { finish(new SquidError('OpenAI returned an oversized response.', 'malformed')); req.destroy(); }
      else chunks.push(chunk);
    });
    res.on('end', () => {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { finish(new SquidError('OpenAI returned unreadable response data.', 'malformed')); return; }
      finish(undefined, { status: res.statusCode ?? 0, body: parsed });
    });
    res.on('error', () => finish(new SquidError('The connection ended before the full response arrived.', 'network')));
    res.on('aborted', () => finish(new SquidError('The connection was interrupted.', 'network')));
  });
  const cancel = () => { finish(new SquidError('Transcription cancelled. A submitted request may still be charged.', 'cancelled')); req.destroy(); };
  const timer = setTimeout(() => {
    finish(new SquidError('OpenAI did not finish within two minutes. The request may still be charged; no retry was made.', 'timeout'));
    req.destroy();
  }, 120_000);
  req.on('error', () => finish(new SquidError('Could not connect to OpenAI. Check your connection before retrying.', 'network')));
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel(); else req.end(body);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localForwarder, localBaseURL } from '../src/local.js';

test('Ollama forwarding drops all credentials and preserves the Responses bytes', async () => {
  const bytes = Buffer.from('{"model":"ollama-model","input":"fixture"}');
  const forward = localForwarder('http://127.0.0.1:11434/api/codex/v1', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/codex/v1/responses');
    assert.deepEqual([...new Headers(init?.headers).keys()], ['accept', 'content-type']);
    assert.deepEqual(Buffer.from(init?.body as Uint8Array), bytes);
    assert.equal(init?.redirect, 'manual');
    return new Response('fixture');
  });
  await forward({path: '/v1/responses', body: bytes, signal: new AbortController().signal,
    headers: {authorization: 'Bearer inert-gpt', 'chatgpt-account-id': 'inert-account', cookie: 'inert', 'x-codex-router-token': 'inert-local'}});
});

test('local route rejects arbitrary destinations and redirect forwarding', async () => {
  for (const url of ['http://example.com/v1', 'http://user:pass@127.0.0.1/v1', 'http://127.0.0.1/v1?secret=1', 'https://127.0.0.1/v1']) assert.throws(() => localBaseURL(url));
  const forward = localForwarder('http://127.0.0.1:11434/v1', async () => new Response('', {status: 302, headers: {location: 'https://example.com'}}));
  await assert.rejects(forward({path: '/v1/responses', body: Buffer.from('{}'), signal: new AbortController().signal, headers: {}}), /redirects/);
});

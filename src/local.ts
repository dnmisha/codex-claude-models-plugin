import { BridgeError } from './contracts.js';
import type { ForwardOpenAI } from './openai.js';

export function localBaseURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('The Ollama bridge must use plain HTTP on 127.0.0.1 without URL credentials, query or fragment.');
  }
  return url;
}

// Ollama's Codex bridge handles its own cloud login. Never forward the user's
// ChatGPT credential, account identifier, cookies or local router token.
export function localForwarder(baseURL: string, fetchImpl: typeof fetch = fetch): ForwardOpenAI {
  const base = localBaseURL(baseURL).href.replace(/\/$/, '');
  return async request => {
    if (!['/v1/responses', '/v1/responses/compact'].includes(request.path)) throw new BridgeError(404, 'unsupported_route', 'Unsupported local route.');
    const headers = new Headers({'content-type': 'application/json', accept: 'text/event-stream'});
    const response = await fetchImpl(`${base}${request.path.slice(3)}`, {method: 'POST', headers,
      body: new Uint8Array(request.body), signal: request.signal, redirect: 'manual'});
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new BridgeError(502, 'upstream_redirect', 'Local provider redirects are not allowed.');
    }
    return response;
  };
}

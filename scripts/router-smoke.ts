import { ensureIdentity, tlsOptions, identityPaths } from '../src/transport.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import TOML from '@iarna/toml';
import { createServer as createSecureServer } from 'node:https';
import { bridgeServer } from '../src/server.js';
import { codexCatalog } from '../src/catalog.js';
import { requestSchema } from '../src/contracts.js';
import { responseEnvelope, completedResponse, completionEvents } from '../src/adapter.js';
import { activateRouter, deactivate, installConfig, locations, trustRouterStartup } from '../src/setup.js';
import { usageFromModels } from '../src/sdk.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-consumer-'));
const p = locations(path.join(root, 'home'));
const claude = {id: 'claude-sdk-haiku', sdkModel: 'haiku', displayName: 'Claude Test', description: 'Fixture', efforts: []};
const openaiModel = {...codexCatalog([claude]).models[0]!, slug: 'gpt-fixture', display_name: 'GPT Test'};
const localModel = {...openaiModel, slug: 'ollama-fixture', display_name: 'Ollama Test'};
const routed: string[] = [];
const forwardFixture = (text: string) => async (request: import('../src/openai.js').OpenAIRequest) => {
  const parsed = requestSchema.parse(JSON.parse(request.body.toString()));
  routed.push(parsed.model);
  const base = responseEnvelope(parsed.model);
  const completed = completedResponse(base, parsed, result(text));
  const events = [{type: 'response.created', response: base}, ...completionEvents(completed)];
  return new Response(events.map((event, index) => `data: ${JSON.stringify({...event, sequence_number: index})}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
};
const result = (text: string) => ({decision: {text, calls: []}, usage: usageFromModels({})});
await ensureIdentity(p.root);
const server = bridgeServer({tls: await tlsOptions(p.root), token: 'fixture-local-token', run: async request => {
  routed.push(request.model); return result('CLAUDE_REPLY');
}, local: {models: new Set(['ollama-fixture']), forward: forwardFixture('OLLAMA_REPLY')},
  openai: {models: new Set(['gpt-fixture']), forward: forwardFixture('GPT_REPLY')}});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let proc: ReturnType<typeof spawn> | undefined;
const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
let sequence = 0;
let onCompleted: ((turn: any) => void) | undefined;
let rejectTurn: ((error: Error) => void) | undefined;
let finalTexts: string[] = [];
let stderr = '';
const deadline = setTimeout(() => {
  proc?.kill(); const error = new Error(`Codex router smoke timed out: ${stderr}`);
  for (const wait of pending.values()) wait.reject(error); rejectTurn?.(error);
}, 45000);

try {
  await fs.mkdir(p.root, {recursive: true});
  await fs.writeFile(p.token, 'fixture-local-token');
  await fs.writeFile(path.join(p.root, 'setup.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(new URL('./hook-ran', import.meta.url), 'started');\n");
  await fs.writeFile(path.join(p.home, 'ollama-launch-codex-routing.json'), JSON.stringify({models: [{slug: 'ollama-fixture'}]}));
  await fs.writeFile(p.config, TOML.stringify({model: 'gpt-fixture', openai_base_url: 'http://127.0.0.1:11434/api/codex/v1', features: {plugins: false, apps: false, remote_plugin: false}}));
  await installConfig(p, [claude], (server.address() as AddressInfo).port, {models: [openaiModel, localModel]});
  await activateRouter(p);
  const config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  // CI uses inert credentials. Live subscription forwarding is tested separately.
  config.model_providers.codex_model_router.requires_openai_auth = false;
  Object.assign(config.model_providers.codex_model_router.http_headers, {Authorization: 'Bearer fixture-openai-token', 'ChatGPT-Account-ID': 'fixture-account'});
  await fs.writeFile(p.config, TOML.stringify(config));
  await trustRouterStartup(p);
  proc = spawn(process.env.CODEX_BIN ?? 'codex', ['app-server', '--stdio'], {cwd: root, env: {...process.env, CODEX_HOME: p.home, CODEX_CA_CERTIFICATE: identityPaths(p.root).cert}, stdio: ['pipe', 'pipe', 'pipe']});
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; pending.set(id, {resolve, reject}); proc!.stdin!.write(`${JSON.stringify({id, method, params})}\n`);
  });
  proc.stderr!.on('data', chunk => {stderr += chunk;});
  let buffer = '';
  proc.stdout!.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        const waiting = pending.get(message.id)!; pending.delete(message.id);
        if (message.error) waiting.reject(new Error(JSON.stringify(message.error))); else waiting.resolve(message.result);
      }
      if (message.method === 'item/completed' && message.params.item.type === 'agentMessage') finalTexts.push(message.params.item.text);
      if (message.method === 'turn/completed') onCompleted?.(message.params.turn);
    }
  });
  await rpc('initialize', {clientInfo: {name: 'router-consumer-test', version: '0.2.0'}, capabilities: {experimentalApi: true}});
  proc.stdin!.write(`${JSON.stringify({method: 'initialized'})}\n`);
  const list = await rpc('model/list', {limit: 100});
  assert.deepEqual(list.data.map((m: any) => m.model).sort(), ['claude-sdk-haiku', 'gpt-fixture', 'ollama-fixture']);
  assert.ok(list.data.every((m: any) => !m.hidden));
  const thread = await rpc('thread/start', {model: 'gpt-fixture', cwd: root, sandbox: 'danger-full-access', approvalPolicy: 'never', ephemeral: true});
  for (const [model, expected] of [['gpt-fixture', 'GPT_REPLY'], ['claude-sdk-haiku', 'CLAUDE_REPLY'], ['ollama-fixture', 'OLLAMA_REPLY'], ['gpt-fixture', 'GPT_REPLY']]) {
    finalTexts = [];
    const completed = new Promise<any>((resolve, reject) => {onCompleted = resolve; rejectTurn = reject;});
    await rpc('turn/start', {threadId: thread.thread.id, model, input: [{type: 'text', text: 'Reply without tools.'}]});
    const turn = await completed;
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    assert.ok(finalTexts.includes(expected!), JSON.stringify(finalTexts));
  }
  assert.deepEqual(routed, ['gpt-fixture', 'claude-sdk-haiku', 'ollama-fixture', 'gpt-fixture']);
  assert.equal(await fs.readFile(path.join(p.root, 'hook-ran'), 'utf8'), 'started');
  // Replace the listening process while Codex retains the genuine certificate.
  const port = (server.address() as AddressInfo).port;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await ensureIdentity(path.join(root, 'impostor'));
  let captured = 0;
  const impostor = createSecureServer(await tlsOptions(path.join(root, 'impostor')), (_req, res) => {captured++; res.end();});
  const rejectedHandshake = once(impostor, 'tlsClientError');
  impostor.listen(port, '127.0.0.1'); await once(impostor, 'listening');
  try {
    const completed = new Promise<any>((resolve, reject) => {onCompleted = resolve; rejectTurn = reject;});
    const started = await rpc('turn/start', {threadId: thread.thread.id, model: 'gpt-fixture', input: [{type: 'text', text: 'Inert replacement-server test.'}]});
    await rejectedHandshake;
    // Codex core may retry TLS failures independently of provider retry limits.
    await rpc('turn/interrupt', {threadId: thread.thread.id, turnId: started.turn.id});
    assert.equal((await completed).status, 'interrupted');
    assert.equal(captured, 0, 'An untrusted replacement must never receive HTTP authorization or prompts');
  } finally {impostor.closeAllConnections(); await new Promise<void>(resolve => impostor.close(() => resolve()));}
  await deactivate(p);
  const restored = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.equal(restored.hooks, undefined);
  console.log('PASS: one Codex task switches GPT → Claude → Ollama → GPT over verified TLS; rejects an impostor before HTTP credentials; the native trusted startup hook runs and is removed on deactivation.');
} finally {
  clearTimeout(deadline); proc?.kill(); server.closeAllConnections(); server.close();
  await fs.rm(root, {recursive: true, force: true});
}

import { ensureIdentity, tlsOptions, identityPaths } from '../src/transport.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import TOML from '@iarna/toml';
import { bridgeServer } from '../src/server.js';
import { offeredTools } from '../src/contracts.js';
import { activate, installConfig, locations } from '../src/setup.js';
import { usageFromModels, sdkRunner } from '../src/sdk.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-claude-consumer-'));
const home = locations(path.join(root, 'home'));
const model = {id: 'claude-sdk-sonnet', sdkModel: 'sonnet', displayName: 'Claude Agent Test', description: 'Fixture model', efforts: []};
await fs.mkdir(root, {recursive: true});
await fs.writeFile(path.join(root, 'fixture.txt'), 'CODEX_TOOL_ROUNDTRIP_429731\n');
let modelCalls = 0;
let observedToolResult = false;
await ensureIdentity(home.root);
const diagnosticQuery: typeof query = ((args: any) => {
 const session = query(args);
 const original = session[Symbol.asyncIterator].bind(session);
 session[Symbol.asyncIterator] = async function* () {
  for await (const msg of original()) {
   if (msg.type === 'assistant') console.log('SDK tools', msg.message.content.filter((c: any) => c.type === 'tool_use').map((c: any) => c.name));
   if (msg.type === 'user') console.log('SDK errors', JSON.stringify(msg.message.content).includes('No such tool available'));
   yield msg;
  }
 };
 return session;
}) as typeof query;
const runSdk = sdkRunner(root, [model], diagnosticQuery);
const server = bridgeServer({tls: await tlsOptions(home.root), token: 'test-token', run: async (request, signal) => {
 modelCalls++;
 console.log('ADVERTISED', offeredTools(request.tools).map(t => t.key));
 const outputs = Array.isArray(request.input) ? request.input.filter(i => String(i.type).endsWith('call_output')) : [];
 console.log('OUTER errors', JSON.stringify(outputs).includes('No such tool available'));
 const result = await runSdk(request, signal);
 console.log('DECISION calls', result.decision.calls.map(c => c.name));
 if (JSON.stringify(outputs).includes('CODEX_TOOL_ROUNDTRIP_429731')) observedToolResult = true;
 return result;
}});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const children: ReturnType<typeof spawn>[] = [];
function child(args: string[]) {
  const proc = spawn(process.env.CODEX_BIN ?? 'codex', args, {cwd: root, env: {...process.env, CODEX_HOME: home.home, CODEX_CA_CERTIFICATE: identityPaths(home.root).cert}, stdio: ['pipe', 'pipe', 'pipe']});
  children.push(proc); return proc;
}

try {
  await installConfig(home, [model], (server.address() as AddressInfo).port);
  await activate(home);
  const config = TOML.parse(await fs.readFile(home.config, 'utf8')) as any;
  delete config.model_providers.claude_agent_sdk.auth;
  config.model_providers.claude_agent_sdk.http_headers = {Authorization: 'Bearer test-token'};
  config.features = {remote_plugin: false, plugins: false, apps: false};
  await fs.writeFile(home.config, TOML.stringify(config));

  const rpc = child(['app-server', '--stdio']);
  let buffer = '';
  let rpcErrors = '';
  rpc.stderr.on('data', chunk => {rpcErrors += chunk;});
  const catalog = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`model/list timeout: ${rpcErrors}`)), 15000);
    rpc.on('error', reject);
    rpc.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.id === 1) rpc.stdin.write(`${JSON.stringify({id: 2, method: 'model/list', params: {limit: 100}})}\n`);
        if (message.id === 2) {clearTimeout(timer); resolve(message); rpc.kill();}
      }
    });
    rpc.stdin.write(`${JSON.stringify({id: 1, method: 'initialize', params: {clientInfo: {name: 'claude-consumer-test', version: '0.1.0'}, capabilities: {experimentalApi: true}}})}\n`);
  });
  const list = await catalog;
  assert.ok(!list.error, JSON.stringify(list.error));
  assert.equal(list.result.data.length, 1);
  assert.equal(list.result.data[0].model, model.id);
  assert.equal(list.result.data[0].hidden, false);

  // This deterministic provider can request only the fixture read below. Host
  // sandbox provisioning is outside this transport test (and varies on CI).
  const cli = child(['exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '--json', 'Read fixture.txt using exec_command with cmd "sleep 2; cat fixture.txt" and yield_time_ms 1. If a session is returned, poll it using write_stdin. Then run a second command "wc -l fixture.txt" and report the exact fixture text and line count. Do not modify files.']);
  cli.stdin.end();
  let output = '', errors = '';
  cli.stdout.on('data', chunk => {output += chunk;});
  cli.stderr.on('data', chunk => {errors += chunk;});
  const timer = setTimeout(() => cli.kill('SIGTERM'), 180000);
  const [code] = await once(cli, 'close'); clearTimeout(timer);
  assert.equal(code, 0, `${output}\n${errors}`);
  assert.match(output, /CODEX_TOOL_ROUNDTRIP_429731/, `Model steps: ${modelCalls}\n${output}\n${errors}`);
  assert.equal(observedToolResult, true);
  
  console.log('PASS: live Sonnet shell, session polling, repeated read and final response through Codex.');
} finally {
  for (const proc of children) if (proc.exitCode === null) proc.kill();
  server.closeAllConnections(); server.close();
  await fs.rm(root, {recursive: true, force: true});
}

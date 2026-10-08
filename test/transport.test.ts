import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { createServer as plainServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { controlRequest, ensureIdentity, identityPaths, tlsOptions } from '../src/transport.js';
import { bridgeServer } from '../src/server.js';
import { install, locations, stop } from '../src/setup.js';

test('TLS rejects replacement HTTPS and plaintext listeners before HTTP credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-identity-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await ensureIdentity(root); await ensureIdentity(path.join(root, 'attacker'));
  assert.equal((await fs.stat(identityPaths(root).key)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(identityPaths(root).directory)).mode & 0o777, 0o700);
  for (const tls of [false, true]) {
    let requests = 0;
    const handler = (_req: unknown, res: import('node:http').ServerResponse) => {requests++; res.end('{"service":"codex-claude-models","pid":0}');};
    const server = tls ? createServer(await tlsOptions(path.join(root, 'attacker')), handler) : plainServer(handler);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      await assert.rejects(controlRequest(root, (server.address() as AddressInfo).port, 'inert-secret', '/health'));
      assert.equal(requests, 0);
    } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
  }
});

test('stop uses authenticated shutdown instead of signaling a response PID', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-shutdown-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root);
  await ensureIdentity(p.root); await fs.writeFile(p.token, 'inert-token');
  let shutdowns = 0;
  const server = bridgeServer({tls: await tlsOptions(p.root), token: 'inert-token', run: async () => {throw new Error('unused');},
    onShutdown: () => {shutdowns++; server.closeAllConnections(); server.close();}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const port = (server.address() as AddressInfo).port;
  await fs.writeFile(p.state, JSON.stringify({port}));
  const denied = await controlRequest(p.root, port, 'wrong-token', '/shutdown');
  assert.equal(denied.status, 401); assert.equal(shutdowns, 0);
  await stop(p); assert.equal(shutdowns, 1);
});

test('stop rejects malformed health and redirects', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-malformed-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root); await ensureIdentity(p.root); await fs.writeFile(p.token, 'inert-token');
  let payload: unknown; let redirected = false, shutdowns = 0;
  const server = createServer(await tlsOptions(p.root), (req, res) => {
    if (req.url === '/shutdown') shutdowns++;
    if (redirected) res.writeHead(302, {location: 'http://127.0.0.1:1/health'}).end();
    else res.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  await fs.writeFile(p.state, JSON.stringify({port: (server.address() as AddressInfo).port}));
  for (const pid of [0, -1, 1.5, '123']) {payload = {service: 'codex-claude-models', version: 'test', pid}; await stop(p);}
  redirected = true; await stop(p);
  assert.equal(shutdowns, 0);
});

test('port preflight refuses an occupied legacy listener without contacting it', async t => {
  const {assertPortAvailable} = await import('../src/transport.js');
  let requests = 0;
  const server = plainServer((_req, res) => {requests++; res.end();});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const port = (server.address() as AddressInfo).port;
  await assert.rejects(assertPortAvailable(port), /occupied/);
  assert.equal(requests, 0);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assertPortAvailable(port);
});


test('legacy occupied-port migration preserves the complete previous installation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-legacy-migration-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root); await fs.mkdir(p.root, {recursive: true});
  let requests = 0;
  const server = plainServer((_req, res) => {requests++; res.end('{"service":"codex-claude-models","pid":0}');});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const port = (server.address() as AddressInfo).port;
  const snapshot = {[p.config]: 'model = "original"\n', [p.token]: 'legacy-inert-token',
    [p.state]: JSON.stringify({port, provider: {base_url: `http://127.0.0.1:${port}/v1`}, files: {}})};
  for (const [file, content] of Object.entries(snapshot)) await fs.writeFile(file, content);
  await assert.rejects(install(p, port), /occupied/);
  for (const [file, content] of Object.entries(snapshot)) assert.equal(await fs.readFile(file, 'utf8'), content);
  assert.equal(requests, 0);
  await assert.rejects(fs.access(identityPaths(p.root).cert));
});

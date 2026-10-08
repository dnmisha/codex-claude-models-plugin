import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:https';
import { createServer } from 'node:net';

export async function assertPortAvailable(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Stop its owned process or choose another --port before installing.`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

export function identityPaths(root: string) {
  return {directory: path.join(root, 'tls'), cert: path.join(root, 'tls', 'certificate.pem'), key: path.join(root, 'tls', 'private-key.pem')};
}

export async function ensureIdentity(root: string) {
  const p = identityPaths(root);
  await fs.mkdir(p.directory, {recursive: true, mode: 0o700});
  await fs.chmod(p.directory, 0o700);
  const exists = await Promise.all([p.cert, p.key].map(file => fs.access(file).then(() => true, () => false)));
  if (exists.every(Boolean)) return;
  if (exists.some(Boolean)) throw new Error('Incomplete TLS identity. Restore both certificate and key before retrying.');
  const stage = await fs.mkdtemp(path.join(p.directory, 'stage-'));
  try {
    const config = path.join(stage, 'openssl.cnf');
    await fs.writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=Codex Claude local bridge\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', {mode: 0o600});
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-config', config,
      '-keyout', path.join(stage, 'key.pem'), '-out', path.join(stage, 'cert.pem')], {timeout: 30000});
    await fs.chmod(path.join(stage, 'key.pem'), 0o600);
    await fs.chmod(path.join(stage, 'cert.pem'), 0o600);
    await fs.rename(path.join(stage, 'key.pem'), p.key);
    await fs.rename(path.join(stage, 'cert.pem'), p.cert);
  } finally {await fs.rm(stage, {recursive: true, force: true});}
}

export async function tlsOptions(root: string) {
  const p = identityPaths(root);
  return {cert: await fs.readFile(p.cert), key: await fs.readFile(p.key), minVersion: 'TLSv1.2' as const};
}

// HTTPS validates the owned identity before writing HTTP headers. Never follow
// redirects or send credentials over a plaintext fallback.
export async function controlRequest(root: string, port: number, token: string, endpoint: '/health' | '/shutdown') {
  const ca = await fs.readFile(identityPaths(root).cert);
  return new Promise<{status: number; body: string}>((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port, path: endpoint, method: endpoint === '/shutdown' ? 'POST' : 'GET',
      ca, rejectUnauthorized: true, agent: false, headers: {Authorization: `Bearer ${token}`}}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {body += chunk; if (body.length > 4096) req.destroy(new Error('Control response too large.'));});
      res.on('end', () => resolve({status: res.statusCode ?? 0, body}));
      res.on('error', reject);
    });
    req.setTimeout(1000, () => req.destroy(new Error('Control request timed out.')));
    req.on('error', reject);
    req.end();
  });
}

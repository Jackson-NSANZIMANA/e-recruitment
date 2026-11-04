// Proof for the HTTPS front behind `pnpm sandbox:full --lan`: infrastructure/sandbox/lan-certs.sh and
// infrastructure/sandbox/tls-proxy.mjs, run for real (openssl, TLS, sockets) on loopback and ephemeral ports.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CERTS = join(ROOT, 'infrastructure/sandbox/lan-certs.sh');
const PROXY = join(ROOT, 'infrastructure/sandbox/tls-proxy.mjs');

function certs(t, ip = '127.0.0.1') {
  const dir = mkdtempSync(join(tmpdir(), 'usrp-sandbox-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync('bash', [CERTS, join(dir, 'ca'), join(dir, 'out'), ip], { encoding: 'utf8' });
  return { dir, ca: join(dir, 'ca/ca.crt'), cert: join(dir, 'out/server.crt'), key: join(dir, 'out/server.key'), ...r };
}

const freePort = () =>
  new Promise((done) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
  });

function request(url, { ca, method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method, headers, ca }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d)).on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function front(t, c) {
  const upstreamPort = await freePort();
  const port = await freePort();
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      res.setHeader('set-cookie', '__Host-usrp_session=s1; Secure; HttpOnly; Path=/; SameSite=Strict');
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise((done) => upstream.listen(upstreamPort, '127.0.0.1', done));
  const proxy = spawn(process.execPath, [PROXY, '--cert', c.cert, '--key', c.key, '--ca', c.ca, `127.0.0.1:${port}=${upstreamPort}`]);
  t.after(() => { proxy.kill(); upstream.close(); });
  await new Promise((done, fail) => {
    let out = '';
    proxy.stdout.on('data', (d) => { out += d; if (out.includes('tls-proxy ready')) done(); });
    proxy.on('exit', (code) => fail(new Error(`tls-proxy exited ${code}`)));
  });
  return { port, upstream };
}

test('the CA is made once, private, and name-constrained to private addresses', (t) => {
  const c = certs(t);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout.trim(), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'prints the CA fingerprint');
  assert.equal(statSync(join(c.dir, 'ca/ca.key')).mode & 0o077, 0);
  const text = spawnSync('openssl', ['x509', '-in', c.ca, '-noout', '-text'], { encoding: 'utf8' }).stdout;
  assert.match(text, /Name Constraints: critical/);
  for (const range of ['10.0.0.0/255.0.0.0', '172.16.0.0/255.240.0.0', '192.168.0.0/255.255.0.0', '127.0.0.0/255.0.0.0']) {
    assert.ok(text.includes(`IP:${range}`), range);
  }
  const again = spawnSync('bash', [CERTS, join(c.dir, 'ca'), join(c.dir, 'out'), '127.0.0.1'], { encoding: 'utf8' });
  assert.equal(again.stdout, c.stdout, 'the CA is reused, not replaced');
});

test('the server certificate names the LAN address and is reissued when the address changes', (t) => {
  const c = certs(t, '192.168.1.20');
  assert.equal(c.status, 0, c.stderr);
  const san = () => spawnSync('openssl', ['x509', '-in', c.cert, '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' }).stdout;
  assert.match(san(), /IP Address:192\.168\.1\.20, IP Address:127\.0\.0\.1, DNS:localhost/);
  assert.equal(spawnSync('bash', [CERTS, join(c.dir, 'ca'), join(c.dir, 'out'), '10.4.0.9']).status, 0);
  assert.match(san(), /IP Address:10\.4\.0\.9/);
});

test('the CA cannot vouch for a public address', (t) => {
  const c = certs(t, '8.8.8.8');
  assert.equal(c.status, 1);
  assert.match(c.stderr, /does not verify/);
});

test('HTTPS is forwarded to the app with its method, body, Origin and cookies intact', async (t) => {
  const c = certs(t);
  const { port } = await front(t, c);
  const ca = readFileSync(c.ca);
  const res = await request(`https://127.0.0.1:${port}/edge/v1/auth/officer/login?x=1`, {
    ca, method: 'POST', body: '{"a":1}',
    headers: { 'content-type': 'application/json', origin: `https://127.0.0.1:${port}`, cookie: '__Host-usrp_csrf=c1' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['set-cookie'][0], '__Host-usrp_session=s1; Secure; HttpOnly; Path=/; SameSite=Strict');
  const seen = JSON.parse(res.text);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/edge/v1/auth/officer/login?x=1');
  assert.equal(seen.body, '{"a":1}');
  assert.equal(seen.headers.origin, `https://127.0.0.1:${port}`);
  assert.equal(seen.headers.cookie, '__Host-usrp_csrf=c1');
  assert.equal(seen.headers['x-forwarded-proto'], 'https');
  assert.equal(seen.headers['x-forwarded-host'], `127.0.0.1:${port}`);
  assert.match(seen.headers.host, /^localhost:\d+$/);
});

test('a client that does not trust the sandbox CA is refused', async (t) => {
  const c = certs(t);
  const { port } = await front(t, c);
  await assert.rejects(request(`https://127.0.0.1:${port}/`), /self-signed certificate in certificate chain/);
});

test('plain HTTP on the same port serves only the CA certificate and redirects everything else to https', async (t) => {
  const c = certs(t);
  const { port } = await front(t, c);
  const caPem = await request(`http://127.0.0.1:${port}/usrp-sandbox-ca.crt`);
  assert.equal(caPem.status, 200);
  assert.equal(caPem.text, readFileSync(c.ca, 'utf8'));
  const redirect = await request(`http://127.0.0.1:${port}/apply?step=2`);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `https://127.0.0.1:${port}/apply?step=2`);
  assert.equal(redirect.headers['set-cookie'], undefined);
});

test('an app that is down is a 502 that names it', async (t) => {
  const c = certs(t);
  const { port, upstream } = await front(t, c);
  await new Promise((done) => upstream.close(done));
  const res = await request(`https://127.0.0.1:${port}/`, { ca: readFileSync(c.ca) });
  assert.equal(res.status, 502);
  assert.match(res.text, /is not answering/);
});

#!/usr/bin/env node
// tls-proxy.mjs — the sandbox's HTTPS front for the three apps on the LAN (full.sh --lan).
//
//   node tls-proxy.mjs --cert leaf.crt --key leaf.key --ca ca.crt <address>:<port>=<upstream-port> ...
//
// Each mapping listens on <address>:<port> and forwards to the app's own `vite preview` on
// localhost:<upstream-port>, which stays on loopback; the preview in turn proxies /edge to the edge, which
// stays on loopback too. So a phone or tablet reaches exactly three things, each over TLS: the apps.
//
// One port speaks both protocols. A connection whose first byte is a TLS handshake (0x16) is TLS; anything
// else is plain HTTP and gets either the sandbox CA certificate (GET /usrp-sandbox-ca.crt: public, so a
// device can fetch it before it trusts anything; compare the fingerprint full.sh prints) or a 308 to the
// same URL over https. No HTTP response ever carries an app page or a cookie.
//
// Zero dependencies (node:* only): it must run from a fresh checkout before any install.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const CA_PATH = '/usrp-sandbox-ca.crt';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function parseArgs(argv) {
  const opts = { mappings: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cert' || a === '--key' || a === '--ca') opts[a.slice(2)] = argv[++i];
    else {
      const m = /^(.+):(\d+)=(\d+)$/.exec(a);
      if (!m) throw new Error(`bad mapping "${a}" (want <address>:<port>=<upstream-port>)`);
      opts.mappings.push({ address: m[1], port: Number(m[2]), upstream: Number(m[3]) });
    }
  }
  if (!opts.cert || !opts.key || !opts.ca || opts.mappings.length === 0) {
    throw new Error('usage: tls-proxy.mjs --cert <file> --key <file> --ca <file> <address>:<port>=<upstream-port> ...');
  }
  return opts;
}

/** Forward one request to the app's preview on loopback, streaming both bodies. */
function forward(upstreamPort, req, res) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
  const publicHost = req.headers.host ?? '';
  // The preview is addressed as what it is (localhost); the browser's own Host, scheme and address travel
  // as X-Forwarded-*. Origin and Cookie pass unchanged: the edge sees the request the browser made.
  headers.host = `localhost:${String(upstreamPort)}`;
  headers['x-forwarded-host'] = publicHost;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
  const upstream = http.request(
    { host: 'localhost', port: upstreamPort, method: req.method, path: req.url, headers },
    (up) => {
      const out = {};
      for (const [name, value] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`the app behind this address (localhost:${String(upstreamPort)}) is not answering: ${err.code ?? err.message}\n`);
  });
  req.pipe(upstream);
}

function plainHttp(caPem) {
  return http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === CA_PATH) {
      // iOS and Windows need the certificate type to offer the install. Android (11+) is the opposite:
      // Chrome hands that type to the system, which refuses CA certificates outside Settings and saves
      // NOTHING to Downloads. Android gets a plain download, installed from Settings > Install a certificate.
      const android = /Android/i.test(req.headers['user-agent'] ?? '');
      res.writeHead(200, {
        'content-type': android ? 'application/octet-stream' : 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="usrp-sandbox-ca.crt"',
        'cache-control': 'no-store',
      });
      res.end(caPem);
      return;
    }
    const host = req.headers.host ?? '';
    if (host === '') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('this port serves HTTPS\n');
      return;
    }
    res.writeHead(308, { location: `https://${host}${req.url ?? '/'}`, 'cache-control': 'no-store' });
    res.end();
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cert = readFileSync(opts.cert);
  const key = readFileSync(opts.key);
  const caPem = readFileSync(opts.ca);
  // The chain the client is given: the leaf, then the CA, so a device that trusts the CA can verify it.
  const tlsOptions = { cert: Buffer.concat([cert, Buffer.from('\n'), caPem]), key, minVersion: 'TLSv1.2' };
  let pending = opts.mappings.length;
  for (const { address, port, upstream } of opts.mappings) {
    const secure = https.createServer(tlsOptions, (req, res) => forward(upstream, req, res));
    const insecure = plainHttp(caPem);
    for (const s of [secure, insecure]) s.on('clientError', (_err, socket) => socket.destroy());
    const front = net.createServer((socket) => {
      socket.on('error', () => socket.destroy());
      socket.once('data', (chunk) => {
        // Hand the connection over with its first bytes put back, as if it had arrived at that server.
        socket.pause();
        socket.unshift(chunk);
        (chunk[0] === 0x16 ? secure : insecure).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    front.on('error', (err) => {
      console.error(`✗ cannot listen on ${address}:${String(port)}: ${err.code ?? err.message}`);
      process.exit(1);
    });
    front.listen(port, address, () => {
      console.log(`https://${address}:${String(port)} -> http://localhost:${String(upstream)}`);
      if (--pending === 0) console.log('tls-proxy ready');
    });
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(2);
}

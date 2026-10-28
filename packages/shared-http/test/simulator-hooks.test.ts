// The three additive hooks the G2G simulators use (ADR-047 §3.2): a header on
// every response, a fallback dispatcher, and a verbatim body.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHttpServer } from '../src/index.js';

test('responseHeaders ride on routes, reserved routes, fallbacks and 404s', async () => {
  const server = await startHttpServer({
    serviceName: 'hooks',
    port: 0,
    host: '127.0.0.1',
    handleSignals: false,
    logger: () => undefined,
    responseHeaders: { 'x-usrp-sandbox': '1' },
    routes: [{ method: 'GET', path: '/exact', handler: () => ({ status: 200, body: { ok: true } }) }],
    fallback: (ctx) =>
      ctx.path.startsWith('/pattern/')
        ? { status: 200, rawBody: '{"truncat', headers: { 'content-type': 'application/json' } }
        : null,
  });
  try {
    for (const path of ['/exact', '/health', '/pattern/x', '/nowhere']) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.headers.get('x-usrp-sandbox'), '1', path);
      await response.arrayBuffer();
    }
    const raw = await fetch(`${server.url}/pattern/abc`);
    assert.equal(await raw.text(), '{"truncat');
    assert.equal((await fetch(`${server.url}/nowhere`)).status, 404);
  } finally {
    await server.stop();
  }
});

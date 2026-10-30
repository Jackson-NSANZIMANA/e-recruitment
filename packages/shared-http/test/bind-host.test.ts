// ══════════════════════════════════════════════════════════════════
// ADR-025/evaluation D9 — where a service LISTENS, decided in one place
//
// The defect was not that `startHttpServer` lacked a `host` option (it had one);
// it was that no service passed it and no environment could reach it, so every
// process listened on 0.0.0.0 forever. These tests pin the three things that make
// the fix real:
//   1. the resolution rules (default, accepted forms, refusal);
//   2. the transport actually CONSults them at boot — a bogus value stops the
//      process instead of quietly exposing it on every interface;
//   3. a caller that passes `host` still wins, so the option stays honest.
// ══════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BIND_HOST_ENV,
  DEFAULT_BIND_HOST,
  isLoopbackHost,
  resolveBindHost,
  startHttpServer,
} from '../src/index.js';

const source = (value: string | undefined): Record<string, string | undefined> =>
  value === undefined ? {} : { [BIND_HOST_ENV]: value };

test('bind host: unset (or blank) means every interface, which is what a container needs', () => {
  assert.equal(resolveBindHost({ source: source(undefined) }), DEFAULT_BIND_HOST);
  assert.equal(resolveBindHost({ source: source('   ') }), DEFAULT_BIND_HOST);
  assert.equal(DEFAULT_BIND_HOST, '0.0.0.0');
});

test('bind host: the four wildcard/loopback forms and an explicit IPv4 literal are accepted', () => {
  for (const accepted of ['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost', '10.4.2.9']) {
    assert.equal(resolveBindHost({ source: source(accepted) }), accepted);
  }
  // Surrounding whitespace from a .env line must not become a malformed host.
  assert.equal(resolveBindHost({ source: source(' 127.0.0.1 ') }), '127.0.0.1');
});

test('bind host: a hostname or a mistyped address refuses to boot instead of falling back', () => {
  for (const refused of ['example.com', '999.1.1.1', '127.0.0.1.nip.io', '0.0.0.0/0', 'all']) {
    assert.throws(() => resolveBindHost({ source: source(refused) }), new RegExp(BIND_HOST_ENV), refused);
  }
});

test('bind host: loopback is recognised for the values a launcher sets', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('10.4.2.9'), false);
});

test('the transport reads the variable at boot: loopback in, loopback served', async () => {
  const before = process.env[BIND_HOST_ENV];
  process.env[BIND_HOST_ENV] = '127.0.0.1';
  const server = await startHttpServer({
    serviceName: 'bind-probe',
    port: 0,
    handleSignals: false,
    routes: [],
    logger: () => undefined,
  });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, server.url);
    const res = await fetch(`${server.url}/version`);
    assert.equal(res.status, 200);
  } finally {
    await server.stop();
    if (before === undefined) delete process.env[BIND_HOST_ENV];
    else process.env[BIND_HOST_ENV] = before;
  }
});

test('the transport refuses to boot on an unrecognised value rather than exposing every interface', async () => {
  const before = process.env[BIND_HOST_ENV];
  process.env[BIND_HOST_ENV] = 'everywhere';
  try {
    await assert.rejects(
      startHttpServer({ serviceName: 'bind-probe', port: 0, handleSignals: false, routes: [], logger: () => undefined }),
      /everywhere|USRP_HTTP_BIND_HOST/,
    );
  } finally {
    if (before === undefined) delete process.env[BIND_HOST_ENV];
    else process.env[BIND_HOST_ENV] = before;
  }
});

test('an explicit host option still wins over the environment', async () => {
  const before = process.env[BIND_HOST_ENV];
  process.env[BIND_HOST_ENV] = 'everywhere'; // would refuse on its own
  const server = await startHttpServer({
    serviceName: 'bind-probe',
    port: 0,
    host: '127.0.0.1',
    handleSignals: false,
    routes: [],
    logger: () => undefined,
  });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await server.stop();
    if (before === undefined) delete process.env[BIND_HOST_ENV];
    else process.env[BIND_HOST_ENV] = before;
  }
});

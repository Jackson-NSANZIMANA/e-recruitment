// ADR-038: GET /version reports validated build facts on every service.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHttpServer, versionBody } from '../src/index.js';

const SHA = '3dfb6dd0e1b7c2a4f5e6d7c8b9a0f1e2d3c4b5a6';

test('versionBody reports well-formed build facts', () => {
  const body = versionBody('svc', { USRP_BUILD_SHA: SHA, USRP_BUILD_REF: 'refs/tags/v0.1.0-rc1', USRP_BUILD_TIME: '2026-10-18T10:00:00Z' }, undefined);
  assert.deepEqual(body, { service: 'svc', build: { sha: SHA, ref: 'refs/tags/v0.1.0-rc1', time: '2026-10-18T10:00:00Z' } });
});

test('versionBody never echoes malformed environment values', () => {
  const body = versionBody('svc', { USRP_BUILD_SHA: '<script>alert(1)</script>', USRP_BUILD_REF: 'a b', USRP_BUILD_TIME: 'yesterday' }, undefined);
  assert.deepEqual(body.build, { sha: 'unknown', ref: 'unknown', time: 'unknown' });
  assert.deepEqual(versionBody('svc', {}, undefined).build, { sha: 'unknown', ref: 'unknown', time: 'unknown' });
});

test('versionBody keeps well-formed fingerprints and drops the rest', () => {
  const body = versionBody('edge', {}, {
    contract: { operations: 47, sha256: 'ab'.repeat(32), 'bad key': 'x', note: 'has spaces' },
    policy: { junk: 1.5 },
  });
  assert.deepEqual(body.contract, { operations: 47, sha256: 'ab'.repeat(32) });
  assert.equal(body.policy, undefined);
});

test('GET /version is served by the transport, ahead of the route table', async () => {
  const before = process.env['USRP_BUILD_SHA'];
  process.env['USRP_BUILD_SHA'] = SHA;
  const server = await startHttpServer({
    serviceName: 'probe',
    port: 0,
    host: '127.0.0.1',
    handleSignals: false,
    routes: [],
    version: { contract: { operations: 1 } },
    logger: () => undefined,
  });
  try {
    const res = await fetch(`${server.url}/version`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as { service: string; build: { sha: string }; contract: unknown };
    assert.equal(body.service, 'probe');
    assert.equal(body.build.sha, SHA);
    assert.deepEqual(body.contract, { operations: 1 });
    const post = await fetch(`${server.url}/version`, { method: 'POST' });
    assert.equal(post.status, 404);
  } finally {
    await server.stop();
    if (before === undefined) delete process.env['USRP_BUILD_SHA'];
    else process.env['USRP_BUILD_SHA'] = before;
  }
});

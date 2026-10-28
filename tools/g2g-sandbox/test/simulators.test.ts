import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContract } from '../src/contracts.js';
import { NIDA_IDENTITY_PATH } from '../src/modules/nida-irembo.js';
import { SDMS_RESULTS_PATH } from '../src/modules/nesa-sdms.js';
import { IREMBO_CERTIFICATE_PATH } from '../src/modules/irembo-certificates.js';
import { captureLog, population, startSandbox, TOKEN } from './helpers.js';

const nida = (base: string, nid: string, extra: Record<string, string> = {}) =>
  fetch(`${base}${NIDA_IDENTITY_PATH}`, { headers: { authorization: `Bearer ${TOKEN}`, 'x-usrp-subject': nid, ...extra } });
const nesa = (base: string, index: string, extra: Record<string, string> = {}) =>
  fetch(`${base}${SDMS_RESULTS_PATH}?indexNumber=${encodeURIComponent(index)}`, { headers: extra });

test('every NIDA and SDMS answer validates against its captured contract', async () => {
  const pop = population(40);
  const { server } = await startSandbox({ pop });
  try {
    for (const c of pop.citizens) {
      if (Object.keys(c.behaviour).length > 0) continue;
      const r = await nida(server.url, c.nid);
      assert.equal(r.status, 200, c.key);
      assert.equal(r.headers.get('x-usrp-sandbox'), '1');
      const body = await r.json();
      assert.deepEqual(validateContract('irembo-user-profile-with-identity-info', body), [], c.key);
      if (c.nesa !== null) {
        const n = await nesa(server.url, c.nesa.studentIndexNumber);
        assert.equal(n.status, 200, c.key);
        assert.deepEqual(validateContract('sdms-results-by-index', await n.json()), [], c.key);
      }
    }
  } finally {
    await server.stop();
  }
});

test('the contract validator is not vacuous: a reshaped body is red', () => {
  const pop = population(1);
  const record = pop.persona('L-01').nesa;
  assert.deepEqual(validateContract('sdms-results-by-index', record), []);
  assert.ok(validateContract('sdms-results-by-index', { ...record, extra: 1 }).length > 0);
  assert.ok(validateContract('sdms-results-by-index', { ...record, studentNationalIdHint: '12345678' }).length > 0);
  const { rawMark: _drop, ...missing } = record ?? {};
  assert.ok(validateContract('sdms-results-by-index', missing).length > 0);
});

test('NIDA: credential, subject and not-found semantics', async () => {
  const { server, pop } = await startSandbox();
  try {
    const noToken = await fetch(`${server.url}${NIDA_IDENTITY_PATH}`, { headers: { 'x-usrp-subject': pop.persona('L-01').nid } });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.headers.get('x-usrp-sandbox'), '1');
    assert.equal(((await noToken.json()) as { status: boolean }).status, false);
    assert.equal((await nida(server.url, 'abc')).status, 400);
    const missing = await nida(server.url, '1200389999999000');
    assert.equal(missing.status, 200);
    const miss = (await missing.json()) as { status: boolean; responseCode: string; data: unknown };
    assert.deepEqual([miss.status, miss.responseCode, miss.data], [false, 'USER_PROFILE_NOT_FOUND', null]);
    assert.equal((await nesa(server.url, '990000ZZZ0002020')).status, 404);
    assert.equal((await fetch(`${server.url}${SDMS_RESULTS_PATH}`)).status, 400);
  } finally {
    await server.stop();
  }
});

test('behaviours: persona defaults and per-request override', async () => {
  const { server, pop } = await startSandbox();
  try {
    const limited = await nida(server.url, pop.persona('P-NIDA-429').nid);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '30');
    const maintenance = await nida(server.url, pop.persona('P-NIDA-503').nid);
    assert.equal(maintenance.status, 503);
    assert.equal(maintenance.headers.get('retry-after'), '300');
    const statusFalse = await nida(server.url, pop.persona('P-NIDA-STATUS-FALSE').nid);
    assert.equal(statusFalse.status, 200);
    assert.equal(((await statusFalse.json()) as { status: boolean }).status, false);
    const truncated = await nesa(server.url, pop.persona('P-NESA-TRUNCATED').nesa?.studentIndexNumber ?? '');
    assert.equal(truncated.status, 200);
    await assert.rejects(truncated.json());
    const timeout = await nesa(server.url, pop.persona('P-NESA-TIMEOUT').nesa?.studentIndexNumber ?? '');
    assert.equal(timeout.status, 504);
    // Per-request: one header can put a normal persona in maintenance, per authority.
    const l01 = pop.persona('L-01');
    assert.equal((await nida(server.url, l01.nid, { 'x-usrp-sandbox-behaviour': 'maintenance' })).status, 503);
    assert.equal((await nida(server.url, l01.nid, { 'x-usrp-sandbox-behaviour': 'nesa=maintenance' })).status, 200);
    assert.equal((await nesa(server.url, l01.nesa?.studentIndexNumber ?? '', { 'x-usrp-sandbox-behaviour': 'nesa=rate-limited' })).status, 429);
    assert.equal((await nida(server.url, l01.nid, { 'x-usrp-sandbox-behaviour': 'bogus' })).status, 200);
  } finally {
    await server.stop();
  }
});

test('the per-client token bucket answers 429, never a negative verdict', async () => {
  const { server, pop } = await startSandbox({ realBudgets: true });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 45; i += 1) statuses.push((await nida(server.url, pop.persona('L-01').nid)).status);
    assert.ok(statuses.includes(429), 'the burst is cut off');
    assert.ok(statuses.every((s) => s === 200 || s === 429));
  } finally {
    await server.stop();
  }
});

test('unauthenticated mounts are refused in their own style; unknown paths 404; all stamped', async () => {
  const { server } = await startSandbox();
  try {
    const cert = await fetch(`${server.url}${IREMBO_CERTIFICATE_PATH}`);
    assert.equal(cert.status, 401);
    const sms = await fetch(`${server.url}/2010-04-01/Accounts/AC123/Messages.json`, { method: 'POST' });
    assert.equal(sms.status, 401);
    const none = await fetch(`${server.url}/nowhere`);
    assert.equal(none.status, 404);
    for (const r of [cert, sms, none, await fetch(`${server.url}/health`)]) assert.equal(r.headers.get('x-usrp-sandbox'), '1');
  } finally {
    await server.stop();
  }
});

test('logs carry persona ids and statuses, never NIDs, names or index numbers', async () => {
  const capture = captureLog();
  const { server, pop } = await startSandbox({ log: capture.log });
  try {
    const c = pop.persona('L-01');
    await nida(server.url, c.nid);
    await nesa(server.url, c.nesa?.studentIndexNumber ?? '');
    const all = capture.lines.join('\n');
    assert.ok(all.includes('L-01'));
    for (const secret of [c.nid, c.surname, c.nesa?.studentIndexNumber ?? 'x']) assert.equal(all.includes(secret), false);
  } finally {
    await server.stop();
  }
});

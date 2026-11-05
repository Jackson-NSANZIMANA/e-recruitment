import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveIremboCertificates, LIVE_IREMBO_PATH } from '../src/live-irembo-certificates.js';
import { APPLICATION_NUMBER_HEADER, IREMBO_CERTIFICATE_PATH } from '../src/modules/irembo-certificates.js';
import { captureLog, startSandbox, TOKEN } from './helpers.js';

/** A real certificate number shape no synthetic citizen holds. */
const REAL = 'B230523161645TCMO';

/** The shape IremboGov answered for an EXPIRED clearance (STATUS false, holder withheld). */
const EXPIRED = { status: true, data: { STATUS: false, APPLICATION_CODE: 'NEW_CRIMINAL_RECORD_CLEARANCE_CERTIFICATE' }, responseCode: '3104', message: 'Dosiye yabonetse', responseEncrypted: false, traceId: 'b61c8eb51565141a' };

function upstream(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ask = (base: string, number: string) =>
  fetch(`${base}${IREMBO_CERTIFICATE_PATH}`, { headers: { [APPLICATION_NUMBER_HEADER]: number, authorization: `Bearer ${TOKEN}` } });

test('an unknown number is asked of IremboGov with the public endpoint headers, and its answer passes through', async () => {
  const up = upstream(EXPIRED);
  const { log, lines } = captureLog();
  const liveCertificates = createLiveIremboCertificates({ log, fetchImpl: up.fetchImpl, baseUrl: 'https://irembo.example' });
  const { server } = await startSandbox({ liveCertificates });
  try {
    const r = await ask(server.url, REAL);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), EXPIRED);
    assert.equal(up.calls.length, 1);
    assert.equal(up.calls[0]?.url, `https://irembo.example${LIVE_IREMBO_PATH}`);
    assert.equal(up.calls[0]?.headers['applicationnumber'], REAL);
    assert.equal(up.calls[0]?.headers['x-current-user-role'], 'ROLE_CITIZEN');
    // No citizen bearer and no USRP token ever leaves for the real registry.
    assert.equal(up.calls[0]?.headers['authorization'], undefined);
    // The number itself is never logged.
    assert.ok(!lines.join('\n').includes(REAL));
    assert.ok(lines.some((l) => l.includes('live_irembo_answered') && l.includes('responseCode 3104')));
  } finally {
    await server.stop();
  }
});

test('a synthetic certificate is still answered by the simulator, never upstream', async () => {
  const up = upstream(EXPIRED);
  const liveCertificates = createLiveIremboCertificates({ log: captureLog().log, fetchImpl: up.fetchImpl });
  const { server, pop } = await startSandbox({ liveCertificates });
  try {
    const cert = pop.persona('P-CLEARANCE-VALID').certificates[0];
    assert.ok(cert !== undefined);
    const r = await ask(server.url, cert.applicationNumber);
    assert.equal(r.status, 200);
    assert.equal(up.calls.length, 0);
  } finally {
    await server.stop();
  }
});

test('a found answer that drifts from the captured contract is a 502, not a certificate', async () => {
  const drifted = { ...EXPIRED, data: { STATUS: true, APPLICATION_CODE: 'X', NAME: 'n' } };
  const liveCertificates = createLiveIremboCertificates({ log: captureLog().log, fetchImpl: upstream(drifted).fetchImpl });
  const { server } = await startSandbox({ liveCertificates });
  try {
    assert.equal((await ask(server.url, REAL)).status, 502);
  } finally {
    await server.stop();
  }
});

test('an upstream outage is a 503, and the passthrough is rate-limited but replays a recent answer', async () => {
  let now = 1_000_000;
  const down = createLiveIremboCertificates({ log: captureLog().log, fetchImpl: upstream({}, 500).fetchImpl, clock: () => now });
  assert.equal((await down.fetch(REAL)).kind, 'UNAVAILABLE');

  const up = upstream(EXPIRED);
  const live = createLiveIremboCertificates({ log: captureLog().log, fetchImpl: up.fetchImpl, clock: () => now });
  assert.equal((await live.fetch(REAL)).kind, 'OK');
  assert.equal((await live.fetch(REAL)).kind, 'OK');
  assert.equal(up.calls.length, 1, 'the same number within a minute is replayed');
  assert.equal((await live.fetch('C230523161645TCMO')).kind, 'THROTTLED');
  now += 2_000;
  assert.equal((await live.fetch('C230523161645TCMO')).kind, 'OK');
  assert.equal(up.calls.length, 2);
});

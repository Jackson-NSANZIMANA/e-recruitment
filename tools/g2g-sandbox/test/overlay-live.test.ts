import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadPrivatePersona, loadPrivatePersonas, nidHintOf, PrivatePersonaRefused } from '../src/overlay.js';
import { createLiveNesa } from '../src/live-nesa.js';
import { redact } from '../src/log.js';
import { NIDA_IDENTITY_PATH } from '../src/modules/nida-irembo.js';
import { SDMS_RESULTS_PATH } from '../src/modules/nesa-sdms.js';
import { captureLog, population, startSandbox, syntheticOverlayDir, TOKEN } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_NID = '1200389990999000';

test('overlay: refuses any path inside a git work tree, and a missing directory', () => {
  assert.throws(() => loadPrivatePersona(resolve(HERE, '..')), PrivatePersonaRefused);
  assert.throws(() => loadPrivatePersona('/definitely/not/here'), PrivatePersonaRefused);
  assert.equal(loadPrivatePersona(undefined), null);
  assert.equal(loadPrivatePersona('  '), null);
});

test('overlay: recognised by shape; answered by the simulators; labelled PRIVATE in logs', async () => {
  const persona = loadPrivatePersona(syntheticOverlayDir(OVERLAY_NID, '990000ABC0012025'));
  assert.ok(persona !== null);
  assert.equal(persona.nid, OVERLAY_NID);
  const capture = captureLog();
  const { server } = await startSandbox({ overlay: persona, log: capture.log, host: '0.0.0.0' });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:/);
    const r = await fetch(`${server.url}${NIDA_IDENTITY_PATH}`, { headers: { authorization: `Bearer ${TOKEN}`, 'x-usrp-subject': OVERLAY_NID } });
    const body = (await r.json()) as { data: { identityInfo: { surname: string } } };
    assert.equal(body.data.identityInfo.surname, 'OVERLAY');
    const n = await fetch(`${server.url}${SDMS_RESULTS_PATH}?indexNumber=990000ABC0012025`);
    assert.equal(n.status, 200);
    const all = capture.lines.join('\n');
    assert.ok(all.includes('PRIVATE'));
    assert.equal(all.includes(OVERLAY_NID), false);
    assert.equal(all.includes('OVERLAY'), false);
  } finally {
    await server.stop();
  }
});

test('live NESA: one upstream call per minute, cache replay, drift detected', async () => {
  const record = population(1).persona('L-01').nesa;
  let calls = 0;
  let now = 0;
  let body: unknown = record;
  const live = createLiveNesa({
    index: 'LIVEINDEX01',
    log: captureLog().log,
    clock: () => now,
    fetchImpl: (async () => { calls += 1; return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch,
  });
  assert.equal(live.appliesTo('OTHER'), false);
  assert.equal((await live.fetch('LIVEINDEX01')).kind, 'OK');
  assert.equal((await live.fetch('LIVEINDEX01')).kind, 'OK'); // replayed, no new call
  assert.equal(calls, 1);
  now += 61_000;
  body = { ...record, unexpected: true };
  const drift = await live.fetch('LIVEINDEX01');
  assert.equal(drift.kind, 'DRIFT');
  assert.equal(calls, 2);
  // Throttled with nothing good to replay:
  const cold = createLiveNesa({ index: 'X1234567', log: captureLog().log, clock: () => 0, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch });
  assert.equal((await cold.fetch('X1234567')).kind, 'UNAVAILABLE');
  assert.equal((await cold.fetch('X1234567')).kind, 'THROTTLED');
});

test('logger redaction keeps the subject COUNT the boot line reports, never a subject', () => {
  assert.deepEqual(redact({ subjects: 2, overlay: true, nid: '1200389990001000' }), { subjects: 2, overlay: true });
});

test('logger redaction is an allowlist', () => {
  assert.deepEqual(redact({ module: 'nida-irembo', nid: '1200389990001000', name: 'X', status: 200, persona: '1200389990001000' }), { module: 'nida-irembo', status: 200 });
});

test('overlay: a subject with no consent record is refused, by count not by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usrp-overlay-consent-'));
  const nid = '1200389990777000';
  writeFileSync(join(dir, 'identity.json'), JSON.stringify({ data: { userProfileDto: { identificationNumber: nid }, identityInfo: { surname: 'OVERLAY' } } }));

  // No consent.json at all.
  assert.throws(() => loadPrivatePersonas(dir), (e: unknown) => {
    assert.ok(e instanceof PrivatePersonaRefused);
    assert.match(e.message, /consent\.json/);
    assert.doesNotMatch(e.message, new RegExp(nid), 'a refusal must never print a real NID');
    return true;
  });

  // Present, but covering somebody else.
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ subjects: [{ nid: '1200389990111000', basis: 'someone else', recordedOn: '2026-01-01' }] }));
  assert.throws(() => loadPrivatePersonas(dir), (e: unknown) => {
    assert.ok(e instanceof PrivatePersonaRefused);
    assert.doesNotMatch(e.message, new RegExp(nid), 'a refusal must never print a real NID');
    return true;
  });

  // A basis is required, not just a listing.
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ subjects: [{ nid, basis: '   ', recordedOn: '2026-01-01' }] }));
  assert.throws(() => loadPrivatePersonas(dir), PrivatePersonaRefused);

  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ subjects: [{ nid, basis: 'test subject', recordedOn: '2026-01-01' }] }));
  assert.equal(loadPrivatePersonas(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('overlay: several subjects, each paired to its own results by the NID hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usrp-overlay-many-'));
  const a = '1200389990111000';
  const b = '1200779990222000';
  for (const [nid, file] of [[a, 'a.json'], [b, 'b.json']] as const) {
    writeFileSync(join(dir, file), JSON.stringify({ data: { userProfileDto: { identificationNumber: nid }, identityInfo: { surname: 'OVERLAY', documentNumber: nid } } }));
  }
  // Deliberately named so that filename order does NOT match subject order.
  writeFileSync(join(dir, 'z-results.json'), JSON.stringify({ studentIndexNumber: 'IDX-B', studentNationalIdHint: nidHintOf(b), rawMark: [] }));
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ subjects: [
    { nid: a, basis: 'test subject', recordedOn: '2026-01-01' },
    { nid: b, basis: 'test subject', recordedOn: '2026-01-01' },
  ] }));

  const people = loadPrivatePersonas(dir);
  assert.equal(people.length, 2);
  const byNid = new Map(people.map((p) => [p.nid, p]));
  assert.equal(byNid.get(a)?.nesa, null, 'an unhinted subject gets no results when several exist');
  assert.equal(byNid.get(b)?.nesa?.['studentIndexNumber'], 'IDX-B');
  rmSync(dir, { recursive: true, force: true });
});

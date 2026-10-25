import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGE_CRITERIA, CRIMINAL_THRESHOLD_BY_CATEGORY, REQUIRED_DOCUMENTS } from '@usrp/shared-types';
import { kigaliDate, kigaliInstant, kigaliStamp, shortDay } from '../src/clock.js';
import { classify } from '../src/conductor.js';
import { assertRehearsalAllowed, RehearsalRefused } from '../src/fence.js';
import { deterministicKey } from '../src/idempotency.js';
import { MEDICAL_MODE_BY_AGENCY, syntheticPolicy, SYNTHETIC_LEGAL_BASIS_CODE } from '../src/policy.js';
import { isRehearsalCode, rehearsalCode, ScenarioInvalid, stageCampaigns, validateScenario, type Scenario } from '../src/scenario.js';
import { assertGasaboRoster, RosterAssertion } from '../src/roster.js';
import { nextStaffAction, samePosts } from '../src/staff.js';

const scenario = JSON.parse(readFileSync(new URL('../scenarios/national-pilot-day.json', import.meta.url), 'utf8')) as Scenario;
// 23:30 UTC on 15 Oct is already 16 Oct in Kigali (UTC+2).
const NOW = new Date('2026-10-15T23:30:00.000Z');
const LOCAL = { databaseUrl: 'postgresql://u:p@localhost:5432/db', edgeBaseUrl: 'http://localhost:4021' };

test('fence: refuses production and anything non-local, allows local dev', () => {
  assert.doesNotThrow(() => assertRehearsalAllowed({ nodeEnv: 'development', ...LOCAL }));
  assert.doesNotThrow(() => assertRehearsalAllowed({ nodeEnv: undefined, databaseUrl: 'postgresql://u:p@127.0.0.1/db', edgeBaseUrl: 'http://[::1]:4021' }));
  assert.throws(() => assertRehearsalAllowed({ nodeEnv: 'production', ...LOCAL }), RehearsalRefused);
  assert.throws(() => assertRehearsalAllowed({ nodeEnv: ' Production ', ...LOCAL }), RehearsalRefused);
  assert.throws(() => assertRehearsalAllowed({ nodeEnv: 'development', ...LOCAL, databaseUrl: 'postgresql://u:p@db.gov.rw/usrp' }), RehearsalRefused);
  assert.throws(() => assertRehearsalAllowed({ nodeEnv: 'development', ...LOCAL, edgeBaseUrl: 'https://recruitment.gov.rw' }), RehearsalRefused);
  assert.throws(() => assertRehearsalAllowed({ nodeEnv: 'development', ...LOCAL, databaseUrl: 'not a url' }), RehearsalRefused);
});

test('clock: dates are Kigali dates, not UTC dates', () => {
  assert.equal(kigaliDate(NOW), '2026-10-16');
  assert.equal(kigaliDate(NOW, 14), '2026-10-30');
  assert.equal(kigaliStamp(NOW), '20261016');
  assert.equal(shortDay('2026-10-16'), '16 Oct');
  assert.equal(kigaliInstant(NOW, -1, 'start'), '2026-10-15T00:00:00+02:00');
  assert.equal(kigaliInstant(NOW, 30, 'end'), '2026-11-15T23:59:59+02:00');
});

test('replay: the same day stages byte-identical commands at any hour (the idempotency contract)', () => {
  const morning = stageCampaigns(scenario, new Date('2026-10-16T05:01:00.000Z'));
  const evening = stageCampaigns(scenario, new Date('2026-10-16T21:59:00.000Z'));
  assert.deepEqual(JSON.parse(JSON.stringify(morning)), JSON.parse(JSON.stringify(evening)));
  const tomorrow = stageCampaigns(scenario, new Date('2026-10-16T22:01:00.000Z'));
  assert.notEqual(tomorrow[0]?.draft.publicCode, morning[0]?.draft.publicCode);
});

test('idempotency: keys are UUID-shaped and a pure function of the step', () => {
  const key = deterministicKey('national-pilot-day', 'REH-RDF-20261016', 'draft');
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(key, deterministicKey('national-pilot-day', 'REH-RDF-20261016', 'draft'));
  assert.notEqual(key, deterministicKey('national-pilot-day', 'REH-RDF-20261016', 'policy'));
  assert.notEqual(deterministicKey('a', 'bc'), deterministicKey('ab', 'c'));
});

test('scenario: the shipped scenario is valid and every artefact is marked as a rehearsal', () => {
  validateScenario(scenario);
  const staged = stageCampaigns(scenario, NOW);
  assert.deepEqual(staged.map((s) => s.draft.publicCode), ['REH-RDF-20261016', 'REH-RNP-20261016', 'REH-RCS-20261016']);
  for (const s of staged) {
    assert.ok(isRehearsalCode(s.draft.publicCode));
    assert.ok(s.draft.campaignLabel.startsWith('[REHEARSAL]'));
    assert.ok(s.draft.campaignLabel.length <= 50);
    assert.deepEqual([...s.draft.targetDistricts], s.sessions.map((x) => x.district));
    for (const session of s.sessions) assert.match(session.venueName, /^Rehearsal Venue — /);
  }
  const rdf = staged[0];
  assert.ok(rdf !== undefined);
  assert.equal(rdf.draft.allowsWalkIn, true);
  assert.equal(rdf.draft.examinationStartDate, '2026-10-16', 'RDF examines today, so the gate can be rehearsed today');
  assert.deepEqual(rdf.sessions.map((s) => [s.district, s.province, s.examDate]), [
    ['GASABO', 'KIGALI_CITY', '2026-10-16'],
    ['HUYE', 'SOUTHERN_PROVINCE', '2026-10-16'],
  ]);
  assert.equal(rehearsalCode('RNP', NOW), 'REH-RNP-20261016');
});

test('scenario: rejects what the control plane would refuse', () => {
  const broken = (patch: (s: Scenario) => Scenario): void => {
    assert.throws(() => validateScenario(patch(structuredClone(scenario))), ScenarioInvalid);
  };
  broken((s) => ({ ...s, campaigns: s.campaigns.map((c, i) => (i === 0 ? { ...c, categories: ['BASIC_POLICE_COURSE'] } : c)) }));
  broken((s) => ({ ...s, campaigns: s.campaigns.map((c, i) => (i === 0 ? { ...c, sessions: [...c.sessions, c.sessions[0]!] } : c)) }));
  broken((s) => ({ ...s, campaigns: s.campaigns.map((c, i) => (i === 0 ? { ...c, sessions: [{ ...c.sessions[0]!, examOffsetDays: 99 }] } : c)) }));
  broken((s) => ({ ...s, campaigns: s.campaigns.map((c, i) => (i === 0 ? { ...c, sessions: [{ ...c.sessions[0]!, district: 'ATLANTIS' }] } : c)) }));
  broken((s) => ({ ...s, campaigns: [...s.campaigns, s.campaigns[0]!] }));
  broken((s) => ({ ...s, personas: [{ ...s.personas[0]!, nationalId: '123' }] }));
});

test('policy: states exactly the engine rules, under a synthetic legal basis', () => {
  const policy = syntheticPolicy({
    publicCode: 'REH-RDF-20261016',
    agency: 'RDF',
    categories: ['GENERAL_ENLISTMENT', 'RESERVE_FORCE_UNIVERSITY'],
    referenceDate: '2026-10-16',
    scenarioId: 'national-pilot-day',
    scenarioVersion: 1,
  });
  assert.equal(policy.legalBasisCode, SYNTHETIC_LEGAL_BASIS_CODE);
  assert.match(policy.legalBasisReference, /not a Government of Rwanda policy/);
  const general = policy.policyDocument['GENERAL_ENLISTMENT'];
  assert.ok(general !== undefined);
  assert.equal(general.age.maximumAge, AGE_CRITERIA.GENERAL_ENLISTMENT.maxAge);
  assert.equal(general.criminalThreshold, CRIMINAL_THRESHOLD_BY_CATEGORY.GENERAL_ENLISTMENT);
  assert.deepEqual(general.requiredDocumentTypes, REQUIRED_DOCUMENTS.GENERAL_ENLISTMENT);
  assert.equal(general.education.mode, 'NESA_RESULTS');
  assert.equal(policy.policyDocument['RESERVE_FORCE_UNIVERSITY']?.education.mode, 'HEC_DEGREE');
  assert.equal(general.medicalMode, MEDICAL_MODE_BY_AGENCY.RDF);
  assert.equal(MEDICAL_MODE_BY_AGENCY.RNP, 'CERTIFICATE');
  // The control plane's code token rule: ^[A-Z0-9][A-Z0-9_:-]{0,63}$.
  for (const code of [policy.legalBasisCode, general.criminalThreshold, general.education.mode, general.medicalMode]) {
    assert.match(code, /^[A-Z0-9][A-Z0-9_:-]{0,63}$/);
  }
});

test('conductor: a step is FAILED unless the edge said 2xx, and a replay is named', () => {
  assert.equal(classify('draft', 201, false, { status: 'DRAFT' }).outcome, 'APPLIED');
  assert.equal(classify('draft', 200, true, {}).outcome, 'REPLAYED');
  const conflict = classify('publish', 409, false, { error: 'COVERAGE_INCOMPLETE' });
  assert.equal(conflict.outcome, 'FAILED');
  assert.equal(conflict.detail, 'COVERAGE_INCOMPLETE');
});

test('staff: the plan converges create → (enable | reissue) → assign → none', () => {
  const member = { handle: 'reh.rdf.gate.gasabo', posts: ['screening_officer'] };
  const row = (status: 'active' | 'disabled' | 'pending', posts: string[]) => [{ officerId: 'o-1', loginHandle: member.handle, posts, status }];
  assert.deepEqual(nextStaffAction(member, []), { kind: 'CREATE' });
  assert.deepEqual(nextStaffAction(member, row('disabled', ['screening_officer'])), { kind: 'ENABLE', officerId: 'o-1' });
  assert.deepEqual(nextStaffAction(member, row('pending', ['screening_officer'])), { kind: 'REISSUE', officerId: 'o-1' });
  assert.deepEqual(nextStaffAction(member, row('active', ['reviewer'])), { kind: 'ASSIGN', officerId: 'o-1' });
  assert.deepEqual(nextStaffAction(member, row('active', ['screening_officer'])), { kind: 'NONE', officerId: 'o-1' });
  assert.ok(samePosts(['b', 'a'], ['a', 'b']));
  assert.ok(!samePosts(['a'], ['a', 'b']));
});

test('staff: the shipped scenario staffs every agency with rehearsal-marked handles and assignable posts only', () => {
  const staged = stageCampaigns(scenario, NOW);
  for (const s of staged) {
    assert.ok(s.staff.length > 0, `${s.agency} has staff`);
    for (const m of s.staff) assert.ok(m.handle.startsWith(`reh.${s.agency.toLowerCase()}.`));
  }
  const withAdmin = structuredClone(scenario) as unknown as { campaigns: { staff?: { handle: string; posts: string[] }[] }[] };
  withAdmin.campaigns[0]!.staff = [{ handle: 'reh.rdf.boss', posts: ['agency_admin'] }];
  assert.throws(() => validateScenario(withAdmin as unknown as Scenario), ScenarioInvalid, 'agency_admin is never assignable');
  const unmarked = structuredClone(scenario) as unknown as { campaigns: { staff?: { handle: string; posts: string[] }[] }[] };
  unmarked.campaigns[0]!.staff = [{ handle: 'rdf.gate', posts: ['screening_officer'] }];
  assert.throws(() => validateScenario(unmarked as unknown as Scenario), ScenarioInvalid, 'staff handles are rehearsal-marked');
});

test('roster: minimal rows pass, identifying fields and missing codes fail', () => {
  const row = { processingCode: 'PC-0001', category: 'GENERAL_ENLISTMENT', status: 'SCHEDULED', admission: 'NOT_ADMITTED', requiredPaperItems: [] };
  assert.equal(assertGasaboRoster({ candidates: [row] }, 'PC-0001'), 1);
  assert.equal(assertGasaboRoster({ candidates: [] }, null), 0);
  assert.throws(() => assertGasaboRoster({ candidates: [row] }, 'PC-9999'), RosterAssertion);
  assert.throws(() => assertGasaboRoster({ candidates: [{ ...row, fullName: 'X' }] }, null), RosterAssertion);
  assert.throws(() => assertGasaboRoster({ candidates: [{ ...row, processingCode: '1200389990001000' }] }, null), RosterAssertion);
  assert.throws(() => assertGasaboRoster({ nothing: true }, null), RosterAssertion);
});

// ── ADR-037: the dev-only synthetic evidence signer ─────────────────
import { generateDeviceKeyPair as genKeys, verifyEd25519, canonicalJson as canon } from '@usrp/shared-security';
import { keyIdOf, signEvidenceRecord, syntheticEvidenceRecord, ticketIdOf } from '../src/biometric.js';

test('synthetic evidence: a flat SHADOW record signed over canonicalJson, no biometric data', () => {
  const keys = genKeys();
  const record = syntheticEvidenceRecord({
    recordId: '0b7c3f8e-2a51-4c1d-9e2f-6a7b8c9d0e1f', applicationId: '9a111111-1111-4111-8111-111111111111',
    ticketId: 'T1', deviceId: 'reh-rdf-bio-1', publicKeyPem: keys.publicKeyPem, mode: 'SHADOW', capturedAt: '2026-10-21T07:00:00.000Z',
  });
  assert.equal(Object.keys(record).length, 18);
  assert.ok(Object.values(record).every((v) => v === null || typeof v !== 'object'), 'flat scalars only');
  assert.equal(record['keyId'], keyIdOf(keys.publicKeyPem));
  const sig = signEvidenceRecord(record, keys.privateKeyPem);
  assert.match(sig, /^[A-Za-z0-9+/]{86}==$/);
  assert.equal(verifyEd25519(keys.publicKeyPem, Buffer.from(canon(record), 'utf8'), sig), true);
});

test('ticketIdOf reads the ticket from a USRP-SLOT.v1 token and refuses anything else', () => {
  const payload = Buffer.from(JSON.stringify({ ticketId: 'abc_-123' })).toString('base64url');
  assert.equal(ticketIdOf(`USRP-SLOT.v1.${payload}.sig`), 'abc_-123');
  assert.equal(ticketIdOf('nope'), null);
  assert.equal(ticketIdOf(`OTHER.v1.${payload}.sig`), null);
});

test('scenario: national-pilot-day declares SHADOW for RDF only', async () => {
  const { readFileSync } = await import('node:fs');
  const scenario = JSON.parse(readFileSync(new URL('../scenarios/national-pilot-day.json', import.meta.url), 'utf8')) as { campaigns: { agency: string; biometricMode?: string }[] };
  assert.deepEqual(scenario.campaigns.filter((c) => c.biometricMode !== undefined).map((c) => [c.agency, c.biometricMode]), [['RDF', 'SHADOW']]);
});

import { assertVenueCounts, FleetAssertion } from '../src/fleet.js';

const TRUTH = { expected: 3, admitted: 2, physicalCaptured: 1, medicalRecorded: 1, openConflicts: 0 };
test('venue counts: equal to the engine, with an asOf, passes', () => {
  assertVenueCounts({ counts: TRUTH, asOf: '2026-10-22T08:00:00.000Z' }, TRUTH);
});
test('venue counts: any drift from the engine fails and names the count', () => {
  assert.throws(() => assertVenueCounts({ counts: { ...TRUTH, admitted: 1 }, asOf: '2026-10-22T08:00:00.000Z' }, TRUTH), (e: unknown) => e instanceof FleetAssertion && /admitted/.test((e as Error).message));
});
test('venue counts: a busy venue without asOf fails; an idle one may have asOf null', () => {
  assert.throws(() => assertVenueCounts({ counts: TRUTH, asOf: null }, TRUTH), FleetAssertion);
  const idle = { expected: 0, admitted: 0, physicalCaptured: 0, medicalRecorded: 0, openConflicts: 0 };
  assertVenueCounts({ counts: idle, asOf: null }, idle);
});

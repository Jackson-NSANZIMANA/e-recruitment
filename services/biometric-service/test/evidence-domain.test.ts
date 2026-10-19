import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDeviceKeyPair, signEd25519, verifyEd25519 } from '@usrp/shared-security';
import {
  EVIDENCE_RECORD_KEYS,
  MAX_ANY_STRING,
  checkEvidenceConsistency,
  deviceKeyId,
  evidenceDigest,
  evidenceSigningInput,
  findImagePayload,
  isCapturedAtAcceptable,
  parseEvidenceRecord,
  parseEvidenceRequest,
  type EvidenceRecord,
} from '../src/domain/evidence-record.js';
import {
  EVIDENCE_OUTCOMES,
  THRESHOLD_POLICIES,
  attemptedOutcome,
  thresholdPolicy,
} from '../src/domain/threshold-policy.js';
import { BIOMETRIC_MODES, RECORDING_MODES, isVisibleToOfficers, modeGate } from '../src/domain/biometric-mode.js';
import { FixedReferenceSources } from '../src/adapters/reference-sources.js';

const KEYS = generateDeviceKeyPair();
const SIG = signEd25519(KEYS.privateKeyPem, Buffer.from('x'));

function record(overrides: Partial<Record<keyof EvidenceRecord, unknown>> = {}): Record<string, unknown> {
  return {
    schema: 'USRP-BIO-EVIDENCE.v1',
    recordId: '0b7c3f8e-2a51-4c1d-9e2f-6a7b8c9d0e1f',
    agency: 'RDF',
    applicationId: '9a111111-1111-4111-8111-111111111111',
    ticketId: 'Zx9_-abcDEF0123456789abcdefghijklmnopqrstuv',
    deviceId: 'TAB-RDF-0001',
    keyId: deviceKeyId(KEYS.publicKeyPem),
    referenceSource: 'CARD_PORTRAIT',
    method: 'FACE_1_1_ON_DEVICE',
    consentState: 'GIVEN',
    outcome: 'MATCH',
    notAttemptedReason: null,
    livenessScoreBp: 9_400,
    matchScoreBp: 9_100,
    modelId: 'usrp-face-card',
    modelVersion: '1.0.0',
    thresholdPolicyVersion: 'BIO-THRESHOLDS.v1',
    mode: 'SHADOW',
    capturedAt: '2026-10-19T07:15:00.000Z',
    ...overrides,
  };
}

const declined = (): Record<string, unknown> => record({
  consentState: 'DECLINED', outcome: 'NOT_ATTEMPTED', notAttemptedReason: 'CANDIDATE_DECLINED',
  method: 'NONE', livenessScoreBp: null, matchScoreBp: null, modelId: null, modelVersion: null,
});

function parsed(raw: Record<string, unknown>): EvidenceRecord {
  const r = parseEvidenceRecord(raw);
  assert.ok(r, 'fixture must parse');
  return r;
}

// ── Outcome rules ──────────────────────────────────────────────────

test('outcome rules are total and exact at every boundary of BIO-THRESHOLDS.v1', () => {
  const p = thresholdPolicy('BIO-THRESHOLDS.v1');
  assert.ok(p);
  assert.equal(attemptedOutcome(8_500, 8_500, p), 'MATCH');
  assert.equal(attemptedOutcome(10_000, 10_000, p), 'MATCH');
  assert.equal(attemptedOutcome(8_499, 10_000, p), 'INCONCLUSIVE', 'failed liveness is never a match');
  assert.equal(attemptedOutcome(8_499, 0, p), 'INCONCLUSIVE', 'failed liveness is never a NO_MATCH either');
  assert.equal(attemptedOutcome(8_500, 8_499, p), 'INCONCLUSIVE');
  assert.equal(attemptedOutcome(8_500, 6_000, p), 'INCONCLUSIVE');
  assert.equal(attemptedOutcome(8_500, 5_999, p), 'NO_MATCH');
  assert.equal(attemptedOutcome(9_000, 0, p), 'NO_MATCH');
  for (const bad of [-1, 10_001, 0.5, Number.NaN]) {
    assert.throws(() => attemptedOutcome(bad, 9_000, p), RangeError);
    assert.throws(() => attemptedOutcome(9_000, bad, p), RangeError);
  }
});

test('every grid point maps to exactly one attempted outcome', () => {
  const p = THRESHOLD_POLICIES['BIO-THRESHOLDS.v1'];
  assert.ok(p);
  const seen = new Set<string>();
  for (let l = 0; l <= 10_000; l += 250) {
    for (let m = 0; m <= 10_000; m += 250) {
      const o = attemptedOutcome(l, m, p);
      assert.ok(EVIDENCE_OUTCOMES.includes(o) && o !== 'NOT_ATTEMPTED');
      seen.add(o);
    }
  }
  assert.deepEqual([...seen].sort(), ['INCONCLUSIVE', 'MATCH', 'NO_MATCH']);
});

test('only registered threshold policies exist; prototype keys are not policies', () => {
  assert.equal(thresholdPolicy('BIO-THRESHOLDS.v2'), null);
  assert.equal(thresholdPolicy('toString'), null);
  assert.equal(thresholdPolicy('__proto__'), null);
});

// ── Mode gate ──────────────────────────────────────────────────────

test('mode gate: OFF refuses, mismatch refuses, agreement records; no automatic mode exists', () => {
  assert.deepEqual([...BIOMETRIC_MODES], ['OFF', 'SHADOW', 'ADVISORY']);
  for (const declared of RECORDING_MODES) {
    assert.deepEqual(modeGate('OFF', declared), { kind: 'BIOMETRIC_OFF' });
  }
  assert.deepEqual(modeGate('SHADOW', 'SHADOW'), { kind: 'RECORD', mode: 'SHADOW' });
  assert.deepEqual(modeGate('ADVISORY', 'ADVISORY'), { kind: 'RECORD', mode: 'ADVISORY' });
  assert.deepEqual(modeGate('SHADOW', 'ADVISORY'), { kind: 'MODE_MISMATCH', configuredMode: 'SHADOW' });
  assert.deepEqual(modeGate('ADVISORY', 'SHADOW'), { kind: 'MODE_MISMATCH', configuredMode: 'ADVISORY' });
  assert.equal(isVisibleToOfficers('SHADOW'), false);
  assert.equal(isVisibleToOfficers('ADVISORY'), true);
});

// ── Reference sources ──────────────────────────────────────────────

test('reference sources: card portrait is device-attested, NIDA fails closed, NONE is manual', () => {
  const r = new FixedReferenceSources();
  assert.equal(r.source('CARD_PORTRAIT').status, 'DEVICE_ATTESTED');
  assert.equal(r.source('NIDA_PORTRAIT').status, 'NOT_AUTHORISED');
  assert.equal(r.source('NONE').status, 'MANUAL_ONLY');
  assert.equal(r.all().length, 3);
});

// ── No field may carry an image ───────────────────────────────────

const JPEG_B64 = `/9j/4AAQSkZJRgABAQAAAQABAAD/${'A'.repeat(400)}`;

test('NO IMAGE: any data: URI anywhere is refused as an image payload', () => {
  for (const key of ['modelId', 'modelVersion', 'deviceId', 'ticketId', 'capturedAt']) {
    const res = parseEvidenceRequest({ record: record({ [key]: 'data:image/jpeg;base64,/9j/4AAQ' }), signature: SIG });
    assert.deepEqual(res, { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' }, key);
  }
  assert.deepEqual(
    parseEvidenceRequest({ record: record(), signature: SIG, extra: ' DATA:image/png;base64,iVBOR' }),
    { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' },
  );
});

test('NO IMAGE: any string over 1 KiB anywhere is refused', () => {
  const long = 'x'.repeat(MAX_ANY_STRING + 1);
  assert.deepEqual(parseEvidenceRequest({ record: record({ modelId: long }), signature: SIG }), { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' });
  assert.deepEqual(parseEvidenceRequest({ record: record(), signature: long }), { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' });
  assert.deepEqual(parseEvidenceRequest({ record: record(), signature: SIG, note: long }), { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' });
});

test('NO IMAGE: base64-looking values (frame, template) are refused, under any key', () => {
  for (const key of ['frame', 'image', 'template', 'portrait', 'modelId']) {
    assert.deepEqual(
      parseEvidenceRequest({ record: record({ [key]: JPEG_B64 }), signature: SIG }),
      { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' },
      key,
    );
  }
  assert.deepEqual(parseEvidenceRequest({ record: record(), signature: JPEG_B64 }), { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' });
});

test('NO IMAGE: arrays (embeddings) are refused anywhere, even short ones', () => {
  const embedding = Array.from({ length: 128 }, (_, i) => i / 128);
  assert.deepEqual(parseEvidenceRequest({ record: record({ embedding }), signature: SIG }), { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' });
  assert.deepEqual(parseEvidenceRequest({ record: record({ matchScoreBp: [9_100] }), signature: SIG }), { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' });
  assert.deepEqual(parseEvidenceRequest({ record: record(), signature: SIG, vectors: [] }), { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' });
  assert.equal(findImagePayload({ a: { b: { c: { d: { e: 'deep' } } } } }), true, 'excessive nesting is refused');
});

test('NO IMAGE: unknown keys are refused even when harmless-looking', () => {
  assert.deepEqual(parseEvidenceRequest({ record: record({ note: 'ok' }), signature: SIG }), { ok: false, reason: 'SCHEMA_INVALID' });
  assert.deepEqual(parseEvidenceRequest({ record: record(), signature: SIG, note: 'ok' }), { ok: false, reason: 'SCHEMA_INVALID' });
  const missing = record();
  delete missing['modelVersion'];
  assert.deepEqual(parseEvidenceRequest({ record: missing, signature: SIG }), { ok: false, reason: 'SCHEMA_INVALID' });
  assert.deepEqual(parseEvidenceRequest({ record: record({ modelId: { nested: 'x' } }), signature: SIG }), { ok: false, reason: 'SCHEMA_INVALID' });
});

test('the legitimate long values pass the image guard: signature, key id, ticket id', () => {
  const res = parseEvidenceRequest({ record: record(), signature: SIG });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(SIG.length, 88);
});

// ── Schema ─────────────────────────────────────────────────────────

test('schema: every key is required and every value is typed and bounded', () => {
  assert.equal(EVIDENCE_RECORD_KEYS.length, 19);
  const cases: [string, unknown][] = [
    ['schema', 'USRP-BIO-EVIDENCE.v2'],
    ['recordId', 'not-a-uuid'],
    ['recordId', '0B7C3F8E-2A51-4C1D-9E2F-6A7B8C9D0E1F'],
    ['agency', 'XYZ'],
    ['applicationId', 7],
    ['ticketId', ''],
    ['ticketId', 'has space'],
    ['deviceId', 'x'.repeat(65)],
    ['keyId', 'ABC'],
    ['referenceSource', 'FINGERPRINT'],
    ['method', 'FACE_1_N'],
    ['consentState', 'MAYBE'],
    ['outcome', 'REFUSE'],
    ['notAttemptedReason', 'BORED'],
    ['livenessScoreBp', 0.94],
    ['livenessScoreBp', 10_001],
    ['matchScoreBp', -1],
    ['matchScoreBp', '9100'],
    ['modelId', ''],
    ['modelVersion', 'v'.repeat(33)],
    ['thresholdPolicyVersion', 'bio thresholds'],
    ['mode', 'OFF'],
    ['mode', 'AUTOMATIC'],
    ['capturedAt', '2026-10-19 07:15:00'],
    ['capturedAt', '2026-13-45T99:99:99Z'],
  ];
  for (const [key, value] of cases) {
    assert.equal(parseEvidenceRecord(record({ [key]: value })), null, `${key}=${JSON.stringify(value)}`);
  }
  assert.equal(parseEvidenceRecord(null), null);
  assert.equal(parseEvidenceRecord([]), null);
  assert.deepEqual(parseEvidenceRequest({ record: record(), signature: 'short' }), { ok: false, reason: 'SCHEMA_INVALID' });
  assert.deepEqual(parseEvidenceRequest('nope'), { ok: false, reason: 'SCHEMA_INVALID' });
});

// ── Consistency ────────────────────────────────────────────────────

test('consistency: a declared outcome must be what the policy says the scores mean', () => {
  assert.equal(checkEvidenceConsistency(parsed(record()), 'CONSENT_OR_DECLINE'), null);
  assert.equal(checkEvidenceConsistency(parsed(record({ outcome: 'NO_MATCH' })), 'CONSENT_OR_DECLINE'), 'OUTCOME_INCONSISTENT');
  assert.equal(checkEvidenceConsistency(parsed(record({ matchScoreBp: 4_000, outcome: 'NO_MATCH' })), 'CONSENT_OR_DECLINE'), null);
  assert.equal(checkEvidenceConsistency(parsed(record({ matchScoreBp: 7_000, outcome: 'INCONCLUSIVE' })), 'CONSENT_OR_DECLINE'), null);
  assert.equal(checkEvidenceConsistency(parsed(record({ livenessScoreBp: 1_000, outcome: 'INCONCLUSIVE' })), 'CONSENT_OR_DECLINE'), null);
  assert.equal(checkEvidenceConsistency(parsed(record({ thresholdPolicyVersion: 'BIO-THRESHOLDS.v9' })), 'CONSENT_OR_DECLINE'), 'THRESHOLD_POLICY_UNKNOWN');
});

test('consistency: an attempted capture needs consent, a source, a model and both scores', () => {
  const bad: Partial<Record<keyof EvidenceRecord, unknown>>[] = [
    { consentState: 'DECLINED' },
    { notAttemptedReason: 'CAPTURE_FAILED' },
    { referenceSource: 'NONE' },
    { method: 'NONE' },
    { modelId: null },
    { modelVersion: null },
    { livenessScoreBp: null },
    { matchScoreBp: null },
  ];
  for (const o of bad) {
    assert.equal(checkEvidenceConsistency(parsed(record(o)), 'CONSENT_OR_DECLINE'), 'OUTCOME_INCONSISTENT', JSON.stringify(o));
  }
});

test('consistency: a decline is always a valid NOT_ATTEMPTED record, and only with its reason', () => {
  assert.equal(checkEvidenceConsistency(parsed(declined()), 'CONSENT_OR_DECLINE'), null);
  const bad: Partial<Record<keyof EvidenceRecord, unknown>>[] = [
    { notAttemptedReason: 'CAPTURE_FAILED' },
    { notAttemptedReason: null },
    { method: 'FACE_1_1_ON_DEVICE' },
    { livenessScoreBp: 9_000 },
    { modelId: 'm' },
  ];
  for (const o of bad) {
    assert.equal(checkEvidenceConsistency(parsed({ ...declined(), ...o }), 'CONSENT_OR_DECLINE'), 'OUTCOME_INCONSISTENT', JSON.stringify(o));
  }
  // consent given, but the capture failed: valid NOT_ATTEMPTED
  assert.equal(checkEvidenceConsistency(parsed({ ...declined(), consentState: 'GIVEN', notAttemptedReason: 'CAPTURE_FAILED' }), 'CONSENT_OR_DECLINE'), null);
  // CANDIDATE_DECLINED without a decline is inconsistent
  assert.equal(checkEvidenceConsistency(parsed({ ...declined(), consentState: 'GIVEN' }), 'CONSENT_OR_DECLINE'), 'OUTCOME_INCONSISTENT');
  // NONE source travels with NO_REFERENCE_SOURCE
  assert.equal(checkEvidenceConsistency(parsed({ ...declined(), consentState: 'GIVEN', referenceSource: 'NONE', notAttemptedReason: 'NO_REFERENCE_SOURCE' }), 'CONSENT_OR_DECLINE'), null);
  assert.equal(checkEvidenceConsistency(parsed({ ...declined(), consentState: 'GIVEN', notAttemptedReason: 'NO_REFERENCE_SOURCE' }), 'CONSENT_OR_DECLINE'), 'OUTCOME_INCONSISTENT');
});

test('consistency: under consent-or-decline, NOT_REQUIRED_BY_POLICY is refused', () => {
  assert.equal(checkEvidenceConsistency(parsed(record({ consentState: 'NOT_REQUIRED_BY_POLICY' })), 'CONSENT_OR_DECLINE'), 'CONSENT_STATE_NOT_PERMITTED');
});

test('capturedAt window: 24h old .. 5min ahead', () => {
  const now = new Date('2026-10-19T08:00:00.000Z');
  assert.equal(isCapturedAtAcceptable('2026-10-19T08:00:00.000Z', now), true);
  assert.equal(isCapturedAtAcceptable('2026-10-18T08:00:00.000Z', now), true);
  assert.equal(isCapturedAtAcceptable('2026-10-18T07:59:59.999Z', now), false);
  assert.equal(isCapturedAtAcceptable('2026-10-19T08:05:00.000Z', now), true);
  assert.equal(isCapturedAtAcceptable('2026-10-19T08:05:00.001Z', now), false);
});

// ── Signing input ──────────────────────────────────────────────────

test('signing input is canonical JSON: key order does not matter, values do', () => {
  const a = parsed(record());
  const reversed = Object.fromEntries(Object.entries(record()).reverse());
  const b = parsed(reversed);
  assert.equal(evidenceSigningInput(a).toString('utf8'), evidenceSigningInput(b).toString('utf8'));
  assert.equal(evidenceDigest(a), evidenceDigest(b));
  assert.ok(evidenceSigningInput(a).toString('utf8').startsWith('{"agency":"RDF","applicationId":'));
  assert.ok(evidenceSigningInput(a).toString('utf8').includes('"notAttemptedReason":null'));
  const sig = signEd25519(KEYS.privateKeyPem, evidenceSigningInput(a));
  assert.equal(verifyEd25519(KEYS.publicKeyPem, evidenceSigningInput(b), sig), true);
  const tampered = parsed(record({ matchScoreBp: 9_101 }));
  assert.equal(verifyEd25519(KEYS.publicKeyPem, evidenceSigningInput(tampered), sig), false);
});

test('key id is the SHA-256 of the SPKI DER, stable and per key', () => {
  assert.match(deviceKeyId(KEYS.publicKeyPem), /^[0-9a-f]{64}$/);
  assert.equal(deviceKeyId(KEYS.publicKeyPem), deviceKeyId(KEYS.publicKeyPem));
  assert.notEqual(deviceKeyId(generateDeviceKeyPair().publicKeyPem), deviceKeyId(KEYS.publicKeyPem));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectBiometricPolicy,
  projectEvidenceList,
  projectRecordEvidence,
  screenEvidenceBody,
} from '../src/adapters/http/biometric-evidence.controller.js';

const SIG = `${'A'.repeat(86)}==`;
const RECORD = {
  schema: 'USRP-BIO-EVIDENCE.v1',
  recordId: '0b7c3f8e-2a51-4c1d-9e2f-6a7b8c9d0e1f',
  applicationId: '9a111111-1111-4111-8111-111111111111',
  ticketId: 'Zx9_-abcDEF0123456789abcdefghijklmnopqrstuv',
  deviceId: 'TAB-RDF-0001',
  keyId: 'a'.repeat(64),
  referenceSource: 'CARD_PORTRAIT',
  method: 'FACE_1_1_ON_DEVICE',
  consentState: 'GIVEN',
  outcome: 'MATCH',
  notAttemptedReason: null,
  livenessScoreBp: 9400,
  matchScoreBp: 9100,
  modelId: 'usrp-face-card',
  modelVersion: '1.0.0',
  thresholdPolicyVersion: 'BIO-THRESHOLDS.v1',
  mode: 'SHADOW',
  capturedAt: '2026-10-19T07:15:00.000Z',
};

test('NO IMAGE: the edge refuses image-shaped bodies before forwarding anything', () => {
  const refused = (body: Record<string, unknown>): unknown => screenEvidenceBody(body)?.body;
  const image = { error: 'INVALID_EVIDENCE', reason: 'IMAGE_PAYLOAD_REFUSED' };
  assert.deepEqual(refused({ record: { ...RECORD, frame: 'data:image/jpeg;base64,/9j/4AAQ' }, signature: SIG }), image);
  assert.deepEqual(refused({ record: { ...RECORD, embedding: [0.1, 0.2, 0.3] }, signature: SIG }), image);
  assert.deepEqual(refused({ record: { ...RECORD, template: { bytes: 'x' } }, signature: SIG }), image);
  assert.deepEqual(refused({ record: { ...RECORD, portrait: 'A'.repeat(129) }, signature: SIG }), image);
  assert.deepEqual(refused({ record: RECORD, signature: SIG, image: 'x'.repeat(2_000) }), image);
  assert.deepEqual(refused({ record: RECORD, signature: SIG, frames: [] }), image);
});

test('the edge forwards only { record, signature } with a flat scalar record', () => {
  assert.equal(screenEvidenceBody({ record: RECORD, signature: SIG }), null);
  const schema = { error: 'INVALID_EVIDENCE', reason: 'SCHEMA_INVALID' };
  assert.deepEqual(screenEvidenceBody({ record: RECORD, signature: SIG, note: 'x' })?.body, schema);
  assert.deepEqual(screenEvidenceBody({ record: RECORD, signature: 'short' })?.body, schema);
  assert.deepEqual(screenEvidenceBody({ record: { ...RECORD, livenessScoreBp: 0.94 }, signature: SIG })?.body, schema);
  const wide = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${String(i)}`, 'v']));
  assert.deepEqual(screenEvidenceBody({ record: wide, signature: SIG })?.body, schema);
});

test('record answer: SHADOW never carries an outcome, even if an upstream sends one', () => {
  const shadow = projectRecordEvidence(201, {
    status: 'RECORDED', recordId: RECORD.recordId, mode: 'SHADOW', receivedAt: '2026-10-19T07:15:01.000Z', outcome: 'NO_MATCH', deviceId: 'leak',
  });
  assert.deepEqual(shadow?.body, { status: 'RECORDED', recordId: RECORD.recordId, mode: 'SHADOW', receivedAt: '2026-10-19T07:15:01.000Z' });
  const advisory = projectRecordEvidence(201, {
    status: 'RECORDED', recordId: RECORD.recordId, mode: 'ADVISORY', receivedAt: '2026-10-19T07:15:01.000Z', outcome: 'NO_MATCH',
  });
  assert.equal((advisory?.body as Record<string, unknown>)['outcome'], 'NO_MATCH');
  assert.equal(projectRecordEvidence(201, { status: 'RECORDED', recordId: RECORD.recordId, mode: 'ADVISORY', receivedAt: '2026-10-19T07:15:01.000Z' }), null);
});

test('record answer: every documented refusal passes with exactly its detail; others are null', () => {
  const cases: [number, Record<string, unknown>][] = [
    [200, { status: 'ALREADY_RECORDED', recordId: RECORD.recordId, mode: 'SHADOW' }],
    [409, { error: 'REPLAY_CONFLICT' }],
    [409, { error: 'BIOMETRIC_OFF' }],
    [409, { error: 'MODE_MISMATCH', configuredMode: 'SHADOW' }],
    [422, { error: 'INVALID_EVIDENCE', reason: 'IMAGE_PAYLOAD_REFUSED' }],
    [422, { error: 'INVALID_EVIDENCE', reason: 'REFERENCE_SOURCE_NOT_AUTHORISED' }],
    [403, { error: 'UNTRUSTED_EVIDENCE', reason: 'SIGNATURE_INVALID' }],
    [403, { error: 'UNTRUSTED_EVIDENCE', reason: 'DEVICE_REVOKED' }],
  ];
  for (const [status, body] of cases) {
    assert.deepEqual(projectRecordEvidence(status, { ...body, extra: 'leak' })?.body, body, JSON.stringify(body));
  }
  assert.equal(projectRecordEvidence(422, { error: 'INVALID_EVIDENCE', reason: 'NEW' }), null);
  assert.equal(projectRecordEvidence(409, { error: 'MODE_MISMATCH', configuredMode: 'AUTOMATIC' }), null);
  assert.deepEqual(projectRecordEvidence(403, { error: 'FORBIDDEN' })?.body, { error: 'PERMISSION_DENIED' });
  assert.equal(projectRecordEvidence(500, {}), null);
});

const ITEM = {
  recordId: RECORD.recordId, ticketId: RECORD.ticketId, referenceSource: 'CARD_PORTRAIT', method: 'FACE_1_1_ON_DEVICE',
  consentState: 'GIVEN', outcome: 'NO_MATCH', notAttemptedReason: null, livenessScoreBp: 9000, matchScoreBp: 4000,
  modelId: 'usrp-face-card', modelVersion: '1.0.0', thresholdPolicyVersion: 'BIO-THRESHOLDS.v1', mode: 'ADVISORY',
  capturedAt: '2026-10-19T07:15:00.000Z', receivedAt: '2026-10-19T07:15:01.000Z',
  manualIdentity: { reasonCode: 'CARD_PHOTO_OUTDATED', confirmedAt: '2026-10-19T07:20:00.000Z' },
};

test('evidence read: no device internals, and a SHADOW row is never relayed', () => {
  const r = projectEvidenceList({
    applicationId: RECORD.applicationId,
    evidence: [{ ...ITEM, deviceId: 'leak', keyId: 'leak', signature: 'leak', officerId: 'leak' }],
  });
  assert.ok(r);
  assert.ok(!JSON.stringify(r).includes('leak'));
  assert.deepEqual((r['evidence'] as unknown[])[0], ITEM);
  assert.equal(projectEvidenceList({ applicationId: RECORD.applicationId, evidence: [{ ...ITEM, mode: 'SHADOW' }] }), null);
  assert.equal(projectEvidenceList({ applicationId: RECORD.applicationId, evidence: [{ ...ITEM, manualIdentity: { reasonCode: 'FREE TEXT', confirmedAt: ITEM.receivedAt } }] }), null);
});

test('policy: allowlisted and closed', () => {
  const policy = {
    agency: 'RDF', mode: 'SHADOW', legalBasis: 'CONSENT_OR_DECLINE', evidenceSchema: 'USRP-BIO-EVIDENCE.v1', maxBodyBytes: 4096,
    thresholdPolicy: { version: 'BIO-THRESHOLDS.v1', livenessPassBp: 8500, matchBp: 8500, noMatchBelowBp: 6000 },
    referenceSources: [{ id: 'CARD_PORTRAIT', status: 'DEVICE_ATTESTED' }, { id: 'NIDA_PORTRAIT', status: 'NOT_AUTHORISED' }],
  };
  assert.deepEqual(projectBiometricPolicy({ ...policy, secret: 'x' }), policy);
  assert.equal(projectBiometricPolicy({ ...policy, mode: 'AUTOMATIC' }), null);
});

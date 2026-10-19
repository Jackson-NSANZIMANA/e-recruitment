import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectGateAdmission } from '../src/adapters/http/gate-admission.controller.js';

const CANDIDATE = { applicationId: '22222222-2222-4222-8222-222222222222', processingCode: 'RDF-90001', category: 'GENERAL_ENLISTMENT' };
const ADMITTED = {
  outcome: 'ADMITTED', candidate: { ...CANDIDATE, applicantId: 'leak-1' }, venueName: 'ULK Stadium', examDate: '2026-12-01',
  reportingTimeHour: 8, admittedAt: '2026-12-01T06:01:00.000Z', statusAdvanced: true, nationalIdHash: 'leak-2',
  identityMethod: 'NATIONAL_ID_CARD+SUPERVISOR',
};

test('ADMITTED is rebuilt from the allowlist; nothing else crosses to the tablet', () => {
  const r = projectGateAdmission(200, ADMITTED);
  assert.ok(r !== null);
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('leak-'));
  assert.deepEqual((r.body as Record<string, unknown>)['candidate'], CANDIDATE);
  assert.equal((r.body as Record<string, unknown>)['identityMethod'], 'NATIONAL_ID_CARD+SUPERVISOR');
});

test('every documented refusal passes with exactly its detail', () => {
  const cases: [number, Record<string, unknown>][] = [
    [409, { error: 'ALREADY_ADMITTED', candidate: CANDIDATE, admittedAt: '2026-12-01T06:01:00.000Z', venueName: 'ULK Stadium', admittedBySelf: true }],
    [409, { error: 'NOT_ADMISSIBLE', candidate: CANDIDATE, currentStatus: 'WITHDRAWN' }],
    [409, { error: 'IDENTITY_MISMATCH', candidate: CANDIDATE }],
    [409, { error: 'MANUAL_IDENTITY_REQUIRED', candidate: CANDIDATE }],
    [409, { error: 'WRONG_VENUE', ticketVenueName: 'Amahoro Stadium' }],
    [409, { error: 'TOO_EARLY', examDate: '2026-12-01' }],
    [409, { error: 'EXPIRED', examDate: '2026-12-01' }],
    [422, { error: 'INVALID_TICKET', reason: 'TICKET_NOT_ISSUED' }],
  ];
  for (const [status, body] of cases) {
    const r = projectGateAdmission(status, { ...body, extra: 'leak' });
    assert.ok(r !== null, JSON.stringify(body));
    assert.deepEqual(r.body, body);
  }
});

test('anything off-contract is null (the handler answers 502), never relayed', () => {
  assert.equal(projectGateAdmission(200, { outcome: 'ADMITTED' }), null);
  assert.equal(projectGateAdmission(200, { ...ADMITTED, identityMethod: 'BIOMETRIC_ONLY' }), null);
  assert.equal(projectGateAdmission(409, { error: 'NEW_CODE' }), null);
  assert.equal(projectGateAdmission(409, { error: 'IDENTITY_MISMATCH', candidate: { ...CANDIDATE, applicationId: 'x' } }), null);
  assert.equal(projectGateAdmission(422, { error: 'INVALID_TICKET', reason: 'OTHER' }), null);
  assert.equal(projectGateAdmission(500, { error: 'X' }), null);
  assert.equal(projectGateAdmission(200, null), null);
});

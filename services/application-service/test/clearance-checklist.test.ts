import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearanceStateOf, evaluateDocumentChecklist, type GateVerdicts } from '../src/domain/document-requirements.js';
import { queueReasons } from '../src/adapters/application-read.pg-repository.js';
import { parseClearanceNumber } from '../src/domain/clearance-number.js';
import { AttachClearanceCertificateService } from '../src/application/attach-clearance-certificate.service.js';
import { InMemoryEventBus } from '@usrp/shared-events';

const gates = (over: Partial<GateVerdicts>): GateVerdicts => ({ identityVerified: true, academicStatus: 'PENDING', criminalStatus: 'PENDING', ...over });

test('clearance state: outstanding until verified, correctable, and under an officer', () => {
  assert.equal(clearanceStateOf(gates({})).state, 'NUMBER_REQUIRED');
  assert.equal(clearanceStateOf(gates({ clearance: { outcome: 'PENDING', failureCode: 'REGISTRY_UNAVAILABLE', reviewReasons: [] } })).state, 'VERIFYING');
  const fix = clearanceStateOf(gates({ clearance: { outcome: 'CORRECTION_NEEDED', failureCode: 'CERTIFICATE_EXPIRED', reviewReasons: [] } }));
  assert.deepEqual([fix.state, fix.code], ['CORRECTION_NEEDED', 'CERTIFICATE_EXPIRED']);
  const review = clearanceStateOf(gates({ criminalStatus: 'UNDER_REVIEW', clearance: { outcome: 'REVIEW', failureCode: null, reviewReasons: ['CLEARANCE_CONTENT_REVIEW'] } }));
  assert.deepEqual([review.state, review.reasons], ['UNDER_OFFICER_REVIEW', ['CLEARANCE_CONTENT_REVIEW']]);
  assert.equal(clearanceStateOf(gates({ criminalStatus: 'CLEARED' })).state, 'VERIFIED');
});

test('the checklist item for the RIB-verified paper carries the state; others do not', () => {
  const list = evaluateDocumentChecklist('RNP_BASIC' as never, { source: 'GROUND_TRUTH_TABLE', types: ['NATIONAL_ID', 'NON_CONVICTION_CERTIFICATE'] }, gates({}), []);
  const nonConviction = list.items.find((i) => i.documentType === 'NON_CONVICTION_CERTIFICATE');
  assert.equal(nonConviction?.satisfaction, 'MISSING');
  assert.equal(nonConviction?.clearance?.state, 'NUMBER_REQUIRED');
  assert.equal(list.items.find((i) => i.documentType === 'NATIONAL_ID')?.clearance, undefined);
  const done = evaluateDocumentChecklist('RNP_BASIC' as never, { source: 'GROUND_TRUTH_TABLE', types: ['NON_CONVICTION_CERTIFICATE'] }, gates({ criminalStatus: 'CLEARED' }), []);
  assert.deepEqual([done.items[0]?.satisfaction, done.items[0]?.clearance?.state], ['API_VERIFIED', 'VERIFIED']);
});

test('queue reasons: clearance review, NESA review, and the generic fallbacks', () => {
  const base = { criminal_status: 'PENDING', academic_status: 'ELIGIBLE', academic_detail: null, clearance_reasons: null };
  assert.deepEqual(queueReasons(base), []);
  assert.deepEqual(queueReasons({ ...base, criminal_status: 'UNDER_REVIEW', clearance_reasons: ['IDENTITY_NAME_PARTIAL', 'CLEARANCE_CONTENT_REVIEW', 'junk'] }), ['CLEARANCE_CONTENT_REVIEW', 'IDENTITY_NAME_PARTIAL']);
  assert.deepEqual(queueReasons({ ...base, criminal_status: 'UNDER_REVIEW' }), ['CRIMINAL_RECORD_REVIEW']);
  assert.deepEqual(queueReasons({ ...base, academic_status: 'PENDING', academic_detail: { failureCode: 'NESA_REVIEW_REQUIRED', reviewReasons: ['NAME_PARTIAL', 'MALPRACTICE'] } }), ['IDENTITY_NAME_PARTIAL', 'NESA_MALPRACTICE']);
  assert.deepEqual(queueReasons({ ...base, academic_status: 'PENDING', academic_detail: { failureCode: 'NESA_RECORD_NOT_BOUND' } }), []);
});

const own = (over: object = {}) => ({ findOwn: () => Promise.resolve({ agency: 'RDF' as const, category: 'RDF_REGULAR' as const, status: 'SUBMITTED' as never, criminalStatus: 'PENDING' as const, ...over }) });
const cmd = (n: string, actor: object = { kind: 'system' }) => ({ actor: actor as never, applicantId: 'a', applicationId: 'b', clearanceCertificateNumber: n, context: { correlationId: 'c', causationId: 'c' } });

test('attach: stages one event with the normalised number; refuses officers, closed and malformed', async () => {
  const bus = new InMemoryEventBus();
  const svc = new AttachClearanceCertificateService({ repository: own(), eventBus: bus, clock: () => new Date('2026-10-25T23:30:00Z') });
  assert.equal(parseClearanceNumber('s990000000001 abcd'), 'S990000000001ABCD');
  assert.equal((await svc.attach(cmd('s990000000001-abcd'))).kind, 'ACCEPTED');
  const e = bus.published[0];
  assert.ok(e && e.eventType === 'CLEARANCE_CERTIFICATE_SUBMITTED');
  assert.deepEqual([e.clearanceCertificateNumber, e.referenceDate], ['S990000000001ABCD', '2026-10-26']); // Kigali is UTC+2
  assert.equal((await svc.attach(cmd('S990000000001ABCD', { kind: 'officer' }))).kind, 'FORBIDDEN');
  assert.equal((await svc.attach(cmd('nope'))).kind, 'INVALID_NUMBER');
  assert.equal(bus.published.length, 1);
  const closed = new AttachClearanceCertificateService({ repository: own({ status: 'WITHDRAWN' }), eventBus: bus });
  assert.equal((await closed.attach(cmd('S990000000001ABCD'))).kind, 'NOT_APPLICABLE');
  const cleared = new AttachClearanceCertificateService({ repository: own({ criminalStatus: 'CLEARED' }), eventBus: bus });
  assert.equal((await cleared.attach(cmd('S990000000001ABCD'))).kind, 'ALREADY_VERIFIED');
  const none = new AttachClearanceCertificateService({ repository: { findOwn: () => Promise.resolve(null) }, eventBus: bus });
  assert.equal((await none.attach(cmd('S990000000001ABCD'))).kind, 'NOT_FOUND');
  assert.equal(bus.published.length, 1);
});

test('attach: with the Irembo flow off nothing is accepted (no one would consume the event)', async () => {
  const bus = new InMemoryEventBus();
  const off = new AttachClearanceCertificateService({ repository: own(), eventBus: bus, enabled: false });
  assert.equal((await off.attach(cmd('S990000000001ABCD'))).kind, 'NOT_ENABLED');
  assert.equal(bus.published.length, 0);
});

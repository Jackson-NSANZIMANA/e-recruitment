import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectMyDocumentUploadAnswer } from '../src/adapters/http/citizen.controller.js';

const DOCUMENT_ID = '33333333-3333-4333-8333-333333333333';
const DOCUMENT_TYPE = 'NATIONAL_ID';
const MISMATCH = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

function identityClosed(reason: unknown): Record<string, unknown> {
  return { status: 'REFUSED', error: 'DOCUMENT_REVIEW_CLOSED', reason };
}

test('a valid Identity 201 projects exactly the public D8 revision shape', () => {
  const result = projectMyDocumentUploadAnswer(201, {
    status: 'UPLOADED',
    documentId: DOCUMENT_ID,
    documentType: DOCUMENT_TYPE,
    revision: 7,
    lane: 'RED',
    score: 99,
    flags: ['LEAK'],
    contentHmac: 'a'.repeat(64),
    history: [{ revision: 6 }],
    extra: 'not public',
  }, DOCUMENT_TYPE);
  assert.deepEqual(result, {
    status: 201,
    body: {
      status: 'UPLOADED',
      documentId: DOCUMENT_ID,
      documentType: DOCUMENT_TYPE,
      revision: 7,
    },
  });
  assert.doesNotMatch(JSON.stringify(result.body), /RED|99|LEAK|contentHmac|history|extra/);
});

test('invalid revision, id, status, or echoed document type is a contract mismatch', () => {
  const malformed: readonly unknown[] = [
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: DOCUMENT_TYPE },
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: DOCUMENT_TYPE, revision: 0 },
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: DOCUMENT_TYPE, revision: 1.5 },
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: DOCUMENT_TYPE, revision: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: DOCUMENT_TYPE, revision: '2' },
    { status: 'UPLOADED', documentId: 'bad-id', documentType: DOCUMENT_TYPE, revision: 1 },
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: 'PASSPORT', revision: 1 },
    { status: 'REFUSED', documentId: DOCUMENT_ID, documentType: DOCUMENT_TYPE, revision: 1 },
  ];
  for (const body of malformed) {
    assert.deepEqual(projectMyDocumentUploadAnswer(201, body, DOCUMENT_TYPE), MISMATCH);
  }
});

test('the D8 409 projection preserves either approved reason and no other upstream fields', () => {
  for (const reason of ['HUMAN_REVIEWED', 'CASE_ADVANCED'] as const) {
    const result = projectMyDocumentUploadAnswer(409, {
      ...identityClosed(reason),
      lane: 'AMBER',
      score: 50,
      flags: ['LEAK'],
      contentHmac: 'b'.repeat(64),
      applicationId: 'private-id',
      extra: 'not public',
    }, DOCUMENT_TYPE);
    assert.deepEqual(result, { status: 409, body: { error: 'DOCUMENT_REVIEW_CLOSED', reason } });
  }
});

test('a missing or unknown D8 reason is a contract mismatch, never a generic refusal', () => {
  const malformed: readonly unknown[] = [
    { status: 'REFUSED', error: 'DOCUMENT_REVIEW_CLOSED' },
    identityClosed(undefined),
    identityClosed(null),
    identityClosed('HUMAN_REVIEWED; arbitrary upstream text'),
    identityClosed('REVIEWED'),
  ];
  for (const body of malformed) {
    assert.deepEqual(projectMyDocumentUploadAnswer(409, body, DOCUMENT_TYPE), MISMATCH);
  }
});

test('generic 403 and unknown 4xx codes do not become the D8 refusal', () => {
  assert.deepEqual(projectMyDocumentUploadAnswer(403, {
    error: 'FORBIDDEN', reason: 'HUMAN_REVIEWED',
  }, DOCUMENT_TYPE), MISMATCH);
  assert.deepEqual(projectMyDocumentUploadAnswer(409, {
    error: 'NEW_REFUSAL_CODE', reason: 'HUMAN_REVIEWED',
  }, DOCUMENT_TYPE), MISMATCH);
  assert.deepEqual(projectMyDocumentUploadAnswer(403, identityClosed('HUMAN_REVIEWED'), DOCUMENT_TYPE), MISMATCH);
  assert.deepEqual(projectMyDocumentUploadAnswer(422, identityClosed('HUMAN_REVIEWED'), DOCUMENT_TYPE), MISMATCH);
});

test('ordinary upload refusals and infrastructure failures keep their distinct projections', () => {
  assert.deepEqual(projectMyDocumentUploadAnswer(409, {
    status: 'REFUSED', error: 'NOT_ACCEPTING_DOCUMENTS', arbitrary: 'dropped',
  }, DOCUMENT_TYPE), { status: 409, body: { error: 'NOT_ACCEPTING_DOCUMENTS' } });
  assert.deepEqual(projectMyDocumentUploadAnswer(503, {
    error: 'SCANNER_UNAVAILABLE', reason: 'internal details',
  }, DOCUMENT_TYPE), { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } });
});

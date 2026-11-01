import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpDocumentUploadGateway } from '../src/adapters/document-upload.http-gateway.js';
import type { DocumentUploadInput } from '../src/ports/document-upload-gateway.js';

const APPLICANT_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '33333333-3333-4333-8333-333333333333';
const INPUT: DocumentUploadInput = {
  applicationId: '22222222-2222-4222-8222-222222222222',
  documentType: 'NATIONAL_ID',
  file: {
    bytes: Buffer.from('%PDF-1.4 test'),
    contentType: 'application/pdf',
    filename: 'identity.pdf',
  },
};

function gatewayFor(status: number, body: unknown): HttpDocumentUploadGateway {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/auth/service/token')) {
      return new Response(JSON.stringify({
        token: 'test-system-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/documents/upload')) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
  return new HttpDocumentUploadGateway({
    iamBaseUrl: 'http://iam.test',
    forensicsBaseUrl: 'http://forensics.test',
    clientId: 'identity-test',
    clientSecret: 'secret',
    fetchImpl,
  });
}

async function upload(status: number, body: unknown) {
  return gatewayFor(status, body).uploadForApplicant(APPLICANT_ID, INPUT);
}

test('forensics upload success preserves the validated revision and drops arbitrary fields', async () => {
  const result = await upload(201, {
    status: 'UPLOADED',
    documentId: DOCUMENT_ID,
    documentType: 'NATIONAL_ID',
    revision: 2,
    lane: 'RED',
    score: 100,
    flags: ['LEAK'],
    contentHmac: 'a'.repeat(64),
    arbitrary: 'not for the citizen',
  });
  assert.deepEqual(result, {
    kind: 'UPLOADED',
    documentId: DOCUMENT_ID,
    documentType: 'NATIONAL_ID',
    revision: 2,
  });
});

test('missing, malformed, or unsafe revisions fail closed', async () => {
  const revisions: readonly unknown[] = [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'];
  for (const revision of revisions) {
    const body: Record<string, unknown> = {
      status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: 'NATIONAL_ID',
    };
    if (revision !== undefined) body['revision'] = revision;
    assert.deepEqual(await upload(201, body), { kind: 'DEPENDENCY_UNAVAILABLE' }, `revision=${String(revision)}`);
  }
});

test('success also requires the expected status, a UUID document ID, and the matching type', async () => {
  const malformed: readonly unknown[] = [
    { status: 'REFUSED', documentId: DOCUMENT_ID, documentType: 'NATIONAL_ID', revision: 1 },
    { status: 'UPLOADED', documentId: 'not-a-uuid', documentType: 'NATIONAL_ID', revision: 1 },
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: 'PASSPORT', revision: 1 },
    { status: 'UPLOADED', documentId: DOCUMENT_ID, documentType: 'NATIONAL_ID' },
  ];
  for (const body of malformed) {
    assert.deepEqual(await upload(201, body), { kind: 'DEPENDENCY_UNAVAILABLE' });
  }
});

test('DOCUMENT_REVIEW_CLOSED preserves only the approved D8 reason', async () => {
  for (const reason of ['HUMAN_REVIEWED', 'CASE_ADVANCED'] as const) {
    const result = await upload(409, {
      error: 'DOCUMENT_REVIEW_CLOSED',
      reason,
      lane: 'AMBER',
      score: 50,
      contentHmac: 'b'.repeat(64),
      arbitrary: 'not for the citizen',
    });
    assert.deepEqual(result, {
      kind: 'REFUSED',
      httpStatus: 409,
      code: 'DOCUMENT_REVIEW_CLOSED',
      reason,
    });
  }
});

test('missing, unknown, or status-mismatched D8 reasons fail closed', async () => {
  const malformed: readonly { readonly status: number; readonly body: unknown }[] = [
    { status: 409, body: { error: 'DOCUMENT_REVIEW_CLOSED' } },
    { status: 409, body: { error: 'DOCUMENT_REVIEW_CLOSED', reason: 'ARBITRARY_UPSTREAM_TEXT' } },
    { status: 409, body: { error: 'DOCUMENT_REVIEW_CLOSED', reason: null } },
    { status: 422, body: { error: 'DOCUMENT_REVIEW_CLOSED', reason: 'HUMAN_REVIEWED' } },
  ];
  for (const answer of malformed) {
    assert.deepEqual(
      await upload(answer.status, answer.body),
      { kind: 'DEPENDENCY_UNAVAILABLE' },
      `status=${String(answer.status)}`,
    );
  }
});

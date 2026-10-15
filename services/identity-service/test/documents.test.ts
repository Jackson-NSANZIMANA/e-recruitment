// Citizen document door — pure proof over a real socket, no infrastructure.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';
import { applicantDocumentRoutes } from '../src/adapters/http/applicant-documents.controller.js';
import type { ApplicantAuthService } from '../src/application/applicant-auth.service.js';
import type {
  DocumentUploadGateway,
  DocumentUploadInput,
  DocumentUploadResult,
} from '../src/ports/document-upload-gateway.js';

const APPLICANT = '11111111-1111-4111-8111-111111111111';
const APPLICATION = '22222222-2222-4222-8222-222222222222';

const calls: { applicantId: string; input: DocumentUploadInput }[] = [];
let nextResult: DocumentUploadResult = {
  kind: 'UPLOADED',
  documentId: '33333333-3333-4333-8333-333333333333',
  documentType: 'NATIONAL_ID_COPY',
};

const auth = {
  authenticateSession: (t: string): Promise<string | null> =>
    Promise.resolve(t === 'good-session' ? APPLICANT : null),
} as unknown as ApplicantAuthService;

const gateway: DocumentUploadGateway = {
  uploadForApplicant: (applicantId, input) => {
    calls.push({ applicantId, input });
    return Promise.resolve(nextResult);
  },
};

let server: HttpServer;
before(async () => {
  server = await startHttpServer({
    serviceName: 'identity-docs-test',
    port: 0,
    routes: applicantDocumentRoutes(auth, gateway, {
      maxFileSizeBytes: 1024 * 1024,
      allowedMediaTypes: ['application/pdf', 'image/png'],
    }),
    readiness: () => Promise.resolve(true),
  });
});
after(async () => {
  await server.stop();
});

async function post(
  parts: Record<string, string | Blob>,
  token: string | null = 'good-session',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) {
    if (typeof v === 'string') form.append(k, v);
    else form.append(k, v, 'evil/../name.pdf');
  }
  const res = await fetch(`${server.url}/v1/applicants/me/applications/documents`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const pdf = (): Blob => new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' });

test('the subject is the SESSION, never the form', async () => {
  calls.length = 0;
  const r = await post({ applicationId: APPLICATION, documentType: 'NATIONAL_ID_COPY', file: pdf() });
  assert.equal(r.status, 201);
  assert.equal(calls[0]?.applicantId, APPLICANT);
  assert.equal(r.json['documentId'], '33333333-3333-4333-8333-333333333333');
});

test('a client applicantId part is refused, nothing forwarded', async () => {
  calls.length = 0;
  const r = await post({
    applicantId: '99999999-9999-4999-8999-999999999999',
    applicationId: APPLICATION,
    documentType: 'NATIONAL_ID_COPY',
    file: pdf(),
  });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('no session / bad session → 401 before the body is considered', async () => {
  calls.length = 0;
  assert.equal((await post({ applicationId: APPLICATION, documentType: 'X_Y_Z', file: pdf() }, null)).status, 401);
  assert.equal((await post({ applicationId: APPLICATION, documentType: 'X_Y_Z', file: pdf() }, 'nope')).status, 401);
  assert.equal(calls.length, 0);
});

test('shape errors are 400/422 and never reach the gateway', async () => {
  calls.length = 0;
  assert.equal((await post({ applicationId: 'x', documentType: 'NATIONAL_ID_COPY', file: pdf() })).status, 400);
  assert.equal((await post({ applicationId: APPLICATION, documentType: 'lower', file: pdf() })).status, 400);
  assert.equal((await post({ applicationId: APPLICATION, documentType: 'NATIONAL_ID_COPY' })).status, 400);
  const exe = new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' });
  assert.equal((await post({ applicationId: APPLICATION, documentType: 'NATIONAL_ID_COPY', file: exe })).status, 422);
  assert.equal(calls.length, 0);
});

test('refusals are a closed code set; dependency faults are 502 with no detail', async () => {
  nextResult = { kind: 'REFUSED', httpStatus: 422, code: 'DOCUMENT_REJECTED_MALWARE' };
  const refused = await post({ applicationId: APPLICATION, documentType: 'NATIONAL_ID_COPY', file: pdf() });
  assert.equal(refused.status, 422);
  assert.equal(refused.json['error'], 'DOCUMENT_REJECTED_MALWARE');
  nextResult = { kind: 'DEPENDENCY_UNAVAILABLE' };
  const down = await post({ applicationId: APPLICATION, documentType: 'NATIONAL_ID_COPY', file: pdf() });
  assert.equal(down.status, 502);
});

test('buildMultipartFormData round-trips through the parser, bytes intact', async () => {
  const { buildMultipartFormData, parseMultipartFormData } = await import('@usrp/shared-http');
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x00, 0xff, 0x2d, 0x2d]);
  const built = buildMultipartFormData(
    { applicationId: APPLICATION, documentType: 'NATIONAL_ID_COPY' },
    { fieldName: 'file', contentType: 'application/pdf', bytes },
  );
  const parsed = parseMultipartFormData(built.body, built.contentType, { maxParts: 6, maxFiles: 1, maxFieldBytes: 1024 });
  assert.equal(parsed.fields.get('applicationId'), APPLICATION);
  assert.equal(parsed.fields.get('documentType'), 'NATIONAL_ID_COPY');
  assert.deepEqual(parsed.files[0]?.bytes, bytes);
  assert.equal(parsed.files[0]?.contentType, 'application/pdf');
  assert.throws(() => buildMultipartFormData({ 'bad"name': 'x' }, { fieldName: 'file', contentType: 'application/pdf', bytes }));
});

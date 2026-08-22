// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Document upload ingress self-check (P1 #3)
//
// Proves the citizen document ingress against REAL infrastructure — live
// PostgreSQL, live MinIO (hand-rolled SigV4), live ClamAV (clamd INSTREAM), a
// real HTTP socket, and REAL browser-shaped multipart produced by Node's own
// FormData encoder (deliberately NOT a body this file hand-rolls: the parser
// must satisfy an encoder that shares none of its assumptions).
//
//   • pure multipart framing, including THE CASE-SENSITIVITY TRAP BOTH WAYS:
//     a mixed-case boundary parses, and the same body with a LOWER-CASED
//     content-type fails — the regression test for ever using ctx.contentType;
//   • pure envelope crypto: seal/open, path-bound AAD, tamper detection,
//     plaintext passthrough, and sealed-without-a-key refusing to degrade;
//   • clean JPEG → 201, SEALED at rest (raw SigV4 GET shows the envelope header
//     and no JPEG magic), document_records row, forensics + audit events;
//   • the ANALYZE route then reads that SAME sealed object — the seal is proven
//     through the real retrieval path, not only through its own unit test;
//   • C2PA-bearing JPEG → manifest presence captured in the audit metadata;
//   • re-upload → same documentId, same row, DIFFERENT ciphertext (fresh nonce);
//   • EICAR WRAPPED IN A VALID JPEG → 422, nothing in MinIO, no row, no lane
//     event, one audit event. (A plain EICAR text file never reaches the
//     scanner — the container gate refuses it first, asserted separately.)
//   • guards: wrong owner → the same 404 as nonexistent; terminal status → 409;
//     wrong-agency document type → 422; declared/actual mismatch → 422;
//     disallowed media type → 422; empty → 400; oversized → 413;
//     401 unauthenticated / 403 officer-token (system-only ingress);
//   • scanner down → 503 fail-closed: no object, no row, no event.
//
//   bash scripts/run-selfchecks.sh   (or standalone with the env below)
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { HttpError, parseMultipartFormData, startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  ANALYZE_DOCUMENT_PATH,
  BoundedRealAnalyzer,
  ClamavVirusScanner,
  DocumentEnvelopeError,
  MinioObjectStore,
  MinioObjectWriter,
  PgApplicationOwnershipReader,
  PgDocumentRecordStore,
  UPLOAD_DOCUMENT_PATH,
  UploadDocumentService,
  AnalyzeDocumentService,
  analyzeDocumentRoute,
  deriveEnvelopeKey,
  deriveObjectKey,
  encodeObjectPath,
  envelopeAad,
  isSealed,
  openDocument,
  s3Request,
  sealDocument,
  uploadDocumentRoute,
  type ScanResult,
  type VirusScanner,
} from '../src/index.js';

// ── Environment ─────────────────────────────────────────────

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const MINIO = {
  endpoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
  port: Number(process.env['MINIO_PORT'] ?? '9000'),
  useSsl: false,
  accessKey: process.env['MINIO_ROOT_USER'] ?? 'usrp_minio_admin',
  secretKey: process.env['MINIO_ROOT_PASSWORD'] ?? 'usrp_minio_dev_password',
};
const SCANNER = {
  host: process.env['CLAMAV_HOST'] ?? 'localhost',
  port: Number(process.env['CLAMAV_PORT'] ?? '3310'),
  timeoutMs: Number(process.env['CLAMAV_TIMEOUT_MS'] ?? '30000'),
};
const ENCRYPTION_SECRET =
  process.env['MINIO_ENCRYPTION_KEY'] ?? 'selfcheck_document_envelope_key_min_32_chars!!';
const ENVELOPE_KEY = deriveEnvelopeKey(ENCRYPTION_SECRET);

const BUCKET = 'usrp-upload-selfcheck';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

const APPLICANT_ID = '7f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f';
const STRANGER_ID = '7f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f';
const NID_HASH = 'f2'.repeat(32);
const RDF_APP = '7fa22222-2222-4222-8222-222222222222';
const RDF_CAMPAIGN = '7fc22222-2222-4222-8222-222222222222';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Status of an HttpError thrown synchronously, or a marker when none was. */
function throwStatus(fn: () => unknown): number | string {
  try {
    fn();
    return 'DID_NOT_THROW';
  } catch (err) {
    return err instanceof HttpError ? err.status : `NON_HTTP:${String(err)}`;
  }
}

// ── Fixture documents (real byte structures) ──────────────────────

function app1Exif(payloadPad = 20): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(payloadPad, 1)]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), payload]);
  segment.writeUInt16BE(payload.length + 2, 2);
  return segment;
}

/** Structurally valid JPEG: SOI + APP1(EXIF) + SOS(payload) + EOI. */
function jpeg(scanPayload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1Exif(),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    scanPayload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const CLEAN_JPEG = jpeg(Buffer.alloc(64, 0x55));
const BIG_JPEG = jpeg(Buffer.alloc(6 * 1024, 0x55));

/** JPEG carrying a JUMBF (C2PA) APP11 segment alongside EXIF. */
function jpegWithC2pa(): Buffer {
  const jumbf = Buffer.concat([Buffer.from('JP'), Buffer.alloc(24, 2)]);
  const app11 = Buffer.concat([Buffer.from([0xff, 0xeb, 0, 0]), jumbf]);
  app11.writeUInt16BE(jumbf.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1Exif(8),
    app11,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(16, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** The EICAR standard antivirus test string — every scanner flags it. */
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

/**
 * EICAR INSIDE A VALID JPEG — and this detail is the whole point.
 *
 * A plain EICAR text file cannot test the malware path through THIS route: the
 * container admission gate refuses unidentifiable bytes BEFORE any scan, so a
 * proof using one would report a green malware path having never run ClamAV.
 * ClamAV matches the signature anywhere in the stream, so wrapping it in a real
 * JPEG produces a file that is ADMITTED and then REJECTED by the scanner — the
 * actual path a hostile upload takes.
 */
const EICAR_JPEG = jpeg(EICAR);

/** Minimal PDF-shaped bytes (used to prove declared/actual disagreement). */
const PDF_BYTES = Buffer.from('%PDF-1.4\n/Info 1 0 R\ntrailer\n%%EOF\n');

// ── DB seed / teardown ──────────────────────────────────────

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.document_records WHERE application_id = ${RDF_APP}`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id = ${RDF_APP}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id = ${RDF_APP}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${RDF_CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  });
}

async function seed(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${NID_HASH}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES (${RDF_CAMPAIGN}, 'Upload slice RDF', 'RDF', 'REGISTRATION_OPEN',
            '["GENERAL_ENLISTMENT"]', now() - interval '1 day', now() + interval '30 days',
            '2026-10-01', '2026-10-15', 7)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RDF_APP}, 'RDF-97101', ${APPLICANT_ID}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
            'SUBMITTED'::rdf_ops.application_status)`;
}

async function docRows(): Promise<Record<string, unknown>[]> {
  return await admin<Record<string, unknown>[]>`
    SELECT id, document_type, minio_object_key, minio_object_bucket, virus_scan_status,
           forensics_score, forensics_lane, forensics_flags, file_size_bytes
    FROM rdf_ops.document_records WHERE application_id = ${RDF_APP}
    ORDER BY created_at`;
}

async function setStatus(status: string): Promise<void> {
  await admin`
    UPDATE rdf_ops.applications
    SET status = ${status}::rdf_ops.application_status
    WHERE id = ${RDF_APP}`;
}

// ── Auth fixtures ─────────────────────────────────────────

const AUTH_KEYS = generateDeviceKeyPair();
function mint(kind: 'system' | 'officer'): string {
  const base = {
    v: 1 as const,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: kind === 'officer' ? '7e222222-2222-4222-8222-222222222222' : 'selfcheck-system',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency: 'RDF', roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}
const SYSTEM_TOKEN = mint('system');
const OFFICER_TOKEN = mint('officer');

// ── HTTP helpers ──────────────────────────────────────────

interface HttpReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function readReply(res: Response): Promise<HttpReply> {
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, body: parsed };
}

interface UploadInput {
  readonly applicantId?: string;
  readonly applicationId?: string;
  readonly documentType?: string;
  readonly bytes?: Buffer;
  readonly mediaType?: string;
  readonly filename?: string;
  readonly fileField?: string;
  readonly token?: string | undefined;
}

/**
 * Upload through Node's own FormData encoder. Deliberately NOT a hand-rolled
 * body: the parser must satisfy an encoder that shares none of its assumptions,
 * boundary casing included.
 */
async function upload(baseUrl: string, input: UploadInput = {}): Promise<HttpReply> {
  const form = new FormData();
  form.set('applicantId', input.applicantId ?? APPLICANT_ID);
  form.set('applicationId', input.applicationId ?? RDF_APP);
  form.set('documentType', input.documentType ?? 'NATIONAL_ID');
  const bytes = input.bytes ?? CLEAN_JPEG;
  form.set(
    input.fileField ?? 'file',
    new Blob([bytes], { type: input.mediaType ?? 'image/jpeg' }),
    input.filename ?? 'certificate.jpg',
  );
  const token = 'token' in input ? input.token : SYSTEM_TOKEN;
  const res = await fetch(`${baseUrl}${UPLOAD_DOCUMENT_PATH}`, {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: form,
  });
  return await readReply(res);
}

async function analyze(baseUrl: string, objectKey: string, documentType: string): Promise<HttpReply> {
  const res = await fetch(`${baseUrl}${ANALYZE_DOCUMENT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SYSTEM_TOKEN}` },
    body: JSON.stringify({
      applicationId: RDF_APP,
      agency: 'RDF',
      documentType,
      objectBucket: BUCKET,
      objectKey,
    }),
  });
  return await readReply(res);
}

/** Raw read that BYPASSES the adapter's decryption — what is truly at rest. */
async function rawObject(key: string): Promise<{ status: number; body: Buffer }> {
  return await s3Request(MINIO, 'GET', encodeObjectPath(BUCKET, key), Buffer.alloc(0));
}

class DownScanner implements VirusScanner {
  async scan(): Promise<ScanResult> {
    return { kind: 'UNAVAILABLE', detail: 'stubbed outage' };
  }
}

// ── Hand-built multipart bodies (pure parser section only) ───────────

interface HandFile {
  readonly name: string;
  readonly filename: string;
  readonly type: string;
  readonly bytes: Buffer;
}

function handBody(
  boundary: string,
  fields: readonly (readonly [string, string])[],
  file?: HandFile,
  close = true,
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  if (file !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; ` +
          `filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
    );
    chunks.push(file.bytes);
    chunks.push(Buffer.from('\r\n'));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n══ document-forensics-service — upload ingress self-check ══');

  // ── 1. Pure multipart framing (no infra) ──
  console.log('\n── 1. Multipart framing (pure) ──');
  {
    // A REAL browser boundary shape: mixed case.
    const boundary = '----WebKitFormBoundaryAbC123xyZ';
    const ct = `multipart/form-data; boundary=${boundary}`;
    const body = handBody(
      boundary,
      [['applicationId', RDF_APP], ['documentType', 'NATIONAL_ID']],
      { name: 'file', filename: 'a b"c.jpg', type: 'image/jpeg', bytes: CLEAN_JPEG },
    );

    const form = parseMultipartFormData(body, ct);
    check('mixed-case boundary parses', form.files.length === 1 && form.fields.size === 2);
    check('field values decoded', form.fields.get('documentType') === 'NATIONAL_ID');
    check(
      'file bytes are byte-exact',
      form.files[0]?.bytes.equals(CLEAN_JPEG) === true,
      `${form.files[0]?.bytes.length ?? -1} vs ${CLEAN_JPEG.length}`,
    );
    check('part content-type captured', form.files[0]?.contentType === 'image/jpeg');
    // Quoted-pair unescaping — a filename may legally contain \"
    check('escaped quote in filename unescaped', form.files[0]?.filename === 'a b"c.jpg');

    // THE REGRESSION TEST FOR ctx.contentType. Lower-casing the header destroys
    // the boundary, and every real browser upload would fail as "malformed".
    check(
      'LOWER-CASED content-type fails to match the boundary (why rawContentType exists)',
      throwStatus(() => parseMultipartFormData(body, ct.toLowerCase())) === 400,
    );

    check(
      'non-multipart content-type → 415',
      throwStatus(() => parseMultipartFormData(body, 'application/json')) === 415,
    );
    check(
      'missing boundary parameter → 400',
      throwStatus(() => parseMultipartFormData(body, 'multipart/form-data')) === 400,
    );

    // Truncation must be an ERROR, never a shorter file: a body cut mid-upload
    // would otherwise scan clean because the hostile tail never arrived.
    const truncated = handBody(boundary, [['a', 'b']], undefined, false);
    check(
      'missing closing boundary → 400 (truncation is never a shorter file)',
      throwStatus(() => parseMultipartFormData(truncated, ct)) === 400,
    );

    const duplicated = handBody(boundary, [['documentType', 'FIRST'], ['documentType', 'SECOND']]);
    check(
      'duplicate field: FIRST occurrence wins (deterministic, like the cookie jar)',
      parseMultipartFormData(duplicated, ct).fields.get('documentType') === 'FIRST',
    );

    const twoFiles = Buffer.concat([
      handBody(boundary, [], { name: 'file', filename: 'a.jpg', type: 'image/jpeg', bytes: CLEAN_JPEG }, false),
      handBody(boundary, [], { name: 'file', filename: 'b.jpg', type: 'image/jpeg', bytes: CLEAN_JPEG }, true),
    ]);
    check(
      'second file part rejected when maxFiles=1',
      throwStatus(() => parseMultipartFormData(twoFiles, ct, { maxFiles: 1 })) === 400,
    );
    check(
      'oversized text field → 413',
      throwStatus(() =>
        parseMultipartFormData(handBody(boundary, [['x', 'y'.repeat(500)]]), ct, {
          maxFieldBytes: 100,
        }),
      ) === 413,
    );
    check(
      'part-count cap enforced (body cap alone cannot stop 1000 tiny parts)',
      throwStatus(() =>
        parseMultipartFormData(
          handBody(boundary, [['a', '1'], ['b', '2'], ['c', '3']]),
          ct,
          { maxParts: 2 },
        ),
      ) === 400,
    );
  }

  // ── 2. Pure envelope crypto ──
  console.log('\n── 2. At-rest envelope (pure AES-256-GCM) ──');
  {
    const key = deriveObjectKey('RDF', RDF_APP, 'NATIONAL_ID');
    const aad = envelopeAad(BUCKET, key);
    const sealed = sealDocument(ENVELOPE_KEY, aad, CLEAN_JPEG);

    check('sealed blob is detectable', isSealed(sealed));
    check('a real JPEG is NOT mistaken for sealed', !isSealed(CLEAN_JPEG));
    check('ciphertext does not contain the plaintext', !sealed.includes(CLEAN_JPEG));
    check('round-trips', openDocument(ENVELOPE_KEY, aad, sealed).equals(CLEAN_JPEG));

    // The AAD binds the blob to its object path — this is what stops an operator
    // with bucket access moving one applicant's certificate onto another's key.
    const otherAad = envelopeAad(BUCKET, deriveObjectKey('RDF', RDF_APP, 'OLEVEL_CERTIFICATE'));
    let movedFailed = false;
    try {
      openDocument(ENVELOPE_KEY, otherAad, sealed);
    } catch (err) {
      movedFailed = err instanceof DocumentEnvelopeError;
    }
    check('a sealed object COPIED TO ANOTHER KEY fails to open (path is authenticated)', movedFailed);

    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    let tamperFailed = false;
    try {
      openDocument(ENVELOPE_KEY, aad, tampered);
    } catch (err) {
      tamperFailed = err instanceof DocumentEnvelopeError;
    }
    check('tampered ciphertext fails to open', tamperFailed);

    // Backward compatibility: objects that predate the envelope read verbatim.
    check('unsealed bytes pass through unchanged', openDocument(ENVELOPE_KEY, aad, CLEAN_JPEG).equals(CLEAN_JPEG));

    // FAIL LOUD: handing ciphertext to the analyzer would publish a confident
    // AMBER lane for a document it never read.
    let noKeyFailed = false;
    try {
      openDocument(undefined, aad, sealed);
    } catch (err) {
      noKeyFailed = err instanceof DocumentEnvelopeError;
    }
    check('sealed object + NO key → throws (never returns ciphertext)', noKeyFailed);

    let shortSecretFailed = false;
    try {
      deriveEnvelopeKey('too-short');
    } catch (err) {
      shortSecretFailed = err instanceof DocumentEnvelopeError;
    }
    check('short MINIO_ENCRYPTION_KEY refused', shortSecretFailed);

    check(
      'object key is derived, stable and traversal-free',
      key === `rdf/${RDF_APP}/national_id` && !key.includes('..'),
      key,
    );
  }

  // ── 3. Infra prep ──
  console.log('\n── 3. Seeding MinIO bucket + PG fixtures ──');
  const bucketReply = await s3Request(MINIO, 'PUT', `/${BUCKET}`, Buffer.alloc(0));
  check(
    'bucket created (or already exists)',
    bucketReply.status === 200 || bucketReply.status === 409,
    `PUT bucket → ${bucketReply.status}`,
  );
  await cleanup();
  await seed();
  console.log('  ✓ PG fixtures seeded');

  // ── 4. Real service over a real socket ──
  const bus = new InMemoryEventBus();
  const analyzer = new BoundedRealAnalyzer(new ClamavVirusScanner(SCANNER));
  const recordStore = new PgDocumentRecordStore();
  const uploadService = new UploadDocumentService({
    ownership: new PgApplicationOwnershipReader(),
    analyzer,
    objectWriter: new MinioObjectWriter(MINIO, ENVELOPE_KEY),
    recordStore,
    eventBus: bus,
    bucket: BUCKET,
  });
  const analyzeService = new AnalyzeDocumentService({
    objectStore: new MinioObjectStore(MINIO, ENVELOPE_KEY),
    analyzer,
    recordStore,
    eventBus: bus,
  });
  const verify = makeAuthVerifier({
    publicKeyPem: AUTH_KEYS.publicKeyPem,
    issuer: 'usrp',
    audience: 'usrp-services',
  });
  const server = await startHttpServer({
    serviceName: 'document-upload-selfcheck',
    port: 0,
    routes: [
      uploadDocumentRoute(uploadService, verify, {
        maxFileSizeBytes: MAX_FILE_BYTES,
        allowedMediaTypes: ALLOWED_MEDIA_TYPES,
      }),
      analyzeDocumentRoute(analyzeService, verify),
    ],
  });
  const base = server.url;
  const nationalIdKey = deriveObjectKey('RDF', RDF_APP, 'NATIONAL_ID');

  try {
    console.log('\n── 4. Clean upload → 201, SEALED at rest, row + events ──');
    let firstDocumentId = '';
    {
      const r = await upload(base, { documentType: 'NATIONAL_ID', bytes: CLEAN_JPEG });
      check('201 UPLOADED', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
      check('response echoes documentId + documentType',
        typeof r.body['documentId'] === 'string' && r.body['documentType'] === 'NATIONAL_ID');
      // THE FORGERY-TUNING ORACLE IS CLOSED: the uploader learns no verdict.
      check('response leaks NO lane / score / flags (no forgery-tuning oracle)',
        r.body['lane'] === undefined && r.body['forensicsScore'] === undefined &&
        r.body['flags'] === undefined);
      firstDocumentId = String(r.body['documentId']);

      const raw = await rawObject(nationalIdKey);
      check('object exists in MinIO', raw.status === 200, `raw GET → ${raw.status}`);
      check('object at rest is SEALED', isSealed(raw.body));
      check('NO plaintext JPEG at rest (magic absent)',
        !raw.body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
      check('sealed bytes decrypt back to the uploaded file',
        openDocument(ENVELOPE_KEY, envelopeAad(BUCKET, nationalIdKey), raw.body).equals(CLEAN_JPEG));

      const rows = await docRows();
      check('one document_records row', rows.length === 1, `got ${rows.length}`);
      check('row: CLEAN + derived key + correct bucket + real size',
        rows[0]?.['virus_scan_status'] === 'CLEAN' &&
        rows[0]?.['minio_object_key'] === nationalIdKey &&
        rows[0]?.['minio_object_bucket'] === BUCKET &&
        rows[0]?.['file_size_bytes'] === CLEAN_JPEG.length,
        JSON.stringify(rows[0]));

      const forensics = bus.published.filter((e) => e.eventType === 'DOCUMENT_FORENSICS_COMPLETED');
      const audits = bus.published.filter((e) => e.eventType === 'AUDIT_ENTRY');
      check('DOCUMENT_FORENSICS_COMPLETED emitted (the amber lane fires from an upload)',
        forensics.length === 1);
      check('one AUDIT_ENTRY emitted', audits.length === 1);
    }

    console.log('\n── 5. The ANALYZE route reads the SAME sealed object ──');
    {
      // Proves the envelope round-trips through the REAL retrieval path, not
      // only through its own unit test.
      const r = await analyze(base, nationalIdKey, 'NATIONAL_ID');
      check('analyze of the sealed object → 200 ANALYZED', r.status === 200,
        `got ${r.status} ${JSON.stringify(r.body)}`);
      check('analyze reproduces a real lane from decrypted bytes',
        r.body['lane'] === 'GREEN' && r.body['forensicsScore'] === 100,
        JSON.stringify(r.body));
      check('analyze reused the SAME document row (derived key is idempotent)',
        r.body['documentId'] === firstDocumentId);
    }

    console.log('\n── 6. Re-upload: same row, fresh nonce ──');
    {
      const before = await rawObject(nationalIdKey);
      const rowsBefore = await docRows();
      const r = await upload(base, { documentType: 'NATIONAL_ID', bytes: CLEAN_JPEG });
      const after = await rawObject(nationalIdKey);
      const rowsAfter = await docRows();
      check('re-upload → 201', r.status === 201);
      check('row count unchanged (UPDATE, not INSERT)', rowsAfter.length === rowsBefore.length,
        `${rowsBefore.length} → ${rowsAfter.length}`);
      check('same documentId', r.body['documentId'] === firstDocumentId);
      // A repeated GCM nonce under one key is catastrophic; assert it never happens.
      check('ciphertext DIFFERS byte-for-byte (fresh nonce per write)',
        !before.body.equals(after.body));
      check('but decrypts to the same content',
        openDocument(ENVELOPE_KEY, envelopeAad(BUCKET, nationalIdKey), after.body).equals(CLEAN_JPEG));
    }

    console.log('\n── 7. C2PA manifest presence captured in path ──');
    {
      const r = await upload(base, { documentType: 'GOOD_CONDUCT_CERTIFICATE', bytes: jpegWithC2pa() });
      check('201 UPLOADED', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
      const audit = [...bus.published]
        .reverse()
        .find((e) => e.eventType === 'AUDIT_ENTRY') as { metadata?: Record<string, unknown> } | undefined;
      check('audit metadata records c2paManifestPresent=true',
        audit?.metadata?.['c2paManifestPresent'] === true, JSON.stringify(audit?.metadata));
      check('audit metadata records encryptedAtRest=true',
        audit?.metadata?.['encryptedAtRest'] === true);
      // Presence is never promoted to validity by the bounded-real tier.
      const rows = await docRows();
      const row = rows.find((x) => x['document_type'] === 'GOOD_CONDUCT_CERTIFICATE');
      const flags = (row?.['forensics_flags'] ?? {}) as Record<string, unknown>;
      check('stored flags keep c2paManifestValid null (presence ≠ validity)',
        flags['c2paManifestValid'] === null);
    }

    console.log('\n── 8. Malware: nothing at rest, no row, no lane event ──');
    {
      // A plain EICAR TEXT file never even reaches ClamAV — the container gate
      // refuses it. Asserted first so the wrapped case below is meaningful.
      const text = await upload(base, {
        documentType: 'OLEVEL_CERTIFICATE',
        bytes: EICAR,
        mediaType: 'application/pdf',
        filename: 'eicar.pdf',
      });
      check('plain EICAR text → 422 UNSUPPORTED_FILE_CONTENT (refused before any scan)',
        text.status === 422 && text.body['error'] === 'UNSUPPORTED_FILE_CONTENT',
        `${text.status} ${JSON.stringify(text.body)}`);

      const key = deriveObjectKey('RDF', RDF_APP, 'OLEVEL_CERTIFICATE');
      const rowsBefore = (await docRows()).length;
      const forensicsBefore = bus.published.filter(
        (e) => e.eventType === 'DOCUMENT_FORENSICS_COMPLETED').length;
      const auditsBefore = bus.published.filter((e) => e.eventType === 'AUDIT_ENTRY').length;

      const r = await upload(base, { documentType: 'OLEVEL_CERTIFICATE', bytes: EICAR_JPEG });
      check('EICAR-in-JPEG → 422 DOCUMENT_REJECTED_MALWARE (real ClamAV verdict)',
        r.status === 422 && r.body['error'] === 'DOCUMENT_REJECTED_MALWARE',
        `${r.status} ${JSON.stringify(r.body)}`);

      const raw = await rawObject(key);
      check('NOTHING at rest in MinIO (scan before store, ADR-004)', raw.status === 404,
        `raw GET → ${raw.status}`);
      check('NO document_records row (would poison the idempotency key)',
        (await docRows()).length === rowsBefore);
      check('NO DOCUMENT_FORENSICS_COMPLETED (a lane with no row is a poison message)',
        bus.published.filter((e) => e.eventType === 'DOCUMENT_FORENSICS_COMPLETED').length ===
          forensicsBefore);
      check('exactly ONE audit entry for the rejection',
        bus.published.filter((e) => e.eventType === 'AUDIT_ENTRY').length === auditsBefore + 1);

      // The citizen can now upload a clean file for the SAME document type — the
      // rejected attempt left no state to collide with.
      const retry = await upload(base, { documentType: 'OLEVEL_CERTIFICATE', bytes: CLEAN_JPEG });
      check('a clean retry of the SAME document type succeeds', retry.status === 201,
        `${retry.status} ${JSON.stringify(retry.body)}`);
    }

    console.log('\n── 9. Guards: ownership, status, type, content, auth ──');
    {
      const rowsBefore = (await docRows()).length;

      const stranger = await upload(base, {
        applicantId: STRANGER_ID,
        documentType: 'ALEVEL_CERTIFICATE',
      });
      check('another citizen’s application → 404 (identical to nonexistent — no oracle)',
        stranger.status === 404 && stranger.body['error'] === 'APPLICATION_NOT_FOUND',
        `${stranger.status} ${JSON.stringify(stranger.body)}`);

      const ghost = await upload(base, {
        applicationId: '7fdddddd-dddd-4ddd-8ddd-dddddddddddd',
        documentType: 'ALEVEL_CERTIFICATE',
      });
      check('nonexistent application → the SAME 404',
        ghost.status === 404 && ghost.body['error'] === 'APPLICATION_NOT_FOUND');

      await setStatus('REJECTED');
      const closed = await upload(base, { documentType: 'ALEVEL_CERTIFICATE' });
      check('terminal application → 409 NOT_ACCEPTING_DOCUMENTS',
        closed.status === 409 && closed.body['error'] === 'NOT_ACCEPTING_DOCUMENTS',
        `${closed.status} ${JSON.stringify(closed.body)}`);
      await setStatus('SUBMITTED');

      const wrongAgencyType = await upload(base, { documentType: 'CELIBACY_CERTIFICATE' });
      check('RCS-only document type on an RDF application → 422 UNSUPPORTED_DOCUMENT_TYPE',
        wrongAgencyType.status === 422 &&
          wrongAgencyType.body['error'] === 'UNSUPPORTED_DOCUMENT_TYPE',
        `${wrongAgencyType.status} ${JSON.stringify(wrongAgencyType.body)}`);

      const mismatch = await upload(base, {
        documentType: 'ALEVEL_CERTIFICATE',
        bytes: PDF_BYTES,
        mediaType: 'image/png',
        filename: 'claims-to-be-png.png',
      });
      check('PDF bytes declared image/png → 422 CONTENT_TYPE_MISMATCH (polyglot refused)',
        mismatch.status === 422 && mismatch.body['error'] === 'CONTENT_TYPE_MISMATCH',
        `${mismatch.status} ${JSON.stringify(mismatch.body)}`);

      const badMedia = await upload(base, {
        documentType: 'ALEVEL_CERTIFICATE',
        mediaType: 'image/gif',
        filename: 'x.gif',
      });
      check('media type outside FORENSICS_ALLOWED_MIME_TYPES → 422 UNSUPPORTED_FILE_TYPE',
        badMedia.status === 422 && badMedia.body['error'] === 'UNSUPPORTED_FILE_TYPE');

      const empty = await upload(base, { documentType: 'ALEVEL_CERTIFICATE', bytes: Buffer.alloc(0) });
      check('empty file → 400 EMPTY_FILE', empty.status === 400 && empty.body['error'] === 'EMPTY_FILE');

      const wrongField = await upload(base, { fileField: 'document' });
      check('file part under the wrong field name → 400 MISSING_FILE',
        wrongField.status === 400 && wrongField.body['error'] === 'MISSING_FILE');

      const badUuid = await upload(base, { applicationId: 'not-a-uuid' });
      check('malformed applicationId → 400', badUuid.status === 400);

      const unauth = await upload(base, { token: undefined });
      check('no token → 401', unauth.status === 401);

      const officer = await upload(base, { token: OFFICER_TOKEN });
      check('OFFICER token on the citizen ingress → 403 (not an officer injection path)',
        officer.status === 403, `got ${officer.status}`);

      check('no rows written by ANY guard rejection', (await docRows()).length === rowsBefore,
        `${rowsBefore} → ${(await docRows()).length}`);
    }

    console.log('\n── 10. File cap enforced independently of the socket cap ──');
    {
      // 4 KiB file cap + 8 KiB framing budget: a 6 KiB file fits through the
      // TRANSPORT and must still be refused by the CONTRACT.
      const tight = await startHttpServer({
        serviceName: 'document-upload-cap-selfcheck',
        port: 0,
        routes: [
          uploadDocumentRoute(uploadService, verify, {
            maxFileSizeBytes: 4096,
            allowedMediaTypes: ALLOWED_MEDIA_TYPES,
          }),
        ],
      });
      try {
        const r = await upload(tight.url, { documentType: 'DEGREE_DIPLOMA_COPY', bytes: BIG_JPEG });
        check('6 KiB file under a 4 KiB cap → 413 FILE_TOO_LARGE (contract, not socket)',
          r.status === 413 && r.body['error'] === 'FILE_TOO_LARGE',
          `${r.status} ${JSON.stringify(r.body)}`);
      } finally {
        await tight.stop();
      }
    }

    console.log('\n── 11. Scanner down → fail closed ──');
    {
      const downBus = new InMemoryEventBus();
      const downService = new UploadDocumentService({
        ownership: new PgApplicationOwnershipReader(),
        analyzer: new BoundedRealAnalyzer(new DownScanner()),
        objectWriter: new MinioObjectWriter(MINIO, ENVELOPE_KEY),
        recordStore,
        eventBus: downBus,
        bucket: BUCKET,
      });
      const downServer = await startHttpServer({
        serviceName: 'document-upload-down-selfcheck',
        port: 0,
        routes: [
          uploadDocumentRoute(downService, verify, {
            maxFileSizeBytes: MAX_FILE_BYTES,
            allowedMediaTypes: ALLOWED_MEDIA_TYPES,
          }),
        ],
      });
      try {
        const key = deriveObjectKey('RDF', RDF_APP, 'NON_CONVICTION_CERTIFICATE');
        const rowsBefore = (await docRows()).length;
        const r = await upload(downServer.url, { documentType: 'NON_CONVICTION_CERTIFICATE' });
        check('503 SCANNER_UNAVAILABLE', r.status === 503 && r.body['error'] === 'SCANNER_UNAVAILABLE',
          `${r.status} ${JSON.stringify(r.body)}`);
        check('nothing stored in MinIO', (await rawObject(key)).status === 404);
        check('no verdict row written', (await docRows()).length === rowsBefore);
        check('no event emitted', downBus.published.length === 0);
      } finally {
        await downServer.stop();
      }
    }

    console.log('\n── 12. No PII on the backbone ──');
    {
      const serialized = JSON.stringify(bus.published);
      check('no NID hash, no applicant id, no name in any event',
        !serialized.includes(NID_HASH) &&
        !serialized.includes(APPLICANT_ID) &&
        !serialized.toLowerCase().includes('full_name'));
    }
  } finally {
    await server.stop();
    await cleanup();
    await admin.end({ timeout: 5 });
    const { sql } = await import('@usrp/shared-database');
    await sql.end({ timeout: 5 });
  }

  console.log('\n───────────────────────────────────────────');
  if (failures === 0) {
    console.log('UPLOAD INGRESS PROVEN — scanned before stored, sealed at rest, fail-closed ✓');
    process.exit(0);
  }
  console.error(`${failures} ASSERTION(S) FAILED ✗`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('SELF-CHECK CRASHED:', err);
  process.exit(1);
});

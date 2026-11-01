// ══════════════════════════════════════════════════════════════════
// identity-service — Citizen document door, LIVE (ADR-030)
//
// This live integration proof does NOT include Edge. It drives Identity's HTTP
// document door directly and its real downstream chain:
//
//   test caller → identity-service /me/applications/documents
//        → (iam client-credentials token) → document-forensics-service
//        → REAL ClamAV scan → AES-GCM envelope → REAL MinIO → document_records
//
// and asserts the properties that matter at the seam: the subject comes from
// the Identity session, a stranger's application is a 404, D8 revisions and
// review refusals preserve their exact contract, malware is refused with
// nothing stored, and no verdict ever reaches the citizen.
//
//   Tier-1 + ClamAV up, DB bootstrapped:
//   set -a; . ./.env; set +a
//   pnpm --filter @usrp/identity-service exec tsx selfcheck/verify-applicant-document-door.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, hashPassword } from '@usrp/shared-security';
import { makeAuthVerifier } from '@usrp/shared-auth';

const KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PRIVATE_KEY_B64'] = Buffer.from(KEYS.privateKeyPem, 'utf8').toString('base64');
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const { createIamService, loadIamConfig, serviceTokenRoutes } = await import('@usrp/iam-service');
const forensics = await import('@usrp/document-forensics-service');
const {
  createApplicantAuthService,
  loadIdentityConfig,
  applicantDocumentRoutes,
  HttpDocumentUploadGateway,
  PgApplicantAuthRepository,
  LogSmsChannel,
} = await import('../src/index.js');

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
const ENVELOPE_KEY = forensics.deriveEnvelopeKey(
  process.env['MINIO_ENCRYPTION_KEY'] ?? 'selfcheck_document_envelope_key_min_32_chars!!',
);
const BUCKET = 'usrp-upload-selfcheck';
const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA = ['image/jpeg', 'image/png', 'application/pdf'];

const CITIZEN = 'b3000000-0000-4000-8000-000000000001';
const STRANGER = 'b3000000-0000-4000-8000-000000000002';
const CITIZEN_HASH = 'b3'.repeat(32);
const STRANGER_HASH = 'b4'.repeat(32);
const CAMPAIGN = 'b3000000-0000-4000-8000-0000000000c1';
const APP_MINE = 'b3000000-0000-4000-8000-00000000a001';
const APP_THEIRS = 'b3000000-0000-4000-8000-00000000a002';
const APP_ADVANCED = 'b3000000-0000-4000-8000-00000000a003';
const CLIENT_ID = 'selfcheck.doc-door';
const CLIENT_SECRET = 'S3lfcheck#DocDoor!';
const SERVICE_ID = 'b3000000-0000-4000-8000-00000000c001';
const SESSION_TOKEN = 'b3-doc-door-session-token-0123456789abcdef0123456789abcdef';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function jpeg(scanPayload: Buffer): Buffer {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(20, 1)]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), exif]);
  app1.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app1,
    Buffer.from([0xff, 0xda, 0x00, 0x02]), scanPayload, Buffer.from([0xff, 0xd9]),
  ]);
}
const CLEAN = jpeg(Buffer.alloc(64, 0x55));
const CLEAN_REPLACEMENT = jpeg(Buffer.alloc(64, 0x56));
const CLEAN_THIRD = jpeg(Buffer.alloc(64, 0x57));
// ClamAV flags the EICAR test string when it is the file, or inside a PDF
// stream — NOT when it is merely embedded in a JPEG scan or after a header.
// (Measured against the live clamd; the earlier JPEG-wrapped form passed as
// CLEAN, which is correct scanner behaviour, not a hole.)
const EICAR_PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 68 >>\nstream\n'),
  Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
  Buffer.from('\nendstream\nendobj\ntrailer\n%%EOF\n'),
]);

async function cleanup(): Promise<void> {
  const ids = [APP_MINE, APP_THEIRS, APP_ADVANCED];
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    // The live proof writes real append-only history; remove its isolated rows
    // with the same trigger suspension used for the other seeded fixture data.
    await tx`DELETE FROM rdf_ops.document_revisions WHERE application_id IN ${tx(ids)}`;
    await tx`DELETE FROM rdf_ops.document_records WHERE application_id IN ${tx(ids)}`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${tx(ids)}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(ids)}`;
    await tx`DELETE FROM public_core.applicant_sessions WHERE applicant_id IN ${tx([CITIZEN, STRANGER])}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx([CITIZEN, STRANGER])}`;
    await tx`DELETE FROM public_core.service_accounts WHERE client_id = ${CLIENT_ID}`;
  });
  for (const app of [APP_MINE, APP_THEIRS, APP_ADVANCED]) {
    for (const type of ['NATIONAL_ID', 'GOOD_CONDUCT_CERTIFICATE', 'OLEVEL_CERTIFICATE']) {
      await forensics
        .s3Request(MINIO, 'DELETE', forensics.encodeObjectPath(BUCKET, forensics.deriveObjectKey('RDF', app, type as never)), Buffer.alloc(0))
        .catch(() => undefined);
    }
  }
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    for (const [id, hash] of [[CITIZEN, CITIZEN_HASH], [STRANGER, STRANGER_HASH]] as const) {
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
           encrypted_home_district, encrypted_home_province, gender,
           registration_channel, identity_status)
        VALUES (${id}, ${hash}, 'x','x','x','x','MALE','WEB',
                'VERIFIED'::public_core.identity_verification_status)`;
    }
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, public_code, campaign_label, agency, status, target_categories,
         registration_opens_at, registration_closes_at, examination_start_date,
         examination_end_date, examination_reporting_hour)
      VALUES (${CAMPAIGN}, ${`LEGACY-${CAMPAIGN.replaceAll('-', '').toUpperCase()}`},
              'doc door', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
              now() - interval '1 day', now() + interval '30 days', '2026-12-01', '2026-12-10', 7)`;
    await tx`
      INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
      VALUES (${APP_MINE}, 'RDF-97201', ${CITIZEN}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT', 'SUBMITTED'::rdf_ops.application_status),
             (${APP_THEIRS}, 'RDF-97202', ${STRANGER}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT', 'SUBMITTED'::rdf_ops.application_status),
             (${APP_ADVANCED}, 'RDF-97203', ${CITIZEN}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT', 'SUBMITTED'::rdf_ops.application_status)`;
  });
  await admin.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql('usrp_iam_service')}`;
    await tx`
      INSERT INTO public_core.service_accounts (service_id, client_id, credential, description)
      VALUES (${SERVICE_ID}, ${CLIENT_ID}, ${hashPassword(CLIENT_SECRET)}, 'selfcheck document door')`;
  });
}

async function main(): Promise<void> {
  console.log('\n══ identity-service — citizen document door (LIVE, ADR-030) ══');
  // A fresh MinIO (CI) has no buckets: create ours idempotently, exactly as the
  // forensics proofs do. 200 = created, 409 = already there.
  const bucket = await forensics.s3Request(MINIO, 'PUT', `/${BUCKET}`, Buffer.alloc(0));
  check('selfcheck bucket created (or already exists)', bucket.status === 200 || bucket.status === 409, `PUT bucket → ${String(bucket.status)}`);
  await cleanup();
  await seed();

  const iam = createIamService(loadIamConfig(), new InMemoryEventBus());
  const iamServer = await startHttpServer({
    serviceName: 'iam-doc-door', port: 0, host: '127.0.0.1',
    routes: serviceTokenRoutes(iam.serviceToken), handleSignals: false,
  });

  const forensicsBus = new InMemoryEventBus();
  const verify = makeAuthVerifier({ publicKeyPem: KEYS.publicKeyPem, issuer: 'usrp', audience: 'usrp-services' });
  const uploadService = new forensics.UploadDocumentService({
    ownership: new forensics.PgApplicationOwnershipReader(),
    analyzer: new forensics.BoundedRealAnalyzer(new forensics.ClamavVirusScanner(SCANNER)),
    objectWriter: new forensics.MinioObjectWriter(MINIO, ENVELOPE_KEY),
    recordStore: new forensics.PgDocumentRecordStore(),
    eventBus: forensicsBus,
    bucket: BUCKET,
    // D8: the KEYED content digest key.
    contentHmacKey: process.env['FORENSICS_CONTENT_HMAC_KEY'] ?? 'selfcheck_document_content_hmac_key_min_32!',
  });
  // The forensics service verifies tokens against the iam test key pair.
  const forensicsServer = await startHttpServer({
    serviceName: 'forensics-doc-door', port: 0, host: '127.0.0.1',
    routes: [forensics.uploadDocumentRoute(uploadService, verify, { maxFileSizeBytes: MAX_BYTES, allowedMediaTypes: MEDIA })],
    handleSignals: false,
  });

  const idConfig = loadIdentityConfig();
  const applicantAuth = createApplicantAuthService(idConfig, new InMemoryEventBus(), new LogSmsChannel());
  const gateway = new HttpDocumentUploadGateway({
    iamBaseUrl: iamServer.url,
    forensicsBaseUrl: forensicsServer.url,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  const idServer = await startHttpServer({
    serviceName: 'identity-doc-door', port: 0, host: '127.0.0.1',
    routes: applicantDocumentRoutes(applicantAuth, gateway, { maxFileSizeBytes: MAX_BYTES, allowedMediaTypes: MEDIA }),
    handleSignals: false,
  });
  console.log(`iam ${iamServer.url} · forensics ${forensicsServer.url} · identity ${idServer.url}`);

  await new PgApplicantAuthRepository(idConfig.security.encryptionKey).createSession({
    applicantId: CITIZEN,
    sessionToken: SESSION_TOKEN,
    channel: 'WEB',
    expiresAt: new Date(Date.now() + 600_000),
  });

  async function upload(
    parts: Record<string, string | Blob>,
    token: string | null = SESSION_TOKEN,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const form = new FormData();
    for (const [k, v] of Object.entries(parts)) {
      if (typeof v === 'string') form.append(k, v);
      else form.append(k, v, 'scan.jpg');
    }
    const res = await fetch(`${idServer.url}/v1/applicants/me/applications/documents`, {
      method: 'POST',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { json = {}; }
    return { status: res.status, text, json };
  }
  const docRows = (app: string): Promise<{
    id: string;
    document_type: string;
    revision: number;
    virus_scan_status: string | null;
    human_reviewed_at: Date | null;
  }[]> => admin`
    SELECT id, document_type::text, revision, virus_scan_status, human_reviewed_at
    FROM rdf_ops.document_records WHERE application_id = ${app}`;
  const revisionHistory = (documentId: string): Promise<{
    revision: number;
    file_size_bytes: number;
    mime_type: string;
    uploaded_at: Date;
  }[]> => admin`
    SELECT revision, file_size_bytes, mime_type, uploaded_at
    FROM rdf_ops.document_revisions WHERE document_id = ${documentId} ORDER BY revision`;
  const documentSnapshot = async (app: string, documentType: string) => {
    const row = (await docRows(app)).find((candidate) => candidate.document_type === documentType);
    const history = row === undefined ? [] : await revisionHistory(row.id);
    const key = forensics.deriveObjectKey('RDF', app, documentType as never);
    const object = await forensics.s3Request(MINIO, 'GET', forensics.encodeObjectPath(BUCKET, key), Buffer.alloc(0));
    return {
      documentId: row?.id ?? null,
      revision: row?.revision ?? null,
      humanReviewedAt: row?.human_reviewed_at?.toISOString() ?? null,
      history: history.map((entry) => ({
        revision: entry.revision,
        fileSizeBytes: entry.file_size_bytes,
        mimeType: entry.mime_type,
        uploadedAt: entry.uploaded_at.toISOString(),
      })),
      objectStatus: object.status,
      objectBytes: object.body,
    };
  };
  const sameDocumentSnapshot = (before: Awaited<ReturnType<typeof documentSnapshot>>, after: Awaited<ReturnType<typeof documentSnapshot>>): boolean =>
    before.documentId === after.documentId &&
    before.revision === after.revision &&
    before.humanReviewedAt === after.humanReviewedAt &&
    JSON.stringify(before.history) === JSON.stringify(after.history) &&
    before.objectStatus === after.objectStatus &&
    before.objectBytes.equals(after.objectBytes);
  const jpg = (b: Buffer): Blob => new Blob([b], { type: 'image/jpeg' });
  const pdf = (b: Buffer): Blob => new Blob([b], { type: 'application/pdf' });

  try {
    console.log('\n── 1. First upload, replacement and identical retry (D8) ──');
    const ok = await upload({ applicationId: APP_MINE, documentType: 'NATIONAL_ID', file: jpg(CLEAN) });
    check('clean JPEG → 201 UPLOADED revision 1',
      ok.status === 201 && ok.json['status'] === 'UPLOADED' && ok.json['revision'] === 1, ok.text);
    check('response is exactly { status, documentId, documentType, revision }',
      Object.keys(ok.json).sort().join(',') === 'documentId,documentType,revision,status', ok.text);
    check('no lane / score / flags / verdict / digest reached the citizen',
      !/lane|score|flag|forensic|verdict|GREEN|AMBER|RED|contentHmac/i.test(ok.text), ok.text);
    let rows = await docRows(APP_MINE);
    check('one revision-1 document_records row, scanned by ClamAV',
      rows.length === 1 && rows[0]?.revision === 1 && rows[0]?.virus_scan_status !== null, JSON.stringify(rows));
    const documentId = typeof ok.json['documentId'] === 'string' ? ok.json['documentId'] : '';
    const initialHistory = documentId === '' ? [] : await revisionHistory(documentId);
    check('first upload appends revision 1 to the internal history',
      initialHistory.length === 1 && initialHistory[0]?.revision === 1);
    const key = forensics.deriveObjectKey('RDF', APP_MINE, 'NATIONAL_ID');
    const stored = await forensics.s3Request(MINIO, 'GET', forensics.encodeObjectPath(BUCKET, key), Buffer.alloc(0));
    check('the object is at rest in MinIO and SEALED (not the plaintext JPEG)',
      stored.status === 200 && forensics.isSealed(stored.body) && !stored.body.includes(CLEAN));

    const replaced = await upload({ applicationId: APP_MINE, documentType: 'NATIONAL_ID', file: jpg(CLEAN_REPLACEMENT) });
    check('different replacement bytes → same documentId, revision 2',
      replaced.status === 201 && replaced.json['documentId'] === documentId && replaced.json['revision'] === 2, replaced.text);
    rows = await docRows(APP_MINE);
    const replacedHistory = documentId === '' ? [] : await revisionHistory(documentId);
    check('different bytes update the slot to revision 2 and append revision history [1, 2]',
      rows.length === 1 && rows[0]?.revision === 2 && replacedHistory.map((entry) => entry.revision).join(',') === '1,2');

    const retry = await upload({ applicationId: APP_MINE, documentType: 'NATIONAL_ID', file: jpg(CLEAN_REPLACEMENT) });
    const retryHistory = documentId === '' ? [] : await revisionHistory(documentId);
    check('identical bytes are a retry at revision 2, not revision 3',
      retry.status === 201 && retry.json['documentId'] === documentId && retry.json['revision'] === 2 &&
      retryHistory.map((entry) => entry.revision).join(',') === '1,2', retry.text);

    console.log('\n── 2. A reviewed document refuses replacement without changing evidence ──');
    await admin`
      UPDATE rdf_ops.document_records SET human_reviewed_at = now()
      WHERE application_id = ${APP_MINE} AND document_type = 'NATIONAL_ID'::rdf_ops.document_type`;
    const beforeReviewedRefusal = await documentSnapshot(APP_MINE, 'NATIONAL_ID');
    const reviewed = await upload({ applicationId: APP_MINE, documentType: 'NATIONAL_ID', file: jpg(CLEAN_THIRD) });
    check('reviewed document → 409 DOCUMENT_REVIEW_CLOSED / HUMAN_REVIEWED',
      reviewed.status === 409 && reviewed.json['error'] === 'DOCUMENT_REVIEW_CLOSED' &&
      reviewed.json['reason'] === 'HUMAN_REVIEWED', reviewed.text);
    check('closed-review response has only the approved fields',
      Object.keys(reviewed.json).sort().join(',') === 'error,reason,status', reviewed.text);
    const afterReviewedRefusal = await documentSnapshot(APP_MINE, 'NATIONAL_ID');
    check('HUMAN_REVIEWED refusal leaves stored bytes, revision 2 and history unchanged',
      sameDocumentSnapshot(beforeReviewedRefusal, afterReviewedRefusal),
      `before revision=${String(beforeReviewedRefusal.revision)} history=${String(beforeReviewedRefusal.history.length)}; after revision=${String(afterReviewedRefusal.revision)} history=${String(afterReviewedRefusal.history.length)}`);

    console.log('\n── 3. Malware is refused by the real scanner; nothing is stored ──');
    const bad = await upload({ applicationId: APP_MINE, documentType: 'GOOD_CONDUCT_CERTIFICATE', file: pdf(EICAR_PDF) });
    check('EICAR in a PDF stream → 422 DOCUMENT_REJECTED_MALWARE (real clamd)', bad.status === 422 && bad.json['error'] === 'DOCUMENT_REJECTED_MALWARE', bad.text);
    check('no row written for it', (await docRows(APP_MINE)).length === 1);
    const badKey = forensics.deriveObjectKey('RDF', APP_MINE, 'GOOD_CONDUCT_CERTIFICATE');
    check('nothing at rest for it',
      (await forensics.s3Request(MINIO, 'GET', forensics.encodeObjectPath(BUCKET, badKey), Buffer.alloc(0))).status === 404);

    console.log('\n── 4. The subject is the session ──');
    const theirs = await upload({ applicationId: APP_THEIRS, documentType: 'NATIONAL_ID', file: jpg(CLEAN) });
    check("another citizen's application → 404 APPLICATION_NOT_FOUND", theirs.status === 404 && theirs.json['error'] === 'APPLICATION_NOT_FOUND', theirs.text);
    check('…and nothing was written under it', (await docRows(APP_THEIRS)).length === 0);
    const forged = await upload({ applicantId: STRANGER, applicationId: APP_MINE, documentType: 'OLEVEL_CERTIFICATE', file: jpg(CLEAN) });
    check('a supplied applicantId part is refused (400)', forged.status === 400, forged.text);
    check('no session → 401', (await upload({ applicationId: APP_MINE, documentType: 'NATIONAL_ID', file: jpg(CLEAN) }, null)).status === 401);
    check('a garbage session → 401', (await upload({ applicationId: APP_MINE, documentType: 'NATIONAL_ID', file: jpg(CLEAN) }, 'nope')).status === 401);

    console.log('\n── 5. An advanced case refuses replacement without changing evidence (D8) ──');
    const advancedFirst = await upload({
      applicationId: APP_ADVANCED, documentType: 'GOOD_CONDUCT_CERTIFICATE', file: jpg(CLEAN),
    });
    check('first upload on the advanced-case fixture is revision 1',
      advancedFirst.status === 201 && advancedFirst.json['revision'] === 1, advancedFirst.text);
    await admin`UPDATE rdf_ops.applications SET status = 'SLOT_ASSIGNED'::rdf_ops.application_status WHERE id = ${APP_ADVANCED}`;
    const beforeAdvancedRefusal = await documentSnapshot(APP_ADVANCED, 'GOOD_CONDUCT_CERTIFICATE');
    const advanced = await upload({
      applicationId: APP_ADVANCED, documentType: 'GOOD_CONDUCT_CERTIFICATE', file: jpg(CLEAN_REPLACEMENT),
    });
    check('advanced case → 409 DOCUMENT_REVIEW_CLOSED / CASE_ADVANCED',
      advanced.status === 409 && advanced.json['error'] === 'DOCUMENT_REVIEW_CLOSED' &&
      advanced.json['reason'] === 'CASE_ADVANCED', advanced.text);
    const afterAdvancedRefusal = await documentSnapshot(APP_ADVANCED, 'GOOD_CONDUCT_CERTIFICATE');
    check('CASE_ADVANCED refusal leaves stored bytes, revision 1 and history unchanged',
      sameDocumentSnapshot(beforeAdvancedRefusal, afterAdvancedRefusal),
      `before revision=${String(beforeAdvancedRefusal.revision)} history=${String(beforeAdvancedRefusal.history.length)}; after revision=${String(afterAdvancedRefusal.revision)} history=${String(afterAdvancedRefusal.history.length)}`);

    console.log('\n── 6. Other business refusals stay closed and specific ──');
    const wrongType = await upload({ applicationId: APP_MINE, documentType: 'CELIBACY_CERTIFICATE', file: jpg(CLEAN) });
    check("a type the agency does not accept → 422 UNSUPPORTED_DOCUMENT_TYPE", wrongType.status === 422 && wrongType.json['error'] === 'UNSUPPORTED_DOCUMENT_TYPE', wrongType.text);
    await admin`UPDATE rdf_ops.applications SET status = 'WITHDRAWN'::rdf_ops.application_status WHERE id = ${APP_MINE}`;
    const closed = await upload({ applicationId: APP_MINE, documentType: 'OLEVEL_CERTIFICATE', file: jpg(CLEAN) });
    check('a withdrawn application → 409 NOT_ACCEPTING_DOCUMENTS', closed.status === 409 && closed.json['error'] === 'NOT_ACCEPTING_DOCUMENTS', closed.text);
  } finally {
    await cleanup();
    await Promise.all([idServer.stop(), forensicsServer.stop(), iamServer.stop()]);
    await admin.end();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('IDENTITY → FORENSICS DOCUMENT DOOR PROVEN (live: Identity → IAM token → Forensics → ClamAV → MinIO → PostgreSQL; Edge not included) ✓');
  else {
    console.error(`${String(failures)} assertion(s) FAILED`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('SELF-CHECK CRASHED:', err);
  process.exit(1);
});

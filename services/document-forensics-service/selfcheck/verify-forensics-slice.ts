// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Live forensics slice self-check
//
// Proves the amber lane's front half against REAL infrastructure — live
// PostgreSQL, live MinIO (hand-rolled SigV4), live ClamAV (clamd INSTREAM),
// and a real HTTP socket:
//   • pure domain: composeVerdict/probeBytes across container/metadata/C2PA
//     permutations (deterministic, no infra);
//   • EICAR object → RED lane, virusScanClean=false, score 0;
//   • clean JPEG WITH metadata → GREEN; stripped JPEG → AMBER;
//     unknown container → AMBER; deferred flags all null (never false);
//   • verdict persisted on the owning agency's document_records; re-analysis
//     UPDATEs the same row (idempotent — no duplicate rows);
//   • DOCUMENT_FORENSICS_COMPLETED + ONE AUDIT_ENTRY emitted, PII-free;
//   • cross-agency guard: RNP-claimed analyze of an RDF app → 404, no write;
//   • missing object → 404 OBJECT_NOT_FOUND, no write, no event;
//   • scanner down (stub) → 503 SCANNER_UNAVAILABLE, no write, no event;
//   • 401 unauthenticated / 403 officer-token (system-only ingress).
//
// The proof SEEDS its objects with a local SigV4 PUT helper — deliberately
// kept HERE and not in the service: the ObjectStore port stays GET-only
// (owner decision D3; upload belongs to the future portal slice).
//
//   bash scripts/run-selfchecks.sh   (or standalone with the env below)
// ══════════════════════════════════════════════════════════════════

import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import type { DocumentForensicsCompletedEvent, ForensicsFlags } from '@usrp/shared-types';
import {
  AnalyzeDocumentService,
  BoundedRealAnalyzer,
  ClamavVirusScanner,
  MinioObjectStore,
  PgDocumentRecordStore,
  analyzeDocumentRoute,
  composeVerdict,
  probeBytes,
  ANALYZE_DOCUMENT_PATH,
  type VirusScanner,
  type ScanResult,
} from '../src/index.js';

// ── Environment ───────────────────────────────────────────────────

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
const BUCKET = 'usrp-forensics-selfcheck';

const APPLICANT_ID = '7f7f7f7f-7f7f-4f7f-8f7f-7f7f7f7f7f7f';
const NID_HASH = 'f0'.repeat(32);
const RDF_APP = '7fa11111-1111-4111-8111-111111111111';
const RDF_CAMPAIGN = '7fc11111-1111-4111-8111-111111111111';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Proof-only SigV4 helpers (PUT + bucket create; service stays GET-only) ──

function sigv4Headers(method: string, path: string, payload: Buffer): Record<string, string> {
  const host = `${MINIO.endpoint}:${MINIO.port}`;
  const amzDate = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const kDate = createHmac('sha256', `AWS4${MINIO.secretKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update('us-east-1').digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    Host: host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${MINIO.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function s3Request(method: string, path: string, payload: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: MINIO.endpoint, port: MINIO.port, path, method,
        headers: { ...sigv4Headers(method, path, payload), 'Content-Length': payload.length },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function seedObject(key: string, bytes: Buffer): Promise<void> {
  const status = await s3Request('PUT', `/${BUCKET}/${key}`, bytes);
  if (status !== 200) throw new Error(`seed PUT ${key} → ${status}`);
}

// ── Fixture documents (real byte structures) ─────────────────────

/** Minimal structurally-valid JPEG: SOI + APP1(EXIF) + SOS + EOI. */
function jpegWithExif(): Buffer {
  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(20, 1)]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, 0, 0]), exifPayload,
  ]);
  app1.writeUInt16BE(exifPayload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(16, 0x55), Buffer.from([0xff, 0xd9]),
  ]);
}

/** JPEG with no APP segments at all — a "laundered"/stripped file. */
function jpegStripped(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(16, 0x55), Buffer.from([0xff, 0xd9]),
  ]);
}

/** JPEG carrying a JUMBF (C2PA) APP11 segment plus EXIF. */
function jpegWithC2pa(): Buffer {
  const jumbf = Buffer.concat([Buffer.from('JP'), Buffer.alloc(24, 2)]);
  const app11 = Buffer.concat([Buffer.from([0xff, 0xeb, 0, 0]), jumbf]);
  app11.writeUInt16BE(jumbf.length + 2, 2);
  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(8, 1)]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), exifPayload]);
  app1.writeUInt16BE(exifPayload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app1, app11,
    Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(16, 0x55), Buffer.from([0xff, 0xd9]),
  ]);
}

/** The EICAR standard antivirus test string — every scanner flags it. */
const EICAR = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);

// ── DB seed / teardown ────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.document_records WHERE application_id = ${RDF_APP}`;
    await tx`DELETE FROM rdf_ops.application_status_history
             WHERE application_id = ${RDF_APP}`;
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
    VALUES (${RDF_CAMPAIGN}, 'Forensics slice RDF', 'RDF', 'REGISTRATION_OPEN',
            '["GENERAL_ENLISTMENT"]', now() - interval '1 day', now() + interval '30 days',
            '2026-10-01', '2026-10-15', 7)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RDF_APP}, 'RDF-97001', ${APPLICANT_ID}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
            'SUBMITTED'::rdf_ops.application_status)`;
}

async function docRows(): Promise<Record<string, unknown>[]> {
  return await admin<Record<string, unknown>[]>`
    SELECT id, document_type, minio_object_key, virus_scan_status, forensics_score,
           forensics_lane, forensics_flags, forensics_completed_at, file_size_bytes
    FROM rdf_ops.document_records WHERE application_id = ${RDF_APP}
    ORDER BY created_at`;
}

// ── Auth fixtures ─────────────────────────────────────────────────

const AUTH_KEYS = generateDeviceKeyPair();
function mint(kind: 'system' | 'officer'): string {
  const base = {
    v: 1 as const, iss: 'usrp', aud: 'usrp-services',
    sub: kind === 'officer' ? '7e111111-1111-4111-8111-111111111111' : 'selfcheck-system',
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency: 'RDF', roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}
const SYSTEM_TOKEN = mint('system');
const OFFICER_TOKEN = mint('officer');

// ── HTTP helper ───────────────────────────────────────────────────

interface HttpReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function post(baseUrl: string, body: unknown, token?: string): Promise<HttpReply> {
  const res = await fetch(`${baseUrl}${ANALYZE_DOCUMENT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, body: parsed };
}

class DownScanner implements VirusScanner {
  async scan(): Promise<ScanResult> {
    return { kind: 'UNAVAILABLE', detail: 'stubbed outage' };
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n══ document-forensics-service — live slice self-check ══');

  // ── 1. Pure domain: composeVerdict + probeBytes (no infra) ──
  console.log('\n── 1. Pure verdict composition ──');
  {
    const clean = probeBytes(jpegWithExif());
    check('JPEG w/ EXIF: container=JPEG', clean.container === 'JPEG');
    check('JPEG w/ EXIF: metadata present', clean.hasEmbeddedMetadata);
    const v1 = composeVerdict({ virusClean: true, bytes: clean });
    check('clean JPEG w/ metadata → GREEN 100', v1.lane === 'GREEN' && v1.score === 100);

    const stripped = probeBytes(jpegStripped());
    check('stripped JPEG: metadata absent', !stripped.hasEmbeddedMetadata);
    const v2 = composeVerdict({ virusClean: true, bytes: stripped });
    check('stripped JPEG → AMBER 65', v2.lane === 'AMBER' && v2.score === 65, `got ${v2.lane} ${v2.score}`);
    check('stripped flag set', v2.flags.metadataStripped === true);

    const c2pa = probeBytes(jpegWithC2pa());
    check('C2PA JPEG: manifest detected', c2pa.hasC2paManifest);
    const v3 = composeVerdict({ virusClean: true, bytes: c2pa });
    check('C2PA JPEG → GREEN capped 100', v3.lane === 'GREEN' && v3.score === 100);
    check('c2paManifestValid stays null (presence ≠ validity)', v3.flags.c2paManifestValid === null);

    const unknown = probeBytes(Buffer.from('not a real document'));
    check('unknown container detected', unknown.container === 'UNKNOWN');
    const v4 = composeVerdict({ virusClean: true, bytes: unknown });
    check('unknown container → AMBER 55', v4.lane === 'AMBER' && v4.score === 55, `got ${v4.lane} ${v4.score}`);

    const v5 = composeVerdict({ virusClean: false, bytes: clean });
    check('infected → RED 0 regardless of container', v5.lane === 'RED' && v5.score === 0);
    const deferredNull = (f: ForensicsFlags): boolean =>
      f.elaAnomalyDetected === null && f.fontMismatchDetected === null &&
      f.stampCloneDetected === null && f.ganGeneratedDetected === null;
    check('deferred perceptual flags are null on every verdict (never false-clean)',
      [v1, v2, v3, v4, v5].every((v) => deferredNull(v.flags)));
  }

  // ── 2. Infra prep ──
  console.log('\n── 2. Seeding MinIO bucket + PG fixtures ──');
  const bucketStatus = await s3Request('PUT', `/${BUCKET}`, Buffer.alloc(0));
  check('bucket created (or already exists)', bucketStatus === 200 || bucketStatus === 409,
    `PUT bucket → ${bucketStatus}`);
  await seedObject('docs/clean.jpg', jpegWithExif());
  await seedObject('docs/stripped.jpg', jpegStripped());
  await seedObject('docs/eicar.bin', EICAR);
  console.log('  ✓ objects seeded (clean.jpg, stripped.jpg, eicar.bin)');
  await cleanup();
  await seed();
  console.log('  ✓ PG fixtures seeded');

  // ── 3. Real service over a real socket ──
  const bus = new InMemoryEventBus();
  const service = new AnalyzeDocumentService({
    objectStore: new MinioObjectStore(MINIO),
    analyzer: new BoundedRealAnalyzer(new ClamavVirusScanner(SCANNER)),
    recordStore: new PgDocumentRecordStore(),
    eventBus: bus,
  });
  const verify = makeAuthVerifier({
    publicKeyPem: AUTH_KEYS.publicKeyPem, issuer: 'usrp', audience: 'usrp-services',
  });
  const server = await startHttpServer({
    serviceName: 'document-forensics-selfcheck',
    port: 0,
    routes: [analyzeDocumentRoute(service, verify)],
  });
  const base = server.url;

  try {
    console.log('\n── 3. EICAR → RED (real ClamAV verdict) ──');
    {
      const r = await post(base, {
        applicationId: RDF_APP, agency: 'RDF', documentType: 'NATIONAL_ID',
        objectBucket: BUCKET, objectKey: 'docs/eicar.bin',
      }, SYSTEM_TOKEN);
      check('200 ANALYZED', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
      check('lane RED', r.body['lane'] === 'RED');
      check('score 0', r.body['forensicsScore'] === 0);
      const flags = (r.body['flags'] ?? {}) as Record<string, unknown>;
      check('virusScanClean false', flags['virusScanClean'] === false);
      const rows = await docRows();
      check('one document_records row', rows.length === 1);
      check('row: INFECTED + RED + score 0',
        rows[0]?.['virus_scan_status'] === 'INFECTED' &&
        rows[0]?.['forensics_lane'] === 'RED' && rows[0]?.['forensics_score'] === 0);
    }

    console.log('\n── 4. Clean JPEG → GREEN; stripped → AMBER ──');
    {
      const r1 = await post(base, {
        applicationId: RDF_APP, agency: 'RDF', documentType: 'OLEVEL_CERTIFICATE',
        objectBucket: BUCKET, objectKey: 'docs/clean.jpg',
      }, SYSTEM_TOKEN);
      check('clean.jpg → 200 GREEN 100', r1.status === 200 && r1.body['lane'] === 'GREEN' && r1.body['forensicsScore'] === 100);

      const r2 = await post(base, {
        applicationId: RDF_APP, agency: 'RDF', documentType: 'GOOD_CONDUCT_CERTIFICATE',
        objectBucket: BUCKET, objectKey: 'docs/stripped.jpg',
      }, SYSTEM_TOKEN);
      check('stripped.jpg → 200 AMBER', r2.status === 200 && r2.body['lane'] === 'AMBER');
      const rows = await docRows();
      check('three rows (one per object)', rows.length === 3, `got ${rows.length}`);
      const amberRow = rows.find((row) => row['minio_object_key'] === 'docs/stripped.jpg');
      const amberFlags = (amberRow?.['forensics_flags'] ?? {}) as Record<string, unknown>;
      check('stored flags: metadataStripped=true, deferred=null',
        amberFlags['metadataStripped'] === true && amberFlags['elaAnomalyDetected'] === null);
    }

    console.log('\n── 5. Re-analysis is idempotent (same row UPDATEd) ──');
    {
      const before = await docRows();
      const r = await post(base, {
        applicationId: RDF_APP, agency: 'RDF', documentType: 'OLEVEL_CERTIFICATE',
        objectBucket: BUCKET, objectKey: 'docs/clean.jpg',
      }, SYSTEM_TOKEN);
      const after = await docRows();
      check('re-analyze → 200', r.status === 200);
      check('row count unchanged', after.length === before.length,
        `${before.length} → ${after.length}`);
      const beforeId = before.find((x) => x['minio_object_key'] === 'docs/clean.jpg')?.['id'];
      const afterId = after.find((x) => x['minio_object_key'] === 'docs/clean.jpg')?.['id'];
      check('same document id (UPDATE not INSERT)', beforeId === afterId);
    }

    console.log('\n── 6. Events: forensics result + audit, PII-free ──');
    {
      const forensics = bus.published.filter(
        (e): e is DocumentForensicsCompletedEvent => e.eventType === 'DOCUMENT_FORENSICS_COMPLETED');
      const audits = bus.published.filter((e) => e.eventType === 'AUDIT_ENTRY');
      check('4 forensics events (3 objects + 1 re-analysis)', forensics.length === 4,
        `got ${forensics.length}`);
      check('4 audit entries (one per genuine analysis)', audits.length === 4, `got ${audits.length}`);
      const sample = forensics[0];
      check('event carries applicationId + lane + score + flags',
        sample !== undefined && sample.applicationId === RDF_APP &&
        typeof sample.forensicsScore === 'number' && typeof sample.flags === 'object');
      const serialized = JSON.stringify(bus.published);
      check('no PII in any event (no NID hash, no applicant name)',
        !serialized.includes(NID_HASH) && !serialized.toLowerCase().includes('full_name'));
    }

    console.log('\n── 7. Guards: cross-agency, missing object, unsupported type, auth ──');
    {
      const cross = await post(base, {
        applicationId: RDF_APP, agency: 'RNP', documentType: 'NATIONAL_ID',
        objectBucket: BUCKET, objectKey: 'docs/clean.jpg',
      }, SYSTEM_TOKEN);
      check('RNP-claimed RDF app → 404 APPLICATION_NOT_FOUND',
        cross.status === 404 && cross.body['error'] === 'APPLICATION_NOT_FOUND');

      const missing = await post(base, {
        applicationId: RDF_APP, agency: 'RDF', documentType: 'NATIONAL_ID',
        objectBucket: BUCKET, objectKey: 'docs/does-not-exist.pdf',
      }, SYSTEM_TOKEN);
      check('missing object → 404 OBJECT_NOT_FOUND',
        missing.status === 404 && missing.body['error'] === 'OBJECT_NOT_FOUND');

      const unsupported = await post(base, {
        applicationId: RDF_APP, agency: 'RDF', documentType: 'CELIBACY_CERTIFICATE',
        objectBucket: BUCKET, objectKey: 'docs/clean.jpg',
      }, SYSTEM_TOKEN);
      check('RCS-only type on RDF → 422 UNSUPPORTED_DOCUMENT_TYPE',
        unsupported.status === 422 && unsupported.body['error'] === 'UNSUPPORTED_DOCUMENT_TYPE');

      const rowsBefore = (await docRows()).length;
      check('no rows written by any guard rejection', rowsBefore === 3);

      const unauth = await post(base, { applicationId: RDF_APP });
      check('no token → 401', unauth.status === 401);
      const officer = await post(base, {
        applicationId: RDF_APP, agency: 'RDF', documentType: 'NATIONAL_ID',
        objectBucket: BUCKET, objectKey: 'docs/clean.jpg',
      }, OFFICER_TOKEN);
      check('officer token on system route → 403', officer.status === 403);

      const badId = await post(base, {
        applicationId: 'not-a-uuid', agency: 'RDF', documentType: 'NATIONAL_ID',
        objectBucket: BUCKET, objectKey: 'docs/clean.jpg',
      }, SYSTEM_TOKEN);
      check('malformed applicationId → 400', badId.status === 400);
    }

    console.log('\n── 8. Scanner down → fail closed (no verdict, no event) ──');
    {
      const downBus = new InMemoryEventBus();
      const downService = new AnalyzeDocumentService({
        objectStore: new MinioObjectStore(MINIO),
        analyzer: new BoundedRealAnalyzer(new DownScanner()),
        recordStore: new PgDocumentRecordStore(),
        eventBus: downBus,
      });
      const downServer = await startHttpServer({
        serviceName: 'forensics-down-selfcheck',
        port: 0,
        routes: [analyzeDocumentRoute(downService, verify)],
      });
      try {
        const rowsBefore = (await docRows()).length;
        const r = await post(downServer.url, {
          applicationId: RDF_APP, agency: 'RDF', documentType: 'NATIONAL_ID',
          objectBucket: BUCKET, objectKey: 'docs/clean.jpg',
        }, SYSTEM_TOKEN);
        check('503 SCANNER_UNAVAILABLE', r.status === 503 && r.body['error'] === 'SCANNER_UNAVAILABLE');
        check('no verdict row written', (await docRows()).length === rowsBefore);
        check('no event emitted', downBus.published.length === 0);
      } finally {
        await downServer.stop();
      }
    }
  } finally {
    await server.stop();
    await cleanup();
    await admin.end({ timeout: 5 });
    const { sql } = await import('@usrp/shared-database');
    await sql.end({ timeout: 5 });
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) {
    console.log('FORENSICS SLICE PROVEN — real bytes, real scan, real store, fail-closed ✓');
    process.exit(0);
  }
  console.error(`${failures} ASSERTION(S) FAILED ✗`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('SELF-CHECK CRASHED:', err);
  process.exit(1);
});

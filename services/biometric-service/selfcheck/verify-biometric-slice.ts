// ══════════════════════════════════════════════════════════════════
// biometric-service — Live check-in gate + identity-persistence self-check
//
// Proves the exam-day biometric gate end-to-end:
//   • an officer with a valid signed QR → 200, verified true (mock passing
//     scores); BIOMETRIC_VERIFICATION_COMPLETED emitted (scores only, no
//     captureRef); first real consumer of verifySlotInvitation;
//   • below-threshold scores → verified false (fail-closed);
//   • a garbage/forged QR → 422 INVALID_INVITATION;
//   • an officer of a DIFFERENT agency than the QR → 403 AGENCY_MISMATCH;
//   • unauthenticated → 401; system token → 403 (officer-only route);
//   • identity-service records the outcome onto applicant_identities.biometric_*.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/biometric-service/selfcheck/verify-biometric-slice.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, signSlotInvitation } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import type { SlotInvitationClaims } from '@usrp/shared-types';
import {
  VerifyBiometricService,
  verifyBiometricRoute,
  MockBiometricMatcher,
  VERIFY_BIOMETRIC_PATH,
  type BiometricMatcher,
  type CaptureReference,
  type BiometricScores,
} from '../src/index.js';
import { createBiometricResultProjector, loadIdentityConfig } from '@usrp/identity-service';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const APPLICANT_ID = '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b';
const THRESHOLDS = { livenessThreshold: 0.85, faceMatchThreshold: 85.0 };

// identity config needs its usual security env for the projector construction.
process.env['NATIONAL_ID_HMAC_KEY'] ??= 'dev_national_id_hmac_key_min_32_chars!!';
process.env['PII_ENCRYPTION_KEY'] ??= 'dev_pii_encryption_key_min_32_chars_ok!!';
process.env['NIDA_BASE_URL'] ??= 'http://localhost:3100';
process.env['NIDA_HMAC_SECRET'] ??= 'dev_nida_hmac_secret';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

class StubMatcher implements BiometricMatcher {
  constructor(private readonly scores: BiometricScores) {}
  async match(_c: CaptureReference): Promise<BiometricScores> {
    return this.scores;
  }
}

const QR_KEYS = generateDeviceKeyPair();
const AUTH_KEYS = generateDeviceKeyPair();
// identity config (loaded in section 4) validates AUTH_JWT_PUBLIC_KEY_B64 at
// boot — give it the real selfcheck auth public key.
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(AUTH_KEYS.publicKeyPem, 'utf8').toString('base64');

function qrToken(agency: 'RDF' | 'RNP', applicantId = APPLICANT_ID): string {
  const claims: SlotInvitationClaims = {
    v: 1, keyId: 'test-qr', ticketId: `${agency}-99001`,
    applicationId: '9a111111-1111-4111-8111-111111111111',
    applicantId, agency, campaignId: '9c111111-1111-4111-8111-111111111111',
    slotId: '9d111111-1111-4111-8111-111111111111', venueName: 'ULK Stadium',
    examDate: '2099-09-10', reportingTimeHour: 7,
    issuedAt: '2026-07-10T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  };
  return signSlotInvitation(QR_KEYS.privateKeyPem, claims);
}

function token(kind: 'officer' | 'system', agency: 'RDF' | 'RNP' = 'RDF'): string {
  const base = {
    v: 1 as const, iss: 'usrp', aud: 'usrp-services', sub: `selfcheck-${kind}`,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency, roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

async function main(): Promise<void> {
  const bus = new InMemoryEventBus();
  const verify = makeAuthVerifier({
    publicKeyPem: AUTH_KEYS.publicKeyPem,
    issuer: 'usrp',
    audience: 'usrp-services',
  });
  const passService = new VerifyBiometricService({
    matcher: new MockBiometricMatcher(),
    qrInvitationPublicKeyPem: QR_KEYS.publicKeyPem,
    thresholds: THRESHOLDS,
    eventBus: bus,
  });

  const server = await startHttpServer({
    serviceName: 'biometric-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [verifyBiometricRoute(passService, verify)],
    handleSignals: false,
  });
  const base = server.url;

  async function post(body: unknown, auth?: string): Promise<{ status: number; text: string; json: unknown }> {
    const res = await fetch(`${base}${VERIFY_BIOMETRIC_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, text, json };
  }

  try {
    console.log('\n── 1. Officer + valid QR → 200 verified (QR verified offline) ──');
    const r1 = await post({ qrSignedToken: qrToken('RDF'), captureRef: 'session-abc' }, token('officer', 'RDF'));
    const b1 = asRecord(r1.json);
    check('status 200', r1.status === 200, `${r1.status} ${r1.text}`);
    check('verified true (mock passing scores)', b1['verified'] === true, String(b1['verified']));
    check('sessionId present', typeof b1['sessionId'] === 'string');
    const ev = bus.published.find((e) => e.eventType === 'BIOMETRIC_VERIFICATION_COMPLETED');
    check('BIOMETRIC_VERIFICATION_COMPLETED emitted', ev !== undefined);
    check('event carries scores', typeof asRecord(ev)['faceMatchConfidence'] === 'number');
    check('event applicantId == QR applicantId', asRecord(ev)['applicantId'] === APPLICANT_ID);
    check('no captureRef leaked on the event', !JSON.stringify(ev).includes('session-abc'));
    check('AUDIT_ENTRY emitted', bus.published.some((e) => e.eventType === 'AUDIT_ENTRY'));

    console.log('\n── 2. Garbage / wrong-agency / auth ──');
    check('garbage QR → 422', (await post({ qrSignedToken: 'not.a.valid.qr', captureRef: 'x' }, token('officer', 'RDF'))).status === 422);
    const mismatch = await post({ qrSignedToken: qrToken('RDF'), captureRef: 'x' }, token('officer', 'RNP'));
    check('RNP officer on RDF QR → 403 AGENCY_MISMATCH', mismatch.status === 403 && asRecord(mismatch.json)['status'] === 'AGENCY_MISMATCH', `${mismatch.status} ${mismatch.text}`);
    check('no token → 401', (await post({ qrSignedToken: qrToken('RDF'), captureRef: 'x' })).status === 401);
    check('system token → 403 (officer-only route)', (await post({ qrSignedToken: qrToken('RDF'), captureRef: 'x' }, token('system'))).status === 403);

    console.log('\n── 3. Below-threshold scores → verified false (fail-closed) ──');
    const failService = new VerifyBiometricService({
      matcher: new StubMatcher({ livenessScore: 0.4, faceMatchConfidence: 50 }),
      qrInvitationPublicKeyPem: QR_KEYS.publicKeyPem,
      thresholds: THRESHOLDS,
      eventBus: new InMemoryEventBus(),
    });
    const failOut = await failService.verify({
      qrSignedToken: qrToken('RDF'), captureRef: 'x', actorAgency: 'RDF',
      context: { correlationId: 'c', causationId: 'c' },
    });
    check('EVALUATED with verified false', failOut.kind === 'EVALUATED' && failOut.verified === false, JSON.stringify(failOut));
    check('both dimensions failed', failOut.kind === 'EVALUATED' && !failOut.livenessPass && !failOut.faceMatchPass);

    console.log('\n── 4. identity-service records biometric_* onto the identity ──');
    await admin`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
    await admin`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender, registration_channel, identity_status)
      VALUES (${APPLICANT_ID}, ${'9b'.repeat(32)}, 'x','x','x','x','MALE','WEB','VERIFIED'::public_core.identity_verification_status)`;
    const projector = createBiometricResultProjector(loadIdentityConfig(), bus);
    const outcome = await projector.project({
      applicantId: APPLICANT_ID, sessionId: 'sess-xyz', livenessPass: true, faceMatchPass: true, faceMatchConfidence: 96.0,
    });
    check('projection updated the identity', outcome === 'updated', outcome);
    const rows = await admin<{ sid: string | null; verified_at: Date | null; liveness: boolean | null; conf: string | null }[]>`
      SELECT biometric_session_id AS sid, biometric_verified_at AS verified_at,
             biometric_passed_liveness AS liveness, biometric_face_match_confidence AS conf
      FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
    const row = rows[0];
    check('biometric_session_id stored', row?.sid === 'sess-xyz', String(row?.sid));
    check('biometric_verified_at set (overall pass)', row?.verified_at !== null);
    check('biometric_passed_liveness true', row?.liveness === true);
    check('biometric_face_match_confidence stored', row?.conf === '96.00', String(row?.conf));
    // A mis-routed applicant is a silent no-op.
    const notFound = await projector.project({ applicantId: '00000000-0000-4000-8000-000000000000', sessionId: 's', livenessPass: true, faceMatchPass: true, faceMatchConfidence: 90 });
    check('unknown applicant → not_found (no silent success)', notFound === 'not_found', notFound);

    await admin`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  } finally {
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('BIOMETRIC CHECK-IN GATE + PERSISTENCE PROVEN ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main()
  .then(async () => {
    await Promise.all([sql.end(), admin.end()]);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    await Promise.all([sql.end(), admin.end()]);
    process.exit(1);
  });

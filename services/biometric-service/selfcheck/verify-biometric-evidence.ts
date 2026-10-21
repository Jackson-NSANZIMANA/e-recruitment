// ══════════════════════════════════════════════════════════════════
// biometric-service — Biometric identity evidence, LIVE (ADR-037)
//
// Against the real database (rls/0034), through the real HTTP routes of
// biometric-service and application-service:
//   • a valid signed SHADOW record is stored, answered without its outcome,
//     audited, never emitted as a result, and invisible to the officer read;
//   • replay: same record+signature → ALREADY_RECORDED (no 2nd row); a
//     different body under the same record id → REPLAY_CONFLICT;
//   • forged signature, revoked device, another agency's device, wrong key id,
//     unknown ticket, NIDA_PORTRAIT → refused, nothing stored;
//   • NO IMAGE: data: URI, embedding array, base64 frame, oversized body →
//     refused, nothing stored;
//   • modes: OFF refuses, a mode mismatch refuses, SHADOW never in an officer
//     read, ADVISORY shown;
//   • NO_MATCH (ADVISORY) → admission answers MANUAL_IDENTITY_REQUIRED → a
//     field supervisor (not the capturing officer) confirms → admission with
//     NATIONAL_ID_CARD+SUPERVISOR; MATCH → NATIONAL_ID_CARD+CARD_PORTRAIT;
//     SHADOW NO_MATCH → plain NATIONAL_ID_CARD (SHADOW never influences);
//   • the engine refuses a caller without the service role, a substituted
//     actor, a disabled officer; the officer role cannot insert evidence or
//     read a SHADOW row;
//   • append-only even for the table owner; events PII-free.
//
//   (env as scripts/run-selfchecks.sh)  npx tsx services/biometric-service/selfcheck/verify-biometric-evidence.ts
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer, type Route } from '@usrp/shared-http';
import { generateDeviceKeyPair, hashNationalId, signEd25519, signSlotInvitation } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import type { Agency, SlotInvitationClaims } from '@usrp/shared-types';
import {
  BiometricEvidenceService,
  GateAdmissionService,
  PgBiometricEvidenceRepository,
  PgGateAdmissionRepository,
  biometricEvidenceRoutes as applicationEvidenceRoutes,
  gateAdmissionRoutes,
} from '@usrp/application-service';
import {
  FixedReferenceSources,
  PgEvidenceEventDispatcher,
  PgEvidenceStore,
  RecordEvidenceService,
  biometricEvidenceRoutes,
  deviceKeyId,
  evidenceSigningInput,
  parseEvidenceRecord,
  type BiometricMode,
} from '../src/index.js';

const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });
const HMAC_KEY = process.env['NATIONAL_ID_HMAC_KEY'] ?? 'dev_national_id_hmac_key_min_32_chars!!';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// ── Fixtures (fresh ids every run; cleaned at the end) ───────────
const RUN = randomUUID().slice(0, 8);
const CAMPAIGN = randomUUID();
const GATE = randomUUID();        // screening officer at the gate (captures and admits)
const GATE_2 = randomUUID();      // second screening officer
const SUPERVISOR = randomUUID();  // field supervisor
const DISABLED = randomUUID();    // disabled screening officer
const REVIEWER = randomUUID();
const OFFICERS = [GATE, GATE_2, SUPERVISOR, DISABLED, REVIEWER];
const DEV = `B1-${RUN}-TAB`;
const DEV_REVOKED = `B1-${RUN}-REV`;
const DEV_RNP = `B1-${RUN}-RNP`;
const KEYS = generateDeviceKeyPair();
const KEYS_REVOKED = generateDeviceKeyPair();
const KEYS_RNP = generateDeviceKeyPair();
const OTHER = generateDeviceKeyPair();
const QR = generateDeviceKeyPair();
const AUTH = generateDeviceKeyPair();
const VENUE = `B1 Selfcheck Venue ${RUN}`;

interface Candidate { readonly app: string; readonly applicant: string; readonly ticket: string; readonly code: string; readonly nid: string }
const candidate = (n: number): Candidate => ({
  app: randomUUID(), applicant: randomUUID(), ticket: `B1${RUN}${String(n)}TICKET`, code: `RDF-B1${String(n)}${RUN.slice(0, 4)}`,
  nid: `1${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}${String(n)}`,
});
const A = candidate(1); // SHADOW evidence; then SHADOW NO_MATCH must not influence admission
const B = candidate(2); // ADVISORY NO_MATCH → manual identity → admission
const C = candidate(3); // ADVISORY MATCH → second identity method
const ALL = [A, B, C];

function kigaliToday(): string {
  return new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
}

function ticketToken(c: Candidate): string {
  const claims: SlotInvitationClaims = {
    v: 1, keyId: 'b1-selfcheck', ticketId: c.ticket, applicationId: c.app, applicantId: c.applicant,
    agency: 'RDF', campaignId: CAMPAIGN, slotId: randomUUID(), venueName: VENUE, examDate: kigaliToday(),
    reportingTimeHour: 7, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  };
  return signSlotInvitation(QR.privateKeyPem, claims);
}
const TOKENS = new Map(ALL.map((c) => [c.app, ticketToken(c)]));

function officerToken(sub: string, roles: string[], agency: Agency = 'RDF'): string {
  const claims: AuthTokenClaims = {
    v: 1, iss: 'usrp', aud: 'usrp-services', sub, kind: 'officer', agency, roles,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  };
  return signAuthToken(AUTH.privateKeyPem, claims);
}

function baseRecord(c: Candidate, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'USRP-BIO-EVIDENCE.v1', recordId: randomUUID(), applicationId: c.app, ticketId: c.ticket,
    deviceId: DEV, keyId: deviceKeyId(KEYS.publicKeyPem), referenceSource: 'CARD_PORTRAIT',
    method: 'FACE_1_1_ON_DEVICE', consentState: 'GIVEN', outcome: 'MATCH', notAttemptedReason: null,
    livenessScoreBp: 9_400, matchScoreBp: 9_100, modelId: 'usrp-face-card', modelVersion: '1.0.0',
    thresholdPolicyVersion: 'BIO-THRESHOLDS.v1', mode: 'SHADOW', capturedAt: new Date().toISOString(),
    ...over,
  };
}

function sign(record: Record<string, unknown>, privateKeyPem = KEYS.privateKeyPem): string {
  const parsed = parseEvidenceRecord(record);
  if (parsed === null) throw new Error(`fixture does not parse: ${JSON.stringify(record)}`);
  return signEd25519(privateKeyPem, evidenceSigningInput(parsed));
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    for (const [id, roles, status] of [
      // GATE also holds field_supervisor, so the engine reaches the SAME_OFFICER rule.
      [GATE, ['screening_officer', 'field_supervisor'], 'active'], [GATE_2, ['screening_officer'], 'active'],
      [SUPERVISOR, ['field_supervisor'], 'active'], [DISABLED, ['screening_officer'], 'disabled'],
      [REVIEWER, ['reviewer'], 'active'],
    ] as const) {
      await tx`INSERT INTO public_core.officer_accounts (officer_id, login_handle, credential, agency, roles, status)
        VALUES (${id}, ${`b1.${RUN}.${id.slice(0, 8)}`}, 'scrypt$selfcheck', 'RDF', ${tx.array([...roles])}, ${status})`;
    }
    for (const [device, keys, agency, revoked] of [
      [DEV, KEYS, 'RDF', false], [DEV_REVOKED, KEYS_REVOKED, 'RDF', true], [DEV_RNP, KEYS_RNP, 'RNP', false],
    ] as const) {
      await tx`INSERT INTO public_core.field_devices (device_id, public_key_pem, agency, enrolled_by, revoked_at)
        VALUES (${device}, ${keys.publicKeyPem}, ${agency}, 'b1-selfcheck', ${revoked ? new Date() : null})`;
    }
    for (const c of ALL) {
      await tx`INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth, encrypted_home_district,
         encrypted_home_province, gender, registration_channel, identity_status)
        VALUES (${c.applicant}, ${hashNationalId(c.nid, HMAC_KEY)}, 'x','x','x','x','MALE','WEB',
                'VERIFIED'::public_core.identity_verification_status)`;
    }
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public_core.recruitment_campaigns
      (id, public_code, campaign_label, agency, status, target_categories, registration_opens_at,
       registration_closes_at, examination_start_date, examination_end_date, examination_reporting_hour)
      VALUES (${CAMPAIGN}, ${`RDF-B1-SELFCHECK-${RUN.toUpperCase()}`}, 'B1 selfcheck', 'RDF', 'REGISTRATION_CLOSED', '["GENERAL_ENLISTMENT"]',
              now() - interval '30 days', now() - interval '1 day', ${kigaliToday()}, ${kigaliToday()}, 7)`;
    for (const c of ALL) {
      await tx`INSERT INTO rdf_ops.applications
        (id, processing_code, applicant_id, campaign_id, category, status, qr_invitation_code, qr_signed_token, assigned_venue_name)
        VALUES (${c.app}, ${c.code}, ${c.applicant}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
                'SLOT_ASSIGNED'::rdf_ops.application_status, ${c.ticket}, ${TOKENS.get(c.app) ?? ''}, ${VENUE})`;
    }
  });
}

async function cleanup(): Promise<void> {
  const apps = ALL.map((c) => c.app);
  await admin.begin(async (tx) => {
    // Append-only tables: only the replica session role (superuser) can remove
    // a proof's own rows, exactly as the gate admission proof does.
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.gate_manual_identity_confirmations WHERE application_id IN ${tx(apps)}`;
    await tx`DELETE FROM rdf_ops.biometric_evidence WHERE application_id IN ${tx(apps)}`;
    await tx`DELETE FROM rdf_ops.gate_admission_attempts WHERE officer_id IN ${tx(OFFICERS)}`;
    await tx`DELETE FROM rdf_ops.gate_admissions WHERE application_id IN ${tx(apps)}`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${tx(apps)}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(apps)}`;
    await tx`DELETE FROM public_core.event_outbox WHERE payload->>'entityId' IN ${tx(apps)} OR payload->>'applicantId' IN ${tx(ALL.map((c) => c.applicant))}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(ALL.map((c) => c.applicant))}`;
    await tx`DELETE FROM public_core.field_devices WHERE device_id IN ${tx([DEV, DEV_REVOKED, DEV_RNP])}`;
    await tx`DELETE FROM public_core.officer_accounts WHERE officer_id IN ${tx(OFFICERS)}`;
  });
}

async function serve(routes: Route[]): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = await startHttpServer({ serviceName: 'b1-selfcheck', port: 0, host: '127.0.0.1', routes, handleSignals: false });
  return { url: server.url, stop: () => server.stop() };
}

interface Reply { readonly status: number; readonly json: Record<string, unknown>; readonly text: string }
async function call(base: string, method: 'GET' | 'POST', path: string, token: string, body?: unknown, raw?: string): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: raw ?? JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = rec(text ? JSON.parse(text) : {}); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function evidenceRows(c: Candidate): Promise<{ record_id: string; mode: string; outcome: string }[]> {
  return admin<{ record_id: string; mode: string; outcome: string }[]>`
    SELECT record_id::text, mode, outcome FROM rdf_ops.biometric_evidence WHERE application_id = ${c.app} ORDER BY received_at`;
}

async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return 'ok'; } catch (err) { return String(rec(err)['code'] ?? 'error'); }
}

async function main(): Promise<void> {
  await seed();
  const verify = makeAuthVerifier({ publicKeyPem: AUTH.publicKeyPem, issuer: 'usrp', audience: 'usrp-services' });
  const bus = new InMemoryEventBus();
  const sources = new FixedReferenceSources();
  const evidenceServer = (mode: BiometricMode): RecordEvidenceService => new RecordEvidenceService({
    store: new PgEvidenceStore(), events: new PgEvidenceEventDispatcher(bus), referenceSources: sources,
    modeFor: () => mode, legalBasis: 'CONSENT_OR_DECLINE', thresholdPolicyVersion: 'BIO-THRESHOLDS.v1',
  });
  const policyFor = (mode: BiometricMode) => ({ modeFor: () => mode, thresholdPolicyVersion: 'BIO-THRESHOLDS.v1', legalBasis: 'CONSENT_OR_DECLINE' as const, referenceSources: sources });
  const shadow = await serve(biometricEvidenceRoutes(evidenceServer('SHADOW'), policyFor('SHADOW'), verify));
  const advisory = await serve(biometricEvidenceRoutes(evidenceServer('ADVISORY'), policyFor('ADVISORY'), verify));
  const off = await serve(biometricEvidenceRoutes(evidenceServer('OFF'), policyFor('OFF'), verify));
  const noop = { dispatch: async (): Promise<void> => {} };
  const app = await serve([
    ...gateAdmissionRoutes(new GateAdmissionService({ repository: new PgGateAdmissionRepository(), events: noop }), verify),
    ...applicationEvidenceRoutes(new BiometricEvidenceService({ repository: new PgBiometricEvidenceRepository(), events: noop }), verify),
  ]);
  const gate = officerToken(GATE, ['screening_officer']);
  const supervisor = officerToken(SUPERVISOR, ['field_supervisor']);
  const reviewer = officerToken(REVIEWER, ['reviewer']);
  const post = (srv: { url: string }, body: unknown, token = gate, raw?: string): Promise<Reply> =>
    call(srv.url, 'POST', '/v1/biometric/evidence', token, body, raw);
  const admit = (c: Candidate, token = gate): Promise<Reply> => call(app.url, 'POST', '/v1/applications/admissions/gate', token, {
    qrToken: TOKENS.get(c.app), gateVenueName: VENUE, nationalIdHash: hashNationalId(c.nid, HMAC_KEY),
  });
  const officerRead = (c: Candidate, token = reviewer): Promise<Reply> =>
    call(app.url, 'GET', `/v1/applications/biometric-evidence?applicationId=${c.app}`, token);

  try {
    console.log('\n── 1. Policy ──');
    const pol = await call(shadow.url, 'GET', '/v1/biometric/policy', gate);
    check('policy: SHADOW, consent-or-decline, NIDA not authorised', pol.status === 200 && pol.json['mode'] === 'SHADOW'
      && pol.json['legalBasis'] === 'CONSENT_OR_DECLINE'
      && JSON.stringify(pol.json['referenceSources']).includes('"NIDA_PORTRAIT","status":"NOT_AUTHORISED"'), pol.text);
    check('policy needs biometric.verify (reviewer → 403)', (await call(shadow.url, 'GET', '/v1/biometric/policy', reviewer)).status === 403);

    console.log('\n── 2. A valid signed SHADOW record ──');
    const r1 = baseRecord(A);
    const s1 = sign(r1);
    const ok = await post(shadow, { record: r1, signature: s1 });
    check('201 RECORDED, mode SHADOW', ok.status === 201 && ok.json['status'] === 'RECORDED' && ok.json['mode'] === 'SHADOW', ok.text);
    check('SHADOW answer carries no outcome', !('outcome' in ok.json));
    check('exactly one row stored', (await evidenceRows(A)).length === 1);
    const stored = (await admin<{ key_id: string; record_digest: string; signature: string; officer_id: string }[]>`
      SELECT key_id, record_digest, signature, officer_id::text FROM rdf_ops.biometric_evidence WHERE record_id = ${String(r1['recordId'])}`)[0];
    check('row binds the key id, digest, signature and the token officer', stored?.key_id === deviceKeyId(KEYS.publicKeyPem)
      && stored.signature === s1 && /^[0-9a-f]{64}$/.test(stored.record_digest) && stored.officer_id === GATE);
    const outboxA = await admin<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM public_core.event_outbox WHERE producer = 'biometric-service' AND payload->>'entityId' = ${A.app}`;
    check('BIOMETRIC_EVIDENCE_RECORDED audit staged (producer biometric-service)', outboxA.some((r) => r.payload['action'] === 'BIOMETRIC_EVIDENCE_RECORDED'));
    check('SHADOW never emits BIOMETRIC_VERIFICATION_COMPLETED', !bus.published.some((e) => e.eventType === 'BIOMETRIC_VERIFICATION_COMPLETED' && rec(e)['recordId'] === r1['recordId']));
    const readA = await officerRead(A);
    check('SHADOW is invisible in the officer read', readA.status === 200 && Array.isArray(readA.json['evidence']) && (readA.json['evidence'] as unknown[]).length === 0, readA.text);

    console.log('\n── 3. Replay ──');
    const again = await post(shadow, { record: r1, signature: s1 });
    check('same record + signature → 200 ALREADY_RECORDED', again.status === 200 && again.json['status'] === 'ALREADY_RECORDED', again.text);
    const altered = { ...r1, matchScoreBp: 9_200 };
    const conflict = await post(shadow, { record: altered, signature: sign(altered) });
    check('same record id, different body → 409 REPLAY_CONFLICT', conflict.status === 409 && conflict.json['error'] === 'REPLAY_CONFLICT', conflict.text);
    check('still exactly one row', (await evidenceRows(A)).length === 1);

    console.log('\n── 4. Trust refusals (nothing stored) ──');
    const before = (await evidenceRows(A)).length;
    const forged = baseRecord(A);
    const forgedRes = await post(shadow, { record: forged, signature: sign(forged, OTHER.privateKeyPem) });
    check('forged signature → 403 SIGNATURE_INVALID', forgedRes.status === 403 && forgedRes.json['reason'] === 'SIGNATURE_INVALID', forgedRes.text);
    const revoked = baseRecord(A, { deviceId: DEV_REVOKED, keyId: deviceKeyId(KEYS_REVOKED.publicKeyPem) });
    const revokedRes = await post(shadow, { record: revoked, signature: sign(revoked, KEYS_REVOKED.privateKeyPem) });
    check('revoked device → 403 DEVICE_REVOKED', revokedRes.status === 403 && revokedRes.json['reason'] === 'DEVICE_REVOKED', revokedRes.text);
    const rnp = baseRecord(A, { deviceId: DEV_RNP, keyId: deviceKeyId(KEYS_RNP.publicKeyPem) });
    const rnpRes = await post(shadow, { record: rnp, signature: sign(rnp, KEYS_RNP.privateKeyPem) });
    check('another agency\'s device → 403 DEVICE_WRONG_AGENCY', rnpRes.status === 403 && rnpRes.json['reason'] === 'DEVICE_WRONG_AGENCY', rnpRes.text);
    const wrongKey = baseRecord(A, { keyId: deviceKeyId(OTHER.publicKeyPem) });
    const wrongKeyRes = await post(shadow, { record: wrongKey, signature: sign(wrongKey) });
    check('key id not the enrolled key → 403 KEY_MISMATCH', wrongKeyRes.status === 403 && wrongKeyRes.json['reason'] === 'KEY_MISMATCH', wrongKeyRes.text);
    const rnpOfficer = await post(shadow, { record: baseRecord(A), signature: s1 }, officerToken(GATE, ['screening_officer'], 'RNP'));
    check('an RNP officer cannot record against an RDF device', rnpOfficer.status === 403, rnpOfficer.text);
    const unknownTicket = baseRecord(A, { ticketId: 'NOT-THE-TICKET' });
    const utRes = await post(shadow, { record: unknownTicket, signature: sign(unknownTicket) });
    check('ticket not the one stored on the application → 422 UNKNOWN_TICKET', utRes.status === 422 && utRes.json['reason'] === 'UNKNOWN_TICKET', utRes.text);
    const nida = baseRecord(A, { referenceSource: 'NIDA_PORTRAIT' });
    const nidaRes = await post(shadow, { record: nida, signature: sign(nida) });
    check('NIDA_PORTRAIT fails closed → 422 REFERENCE_SOURCE_NOT_AUTHORISED', nidaRes.status === 422 && nidaRes.json['reason'] === 'REFERENCE_SOURCE_NOT_AUTHORISED', nidaRes.text);
    const disabled = await post(shadow, { record: baseRecord(A), signature: s1 }, officerToken(DISABLED, ['screening_officer']));
    check('a disabled officer\'s unexpired token → 403 (engine re-check)', disabled.status === 403, disabled.text);
    const notPermitted = await post(shadow, { record: baseRecord(A), signature: s1 }, reviewer);
    check('a reviewer cannot record evidence (biometric.verify) → 403', notPermitted.status === 403);
    const refusals = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.event_outbox
      WHERE producer = 'biometric-service' AND payload->>'action' = 'BIOMETRIC_EVIDENCE_REFUSED' AND payload->>'entityId' = ${A.app}`;
    check('trust refusals are audited (BIOMETRIC_EVIDENCE_REFUSED)', (refusals[0]?.n ?? 0) >= 4, String(refusals[0]?.n));
    check('no refused record was stored', (await evidenceRows(A)).length === before);

    console.log('\n── 5. NO IMAGE, FRAME OR EMBEDDING IS EVER ACCEPTED ──');
    const imageCases: [string, Record<string, unknown>][] = [
      ['data: URI under a new key', { record: { ...baseRecord(A), portrait: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ' }, signature: s1 }],
      ['data: URI in a known field', { record: baseRecord(A, { modelId: 'data:image/png;base64,iVBORw0KGgo' }), signature: s1 }],
      ['embedding array', { record: { ...baseRecord(A), embedding: Array.from({ length: 128 }, (_, i) => i / 128) }, signature: s1 }],
      ['base64 frame', { record: baseRecord(A), signature: s1, frame: `/9j/${'A'.repeat(900)}` }],
      ['string over 1 KiB', { record: baseRecord(A, { modelVersion: 'x'.repeat(1_100) }), signature: s1 }],
    ];
    for (const [label, body] of imageCases) {
      const r = await post(shadow, body);
      check(`${label} → 422 IMAGE_PAYLOAD_REFUSED`, r.status === 422 && r.json['reason'] === 'IMAGE_PAYLOAD_REFUSED', r.text);
    }
    const big = await post(shadow, undefined, gate, JSON.stringify({ record: baseRecord(A), signature: s1, pad: ' '.repeat(5_000) }));
    check('a body over 4 KiB never reaches the parser (413)', big.status === 413, `${String(big.status)} ${big.text}`);
    check('none of them stored anything', (await evidenceRows(A)).length === before);
    const cols = await admin<{ data_type: string; character_maximum_length: number | null }[]>`
      SELECT data_type, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'rdf_ops' AND table_name = 'biometric_evidence'`;
    check('engine: no column can hold a blob (no bytea/text/json; every varchar ≤ 128)', cols.every((c) =>
      ['uuid', 'integer', 'timestamp with time zone', 'character', 'character varying'].includes(c.data_type)
      && (c.character_maximum_length === null || c.character_maximum_length <= 128)), JSON.stringify(cols));

    console.log('\n── 6. Modes ──');
    const offRes = await post(off, { record: baseRecord(A), signature: s1 });
    check('OFF → 409 BIOMETRIC_OFF', offRes.status === 409 && offRes.json['error'] === 'BIOMETRIC_OFF', offRes.text);
    const declaredAdvisory = baseRecord(A, { mode: 'ADVISORY' });
    const mm = await post(shadow, { record: declaredAdvisory, signature: sign(declaredAdvisory) });
    check('device says ADVISORY under SHADOW → 409 MODE_MISMATCH { configuredMode: SHADOW }', mm.status === 409 && mm.json['configuredMode'] === 'SHADOW', mm.text);

    console.log('\n── 7. SHADOW NO_MATCH never influences the gate ──');
    const shadowNoMatch = baseRecord(A, { outcome: 'NO_MATCH', matchScoreBp: 3_000 });
    check('SHADOW NO_MATCH stored', (await post(shadow, { record: shadowNoMatch, signature: sign(shadowNoMatch) })).status === 201);
    const admitA = await admit(A);
    check('admitted on the card alone: NATIONAL_ID_CARD', admitA.status === 200 && admitA.json['identityMethod'] === 'NATIONAL_ID_CARD', admitA.text);

    console.log('\n── 8. ADVISORY NO_MATCH → supervised manual identity → admission ──');
    const noMatch = baseRecord(B, { mode: 'ADVISORY', outcome: 'NO_MATCH', matchScoreBp: 4_000 });
    const nm = await post(advisory, { record: noMatch, signature: sign(noMatch) });
    check('ADVISORY answer shows the outcome', nm.status === 201 && nm.json['outcome'] === 'NO_MATCH', nm.text);
    const v11 = bus.published.find((e) => e.eventType === 'BIOMETRIC_VERIFICATION_COMPLETED' && rec(e)['recordId'] === noMatch['recordId']);
    check('ADVISORY emits BIOMETRIC_VERIFICATION_COMPLETED v1.1 with method and referenceSource', rec(v11)['schemaVersion'] === '1.1'
      && rec(v11)['method'] === 'FACE_1_1_ON_DEVICE' && rec(v11)['referenceSource'] === 'CARD_PORTRAIT' && rec(v11)['faceMatchPass'] === false);
    const readB = await officerRead(B);
    const itemB = rec((readB.json['evidence'] as unknown[] | undefined)?.[0]);
    check('officer read shows the ADVISORY row', readB.status === 200 && itemB['outcome'] === 'NO_MATCH' && itemB['matchScoreBp'] === 4_000, readB.text);
    check('officer read carries no device internals', !readB.text.includes(DEV) && !readB.text.includes(deviceKeyId(KEYS.publicKeyPem)) && !readB.text.includes(GATE));
    const held = await admit(B);
    check('admission → 409 MANUAL_IDENTITY_REQUIRED (never a refusal)', held.status === 409 && held.json['error'] === 'MANUAL_IDENTITY_REQUIRED', held.text);
    const attempt = await admin<{ outcome: string }[]>`SELECT outcome FROM rdf_ops.gate_admission_attempts WHERE application_id = ${B.app} ORDER BY attempted_at DESC LIMIT 1`;
    check('the attempt is logged as MANUAL_IDENTITY_REQUIRED', attempt[0]?.outcome === 'MANUAL_IDENTITY_REQUIRED');
    const confirm = (token: string, recordId = String(noMatch['recordId'])): Promise<Reply> =>
      call(app.url, 'POST', '/v1/applications/biometric-evidence/manual-identity', token, { recordId, reasonCode: 'CARD_PHOTO_OUTDATED' });
    check('the gate officer cannot confirm (identity.manual.confirm) → 403', (await confirm(gate)).status === 403);
    const selfConfirm = await confirm(officerToken(GATE, ['field_supervisor']));
    check('the capturing officer cannot confirm their own evidence → 409 SAME_OFFICER', selfConfirm.status === 409 && selfConfirm.json['error'] === 'SAME_OFFICER', selfConfirm.text);
    const notSupervisor = await confirm(officerToken(GATE_2, ['field_supervisor']));
    check('a token claiming field_supervisor for an officer who is not one → 403 (engine)', notSupervisor.status === 403, notSupervisor.text);
    check('a SHADOW record cannot be confirmed (404)', (await confirm(supervisor, String(shadowNoMatch['recordId']))).status === 404);
    const confirmed = await confirm(supervisor);
    check('field supervisor confirms → 201 CONFIRMED', confirmed.status === 201 && confirmed.json['status'] === 'CONFIRMED', confirmed.text);
    check('a second confirmation → 409 ALREADY_CONFIRMED', (await confirm(supervisor)).json['error'] === 'ALREADY_CONFIRMED');
    const later = baseRecord(B, { mode: 'ADVISORY', outcome: 'NOT_ATTEMPTED', consentState: 'DECLINED', notAttemptedReason: 'CANDIDATE_DECLINED', method: 'NONE', livenessScoreBp: null, matchScoreBp: null, modelId: null, modelVersion: null });
    check('a decline is always accepted as evidence (NOT_ATTEMPTED)', (await post(advisory, { record: later, signature: sign(later) })).status === 201);
    const admittedB = await admit(B);
    check('admission → 200 NATIONAL_ID_CARD+SUPERVISOR', admittedB.status === 200 && admittedB.json['identityMethod'] === 'NATIONAL_ID_CARD+SUPERVISOR', admittedB.text);
    const rowB = await admin<{ identity_method: string }[]>`SELECT identity_method FROM rdf_ops.gate_admissions WHERE application_id = ${B.app}`;
    check('gate_admissions records NATIONAL_ID_CARD+SUPERVISOR', rowB[0]?.identity_method === 'NATIONAL_ID_CARD+SUPERVISOR');
    const readB2 = await officerRead(B, supervisor);
    check('officer read shows the supervisor\'s reason', readB2.text.includes('CARD_PHOTO_OUTDATED'));

    console.log('\n── 9. ADVISORY MATCH → second identity method ──');
    const match = baseRecord(C, { mode: 'ADVISORY' });
    check('MATCH recorded', (await post(advisory, { record: match, signature: sign(match) })).status === 201);
    const admittedC = await admit(C, officerToken(GATE_2, ['screening_officer']));
    check('admission → NATIONAL_ID_CARD+CARD_PORTRAIT', admittedC.status === 200 && admittedC.json['identityMethod'] === 'NATIONAL_ID_CARD+CARD_PORTRAIT', admittedC.text);
    const lateNoMatch = baseRecord(C, { mode: 'ADVISORY', outcome: 'NO_MATCH', matchScoreBp: 3_500 });
    check('negative evidence after admission is still recorded', (await post(advisory, { record: lateNoMatch, signature: sign(lateNoMatch) })).status === 201);
    const lateAudit = await admin<{ m: Record<string, unknown> }[]>`SELECT payload->'metadata' AS m FROM public_core.event_outbox
      WHERE producer = 'biometric-service' AND payload->>'action' = 'BIOMETRIC_EVIDENCE_RECORDED' AND payload->'metadata'->>'recordId' = ${String(lateNoMatch['recordId'])}`;
    check('…and its audit says afterAdmission: true (supervisor follow-up)', lateAudit[0]?.m['afterAdmission'] === true, JSON.stringify(lateAudit));
    const matchAudit = await admin<{ m: Record<string, unknown> }[]>`SELECT payload->'metadata' AS m FROM public_core.event_outbox
      WHERE producer = 'biometric-service' AND payload->>'action' = 'BIOMETRIC_EVIDENCE_RECORDED' AND payload->'metadata'->>'recordId' = ${String(match['recordId'])}`;
    check('evidence before admission: afterAdmission: false', matchAudit[0]?.m['afterAdmission'] === false, JSON.stringify(matchAudit));

    console.log('\n── 10. Engine boundaries ──');
    const fnArgs = (tx: postgres.TransactionSql, actor: string) => tx`SELECT rdf_ops.record_biometric_evidence(
      ${actor}::uuid, ${randomUUID()}::uuid, ${A.app}::uuid, ${A.ticket}, 'CARD_PORTRAIT', 'FACE_1_1_ON_DEVICE', 'GIVEN', 'MATCH', NULL,
      9400, 9100, 'm', '1', 'BIO-THRESHOLDS.v1', 'SHADOW', ${DEV}, ${deviceKeyId(KEYS.publicKeyPem)}, ${'a'.repeat(64)},
      ${`${'A'.repeat(86)}==`}, now(), 'b1-selfcheck')`;
    check('the function refuses a caller without the biometric service role (42501)', await sqlState(() => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`SELECT set_config('usrp.biometric_actor_id', ${GATE}, true)`;
      await fnArgs(tx as unknown as postgres.TransactionSql, GATE);
    })) === '42501');
    check('the function refuses a substituted actor (42501)', await sqlState(() => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_biometric_service`;
      await tx`SELECT set_config('usrp.biometric_actor_id', ${GATE_2}, true)`;
      await fnArgs(tx as unknown as postgres.TransactionSql, GATE);
    })) === '42501');
    check('the officer role cannot insert evidence directly', await sqlState(() => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`INSERT INTO rdf_ops.biometric_evidence (record_id, application_id, ticket_id, reference_source, method, consent_state, outcome,
        threshold_policy_version, mode, device_id, key_id, record_digest, signature, officer_id, captured_at)
        VALUES (${randomUUID()}, ${A.app}, ${A.ticket}, 'NONE', 'NONE', 'DECLINED', 'NOT_ATTEMPTED', 'BIO-THRESHOLDS.v1', 'ADVISORY',
        ${DEV}, ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${`${'A'.repeat(86)}==`}, ${GATE}, now())`;
    })) !== 'ok');
    const officerSees = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.biometric_evidence WHERE application_id = ${A.app}`;
    });
    check('the officer role sees no SHADOW row (RLS)', officerSees[0]?.n === 0, String(officerSees[0]?.n));
    check('the biometric service role has no table privilege on evidence', await sqlState(() => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_biometric_service`;
      await tx`SELECT 1 FROM rdf_ops.biometric_evidence LIMIT 1`;
    })) === '42501');
    for (const [label, stmt] of [
      ['UPDATE evidence', admin`UPDATE rdf_ops.biometric_evidence SET outcome = 'MATCH' WHERE application_id = ${B.app}`],
      ['DELETE evidence', admin`DELETE FROM rdf_ops.biometric_evidence WHERE application_id = ${B.app}`],
      ['TRUNCATE confirmations', admin`TRUNCATE rdf_ops.gate_manual_identity_confirmations`],
      ['UPDATE confirmation', admin`UPDATE rdf_ops.gate_manual_identity_confirmations SET reason_code = 'APPEARANCE_CHANGED' WHERE application_id = ${B.app}`],
      ['DELETE confirmation', admin`DELETE FROM rdf_ops.gate_manual_identity_confirmations WHERE application_id = ${B.app}`],
    ] as const) {
      check(`append-only as the table owner/superuser: ${label} raises`, await sqlState(() => stmt) === '42501');
    }

    check('TRUNCATE evidence is refused (FK + statement trigger)', await sqlState(() => admin`TRUNCATE rdf_ops.biometric_evidence`) !== 'ok');
    check('evidence rows survived every mutation attempt', (await evidenceRows(B)).length === 2);

    check('the officer role cannot insert a confirmation directly', await sqlState(() => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`INSERT INTO rdf_ops.gate_manual_identity_confirmations (evidence_id, application_id, ticket_id, reason_code, confirmed_by_id)
        SELECT id, application_id, ticket_id, 'SUPERVISOR_INTERVIEW', ${SUPERVISOR}::uuid FROM rdf_ops.biometric_evidence WHERE application_id = ${C.app} LIMIT 1`;
    })) !== 'ok');
    check('confirm_manual_identity refuses a substituted actor (42501)', await sqlState(() => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`SELECT set_config('usrp.manual_identity_actor_id', ${GATE_2}, true)`;
      await tx`SELECT rdf_ops.confirm_manual_identity(${SUPERVISOR}::uuid, ${String(lateNoMatch['recordId'])}::uuid, 'SUPERVISOR_INTERVIEW', 'b1-selfcheck')`;
    })) === '42501');
    check('confirm_manual_identity refuses a caller without the officer role (42501)', await sqlState(() => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_biometric_service`;
      await tx`SELECT set_config('usrp.manual_identity_actor_id', ${SUPERVISOR}, true)`;
      await tx`SELECT rdf_ops.confirm_manual_identity(${SUPERVISOR}::uuid, ${String(lateNoMatch['recordId'])}::uuid, 'SUPERVISOR_INTERVIEW', 'b1-selfcheck')`;
    })) === '42501');
    check('the engine refuses an attempted outcome with NULL scores (NULL-safe CHECK)', await sqlState(() => admin`INSERT INTO rdf_ops.biometric_evidence (record_id, application_id, ticket_id, reference_source, method, consent_state, outcome,
        threshold_policy_version, mode, device_id, key_id, record_digest, signature, officer_id, captured_at)
        VALUES (${randomUUID()}, ${A.app}, ${A.ticket}, 'CARD_PORTRAIT', 'FACE_1_1_ON_DEVICE', 'GIVEN', 'MATCH', 'BIO-THRESHOLDS.v1', 'ADVISORY',
        ${DEV}, ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${`${'A'.repeat(86)}==`}, ${GATE}, now())`) === '23514');
    check('the engine refuses NOT_ATTEMPTED without a reason (NULL-safe CHECK)', await sqlState(() => admin`INSERT INTO rdf_ops.biometric_evidence (record_id, application_id, ticket_id, reference_source, method, consent_state, outcome,
        threshold_policy_version, mode, device_id, key_id, record_digest, signature, officer_id, captured_at)
        VALUES (${randomUUID()}, ${A.app}, ${A.ticket}, 'NONE', 'NONE', 'DECLINED', 'NOT_ATTEMPTED', 'BIO-THRESHOLDS.v1', 'ADVISORY',
        ${DEV}, ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${`${'A'.repeat(86)}==`}, ${GATE}, now())`) === '23514');
    const shadowAudit = await admin<{ m: Record<string, unknown> }[]>`SELECT payload->'metadata' AS m FROM public_core.event_outbox
      WHERE producer = 'biometric-service' AND payload->>'action' = 'BIOMETRIC_EVIDENCE_RECORDED' AND payload->'metadata'->>'recordId' = ${String(shadowNoMatch['recordId'])}`;
    check('a SHADOW audit carries no outcome', shadowAudit.length === 1 && !('outcome' in (shadowAudit[0]?.m ?? {})), JSON.stringify(shadowAudit));

    console.log('\n── 11. Events are PII-free ──');
    const payloads = JSON.stringify(await admin`SELECT payload FROM public_core.event_outbox WHERE producer = 'biometric-service' AND (payload->>'entityId' IN ${admin(ALL.map((c) => c.app))} OR payload->>'applicantId' IN ${admin(ALL.map((c) => c.applicant))})`)
      + JSON.stringify(bus.published);
    check('no national id or its hash', ALL.every((c) => !payloads.includes(c.nid) && !payloads.includes(hashNationalId(c.nid, HMAC_KEY))));
    check('no signature, key or image material', !payloads.includes(s1) && !payloads.includes('BEGIN PUBLIC KEY') && !payloads.includes('data:'));
  } finally {
    await Promise.all([shadow.stop(), advisory.stop(), off.stop(), app.stop()]);
    await cleanup();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('BIOMETRIC IDENTITY EVIDENCE PROVEN ✓');
  else console.error(`${String(failures)} ASSERTION(S) FAILED ✗`);
}

main()
  .then(async () => {
    await Promise.all([sql.end(), admin.end()]);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    await cleanup().catch(() => {});
    await Promise.all([sql.end(), admin.end()]);
    process.exit(1);
  });

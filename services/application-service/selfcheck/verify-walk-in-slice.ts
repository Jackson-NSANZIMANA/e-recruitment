// ══════════════════════════════════════════════════════════════════
// application-service — WALK-IN LANE slice self-check (ADR-012, live)
//
// Proves the RDF-only walk-in lane end-to-end against live PostgreSQL and a
// real HTTP socket: a field officer registers an on-site candidate on exam
// day, the autonomous age gate's verdict drives on-site vetting, the captured
// physical-test score advances the lane, and the row MERGES into the main
// funnel at MEDICAL_REVIEW — reaching ACCEPTED through the same officer
// endpoints as the digital lane. Also pins the lane's fail-closed geometry:
// early hard fail → WALK_IN_REJECTED (terminal), late flag →
// ADJUDICATION_REVIEW (restorable), and the walk-in-scoped biometric waiver.
//
// Projections run through the REAL use-case services (projector /
// physicalTestProjector) over an InMemoryEventBus — same fidelity as the
// officer-lifecycle proof; the Kafka transport of these consumers is already
// gated by the vetting-projection and pipeline proofs.
//
//   npx tsx services/application-service/selfcheck/verify-walk-in-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  createApplicationService,
  loadApplicationConfig,
  officerTransitionRoutes,
  walkInRoutes,
  WALK_IN_REGISTER_PATH,
  WALK_IN_VET_PATH,
  MEDICAL_REVIEW_PATH,
  FINAL_DECISION_PATH,
  ACCEPT_PATH,
  ADJUDICATE_PATH,
} from '../src/index.js';

// ── In-test issuer key: set the verify public key BEFORE loading config ──
const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// Deterministic fixtures (officer subjects are UUIDs — Slice-4 alignment).
const APPLICANT_ID = '6a000000-0000-4000-8000-000000000001';
const NID_HASH = '6a6a6a6a'.repeat(8); // 64 hex
const RDF_CAMPAIGN = '6a000000-0000-4000-8000-0000000000c1';
const RDF_OFFICER_ID = '6a000000-0000-4000-8000-00000000ff01';
const RNP_OFFICER_ID = '6a000000-0000-4000-8000-00000000ff02';
const DEVICE_ID = 'walkin-selfcheck-tablet-1';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mint(kind: 'officer' | 'system', opts: { agency?: 'RDF' | 'RNP'; sub?: string } = {}): string {
  const base = {
    v: 1 as const,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: opts.sub ?? `walkin-selfcheck-${kind}`,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency: opts.agency ?? 'RDF', roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.physical_test_scores WHERE application_id IN (SELECT id FROM rdf_ops.applications WHERE campaign_id = ${RDF_CAMPAIGN})`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN (SELECT id FROM rdf_ops.applications WHERE campaign_id = ${RDF_CAMPAIGN})`;
    await tx`DELETE FROM rdf_ops.applications WHERE campaign_id = ${RDF_CAMPAIGN}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${RDF_CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  });
}

async function seed(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender, identity_status, registration_channel)
      VALUES (${APPLICANT_ID}, ${NID_HASH}, 'enc','enc','enc','enc','MALE','VERIFIED','WALK_IN')
    `;
    // Exam-day campaign: registration CLOSED, examination window contains
    // today, walk-ins allowed — the walk-in campaign-resolution predicate.
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, campaign_label, agency, status, target_categories, registration_opens_at,
         registration_closes_at, examination_start_date, examination_end_date,
         examination_reporting_hour, allows_walk_in)
      VALUES (${RDF_CAMPAIGN}, 'WALKIN-SELFCHECK-2026', 'RDF', 'EXAMINATION_ACTIVE',
              '["GENERAL_ENLISTMENT"]', now() - interval '40 days', now() - interval '2 days',
              ${today}, ${today}, 8, true)
    `;
  });
}

async function readState(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await admin<Record<string, unknown>[]>`
    SELECT status, is_walk_in, qr_invitation_code, age_eligibility_status,
           physical_test_score_id, medical_fitness_status
    FROM rdf_ops.applications WHERE id = ${id}`;
  return rows[0];
}

async function historyRows(id: string): Promise<{ from_status: string | null; to_status: string; performed_by: string }[]> {
  return admin<{ from_status: string | null; to_status: string; performed_by: string }[]>`
    SELECT from_status, to_status, performed_by
    FROM rdf_ops.application_status_history
    WHERE application_id = ${id} ORDER BY performed_at`;
}

async function main(): Promise<void> {
  await cleanup();
  await seed();

  const config = loadApplicationConfig();
  const bus = new InMemoryEventBus();
  const service = createApplicationService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  const server = await startHttpServer({
    serviceName: 'walk-in-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [...walkInRoutes(service.walkIn, verify), ...officerTransitionRoutes(service.officerTransitions, verify)],
    readiness: async () => true,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const rdfHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${mint('officer', { agency: 'RDF', sub: RDF_OFFICER_ID })}`,
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = rdfHeaders) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, text: JSON.stringify(json) };
  };

  // Feed a vetting verdict through the REAL projection use case.
  const ctx = () => ({ correlationId: randomUUID(), causationId: randomUUID() });
  const projectAge = (applicationId: string, ageStatus: 'ELIGIBLE' | 'INELIGIBLE') =>
    service.projector.project({
      result: { dimension: 'AGE', applicationId, agency: 'RDF', ageStatus, detail: { band: 'selfcheck' }, correlationId: randomUUID() },
      context: ctx(),
      agency: 'RDF',
    });
  const projectCriminal = (applicationId: string, criminalStatus: 'CLEARED' | 'FLAGGED_CONVICTION') =>
    service.projector.project({
      result: { dimension: 'CRIMINAL', applicationId, agency: 'RDF', criminalStatus, appliedThreshold: 'ANY_CONVICTION', ribRequestId: randomUUID(), correlationId: randomUUID() },
      context: ctx(),
      agency: 'RDF',
    });

  try {
    // ══ 1. Register a walk-in on exam day ══════════════════════════
    console.log('\n── 1. Officer registers a walk-in (exam-day campaign) ───────');
    const reg = await post(WALK_IN_REGISTER_PATH, {
      applicantId: APPLICANT_ID,
      category: 'GENERAL_ENLISTMENT',
      nesaIndexNumber: 'RW2024/1001',
    });
    check('register → 201 REGISTERED', reg.status === 201 && reg.json['status'] === 'REGISTERED', reg.text);
    const appId = reg.json['applicationId'] as string;
    const ticket = reg.json['qrInvitationCode'] as string;
    check('on-site ticket minted (score-binding anchor)', typeof ticket === 'string' && ticket.length >= 40, ticket);
    {
      const s = await readState(appId);
      check('row: WALK_IN_REGISTERED + is_walk_in + ticket persisted',
        s?.['status'] === 'WALK_IN_REGISTERED' && s?.['is_walk_in'] === true && s?.['qr_invitation_code'] === ticket,
        JSON.stringify(s));
      const hist = await historyRows(appId);
      check('history: null → WALK_IN_REGISTERED, performed_by = officer UUID',
        hist.length === 1 && hist[0]?.from_status === null && hist[0]?.to_status === 'WALK_IN_REGISTERED' && hist[0]?.performed_by === RDF_OFFICER_ID,
        JSON.stringify(hist));
      const submitted = bus.published.find((e) => e.eventType === 'APPLICANT_SUBMITTED') as unknown as Record<string, unknown> | undefined;
      check('APPLICANT_SUBMITTED emitted with channel WALK_IN (gates fire unchanged)',
        submitted?.['channel'] === 'WALK_IN' && submitted?.['applicationId'] === appId, JSON.stringify(submitted));
      check('AUDIT_ENTRY WALK_IN_REGISTERED attributed to officer',
        bus.published.some((e) => e.eventType === 'AUDIT_ENTRY' && (e as unknown as Record<string, unknown>)['action'] === 'WALK_IN_REGISTERED' && (e as unknown as Record<string, unknown>)['performedBy'] === RDF_OFFICER_ID));
    }

    // ══ 2. On-site vetting gates on the autonomous age verdict ═════
    console.log('\n── 2. On-site vetting: age gate drives the transition ───────');
    const pend = await post(WALK_IN_VET_PATH, { applicationId: appId });
    check('vet before the verdict lands → 409 AGE_PENDING', pend.status === 409 && pend.json['status'] === 'AGE_PENDING', pend.text);

    const ageOut = await projectAge(appId, 'ELIGIBLE');
    check('age ELIGIBLE projected; status UNCHANGED (no ladder proposal on walk-in rows)',
      ageOut.kind === 'APPLIED' && (await readState(appId))?.['status'] === 'WALK_IN_REGISTERED', JSON.stringify(ageOut));

    const vet = await post(WALK_IN_VET_PATH, { applicationId: appId });
    check('vet → 200 APPLIED WALK_IN_REGISTERED → WALK_IN_ON_SITE_VETTING',
      vet.status === 200 && vet.json['toStatus'] === 'WALK_IN_ON_SITE_VETTING' && vet.json['ageStatus'] === 'ELIGIBLE', vet.text);
    const revet = await post(WALK_IN_VET_PATH, { applicationId: appId });
    check('re-vet → 200 NO_CHANGE (idempotent)', revet.status === 200 && revet.json['status'] === 'NO_CHANGE', revet.text);

    // All-pass evidence must NOT pull the row into the digital ladder or
    // trigger the slot lane (no application.cleared for walk-ins).
    await projectCriminal(appId, 'CLEARED');
    check('criminal CLEARED lands; walk-in row stays WALK_IN_ON_SITE_VETTING',
      (await readState(appId))?.['status'] === 'WALK_IN_ON_SITE_VETTING');
    check('no APPLICATION_ELIGIBILITY_CLEARED emitted (slot lane never fires for walk-ins)',
      !bus.published.some((e) => e.eventType === 'APPLICATION_ELIGIBILITY_CLEARED'));

    // ══ 3. Physical-test capture advances the lane (biometric waived) ══
    console.log('\n── 3. Captured score → WALK_IN_PHYSICAL_TEST ────────────────');
    const payloadHash = '6b6b6b6b'.repeat(8);
    await admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO rdf_ops.physical_test_scores
          (application_id, vector_clock, device_id, device_signature, signed_payload_hash,
           capturing_officer_id, captured_at)
        VALUES (${appId}, ${'{"' + DEVICE_ID + '":1}'}, ${DEVICE_ID}, 'sig', ${payloadHash}, ${RDF_OFFICER_ID}, now())
      `;
    });
    const phys = await service.physicalTestProjector.project({
      result: { applicationId: appId, agency: 'RDF', signedPayloadHash: payloadHash, correlationId: randomUUID() },
      context: ctx(),
      agency: 'RDF',
    });
    check('score → APPLIED WALK_IN_ON_SITE_VETTING → WALK_IN_PHYSICAL_TEST (biometric waived: identity verified in person)',
      phys.kind === 'APPLIED' && phys.toStatus === 'WALK_IN_PHYSICAL_TEST', JSON.stringify(phys));
    check('score row stamped on the application',
      (await readState(appId))?.['physical_test_score_id'] != null);

    // ══ 4. Late flag → ADJUDICATION_REVIEW; officer CLEAR restores ═══
    console.log('\n── 4. Late criminal flag → human adjudication, restorable ───');
    const lateFlag = await projectCriminal(appId, 'FLAGGED_CONVICTION');
    check('late flag on vetted walk-in → ADJUDICATION_REVIEW (never silent auto-reject)',
      lateFlag.kind === 'APPLIED' && (await readState(appId))?.['status'] === 'ADJUDICATION_REVIEW', JSON.stringify(lateFlag));
    const clearRes = await post(ADJUDICATE_PATH, { applicationId: appId, decision: 'CLEAR', notes: 'Record mismatch — dismissed' });
    check('officer CLEAR restores the pre-flag stage (WALK_IN_PHYSICAL_TEST, from history)',
      clearRes.status === 200 && clearRes.json['toStatus'] === 'WALK_IN_PHYSICAL_TEST', clearRes.text);

    // ══ 5. THE LANE MERGE: medical → final → accept (one funnel) ═════
    console.log('\n── 5. Merge at MEDICAL_REVIEW; walk-in reaches ACCEPTED ─────');
    const med = await post(MEDICAL_REVIEW_PATH, { applicationId: appId, fitnessStatus: 'FIT' });
    check('medical FIT from WALK_IN_PHYSICAL_TEST → MEDICAL_REVIEW (lane merged)',
      med.status === 200 && med.json['fromStatus'] === 'WALK_IN_PHYSICAL_TEST' && med.json['toStatus'] === 'MEDICAL_REVIEW', med.text);
    const fin = await post(FINAL_DECISION_PATH, { applicationId: appId, decision: 'SHORTLIST', notes: 'Walk-in shortlisted' });
    check('final SHORTLIST → FINAL_SHORTLIST', fin.status === 200 && fin.json['toStatus'] === 'FINAL_SHORTLIST', fin.text);
    const acc = await post(ACCEPT_PATH, { applicationId: appId });
    check('accept → ACCEPTED (a walk-in completes the SAME funnel as the digital lane)',
      acc.status === 200 && acc.json['toStatus'] === 'ACCEPTED', acc.text);
    {
      const hist = await historyRows(appId);
      const edges = hist.map((h) => `${h.from_status ?? '∅'}→${h.to_status}`);
      check('append-only history holds the whole walk-in journey',
        edges.join(',') === '∅→WALK_IN_REGISTERED,WALK_IN_REGISTERED→WALK_IN_ON_SITE_VETTING,WALK_IN_ON_SITE_VETTING→WALK_IN_PHYSICAL_TEST,WALK_IN_PHYSICAL_TEST→ADJUDICATION_REVIEW,ADJUDICATION_REVIEW→WALK_IN_PHYSICAL_TEST,WALK_IN_PHYSICAL_TEST→MEDICAL_REVIEW,MEDICAL_REVIEW→FINAL_SHORTLIST,FINAL_SHORTLIST→ACCEPTED',
        edges.join(','));
    }

    // ══ 6. Early fail: age INELIGIBLE → WALK_IN_REJECTED (terminal) ══
    console.log('\n── 6. Early hard fail → WALK_IN_REJECTED, a real terminal ───');
    const reg2 = await post(WALK_IN_REGISTER_PATH, { applicantId: APPLICANT_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1002' });
    const app2 = reg2.json['applicationId'] as string;
    check('second walk-in registered', reg2.status === 201, reg2.text);
    const badAge = await projectAge(app2, 'INELIGIBLE');
    check('age INELIGIBLE at WALK_IN_REGISTERED → WALK_IN_REJECTED autonomously (lane-local fail-closed)',
      badAge.kind === 'APPLIED' && (await readState(app2))?.['status'] === 'WALK_IN_REJECTED', JSON.stringify(badAge));
    const vetRejected = await post(WALK_IN_VET_PATH, { applicationId: app2 });
    check('vet on the rejected row → 200 NO_CHANGE', vetRejected.status === 200 && vetRejected.json['status'] === 'NO_CHANGE', vetRejected.text);
    await projectCriminal(app2, 'FLAGGED_CONVICTION');
    check('redelivered hard fail never moves WALK_IN_REJECTED (terminal, not re-adjudicated)',
      (await readState(app2))?.['status'] === 'WALK_IN_REJECTED');

    // ══ 7. Guards ═════════════════════════════════════════════════════
    console.log('\n── 7. Agency, auth, and input guards ────────────────────────');
    const rnpHeaders = { 'content-type': 'application/json', authorization: `Bearer ${mint('officer', { agency: 'RNP', sub: RNP_OFFICER_ID })}` };
    const rnpReg = await post(WALK_IN_REGISTER_PATH, { applicantId: APPLICANT_ID, category: 'CADET_OFFICER' }, rnpHeaders);
    check('RNP officer register → 501 UNSUPPORTED_AGENCY (walk-in is RDF-only, engine-backed)', rnpReg.status === 501, rnpReg.text);
    const rnpVet = await post(WALK_IN_VET_PATH, { applicationId: appId }, rnpHeaders);
    check('RNP officer vet → 501 UNSUPPORTED_AGENCY', rnpVet.status === 501, rnpVet.text);
    const wrongCat = await post(WALK_IN_REGISTER_PATH, { applicantId: APPLICANT_ID, category: 'CADET_OFFICER' });
    check('RDF officer + RNP category → 422 WRONG_AGENCY_CATEGORY', wrongCat.status === 422 && wrongCat.json['status'] === 'WRONG_AGENCY_CATEGORY', wrongCat.text);
    const ghost = await post(WALK_IN_REGISTER_PATH, { applicantId: randomUUID(), category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1003' });
    check('unknown applicant → 404 APPLICANT_NOT_FOUND', ghost.status === 404, ghost.text);
    const ghostVet = await post(WALK_IN_VET_PATH, { applicationId: randomUUID() });
    check('unknown application vet → 404 (cross-agency-safe NOT_FOUND)', ghostVet.status === 404, ghostVet.text);
    const noCred = await post(WALK_IN_REGISTER_PATH, { applicantId: APPLICANT_ID, category: 'GENERAL_ENLISTMENT' });
    check('missing academic credential → 422 INVALID_ACADEMIC_INPUT (fail-closed)', noCred.status === 422 && noCred.json['status'] === 'INVALID_ACADEMIC_INPUT', noCred.text);
    const sysTok = await post(WALK_IN_REGISTER_PATH, { applicantId: APPLICANT_ID, category: 'GENERAL_ENLISTMENT' }, { 'content-type': 'application/json', authorization: `Bearer ${mint('system')}` });
    check('system token → 403 (officer-only route)', sysTok.status === 403, sysTok.text);
    const noAuth = await fetch(`${base}${WALK_IN_REGISTER_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('no token → 401', noAuth.status === 401, String(noAuth.status));

    // ══ 8. No PII crosses the boundary ════════════════════════════════
    console.log('\n── 8. No PII in responses or events ─────────────────────────');
    const responses = [reg.text, vet.text, med.text, acc.text, reg2.text].join(' ');
    check('no national_id_hash in any HTTP response', !responses.includes(NID_HASH));
    check('events carry the hash only on APPLICANT_SUBMITTED (never a raw NID, never PII fields)',
      !JSON.stringify(bus.published).includes('encrypted_') && !JSON.stringify(bus.published).includes('dateOfBirth'));
  } finally {
    await server.stop();
    await cleanup();
    await sql.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) {
    console.log('WALK-IN LANE PROVEN (register → vet → physical test → merged funnel → ACCEPTED; fail-closed both early and late) ✓');
  } else {
    console.error(`${failures} ASSERTION(S) FAILED ✗`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err: unknown) => {
  console.error('SELFCHECK CRASHED ✗', err);
  try {
    await cleanup();
    await sql.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  } catch { /* best-effort teardown */ }
  process.exit(1);
});

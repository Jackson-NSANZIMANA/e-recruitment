// ══════════════════════════════════════════════════════════════════
// verify-agency-record-check — RNP can reach a QR (LIVE Postgres; ADR-033 amendments)
//
// The defect: with the Irembo certificate flow, the criminal gate is answered only
// by a certificate number. RNP asks for no certificate, so its applicants' criminal
// gate stayed PENDING for ever and no one reached a slot or a QR.
//
// Proven here on a real database, through the real projection and accept:
//   • a category that asks for NO certificate: the first verdict puts the criminal
//     gate in officer review (UNDER_REVIEW); with the sandbox rule on, the exam goes
//     ahead (DOCUMENT_REVIEW_GREEN) once age and academic pass; with it off, the row
//     waits at CRIMINAL_CLEARANCE (production keeps ADR-033's rule);
//   • a category that ASKS for the certificate is untouched: still PENDING, waiting
//     for the citizen's number;
//   • the agency check never starts with the Irembo flow off;
//   • acceptance refuses while the criminal hold is open (NOT_APPLICABLE + lanes).
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import type { Agency, ApplicationCategory } from '@usrp/shared-types';
import { PgApplicationRepository, PgOfficerTransitionRepository } from '../src/index.js';

const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const CITIZEN = 'b7000000-0000-4000-8000-000000000001';
const CITIZEN_2 = 'b7000000-0000-4000-8000-000000000002';
const CITIZEN_3 = 'b7000000-0000-4000-8000-000000000003';
const CITIZENS = [CITIZEN, CITIZEN_2, CITIZEN_3];
const RNP_CAMPAIGN = 'b7000000-0000-4000-8000-0000000000c1';
const RDF_CAMPAIGN = 'b7000000-0000-4000-8000-0000000000c2';
const RNP_POLICY = 'b7000000-0000-4000-8000-0000000000d1';
const RDF_POLICY = 'b7000000-0000-4000-8000-0000000000d2';
const RNP_ON = 'b7000000-0000-4000-8000-00000000a001';
const RNP_OFF = 'b7000000-0000-4000-8000-00000000a002';
const RNP_RIBHASH = 'b7000000-0000-4000-8000-00000000a003';
const RDF_ON = 'b7000000-0000-4000-8000-00000000a004';
const RNP_APPS = [RNP_ON, RNP_OFF, RNP_RIBHASH];
const OFFICER = 'b7000000-0000-4000-8000-00000000ff01';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rnp_ops.application_status_history WHERE application_id IN ${tx(RNP_APPS)}`;
    await tx`DELETE FROM rnp_ops.applications WHERE id IN ${tx(RNP_APPS)}`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id = ${RDF_ON}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id = ${RDF_ON}`;
    await tx`UPDATE public_core.recruitment_campaigns SET current_policy_version_id = NULL WHERE id IN ${tx([RNP_CAMPAIGN, RDF_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.campaign_policy_versions WHERE id IN ${tx([RNP_POLICY, RDF_POLICY])}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([RNP_CAMPAIGN, RDF_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(CITIZENS)}`;
  });
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    for (const [id, hash] of [[CITIZEN, 'b7'.repeat(32)], [CITIZEN_2, 'b8'.repeat(32)], [CITIZEN_3, 'b9'.repeat(32)]] as const) {
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
           encrypted_home_district, encrypted_home_province, gender, registration_channel, identity_status)
        VALUES (${id}, ${hash}, 'x','x','x','x','MALE','WEB','VERIFIED'::public_core.identity_verification_status)`;
    }
    await tx`SET LOCAL session_replication_role = replica`;
    const campaigns: [string, string, Agency, ApplicationCategory][] = [
      [RNP_CAMPAIGN, 'RNP-AGENCYCHECK-A', 'RNP', 'BASIC_POLICE_COURSE'],
      [RDF_CAMPAIGN, 'RDF-AGENCYCHECK-A', 'RDF', 'GENERAL_ENLISTMENT'],
    ];
    for (const [id, code, agency, category] of campaigns) {
      await tx`
        INSERT INTO public_core.recruitment_campaigns
          (id, public_code, campaign_label, agency, status, target_categories,
           registration_opens_at, registration_closes_at, examination_start_date,
           examination_end_date, examination_reporting_hour)
        VALUES (${id}, ${code}, ${`agency record check ${code}`}, ${agency}, 'REGISTRATION_OPEN', ${JSON.stringify([category])},
                now() - interval '1 day', now() + interval '30 days', '2026-12-01', '2026-12-10', 7)`;
    }
    // RNP as printed: no criminal-record certificate. RDF: it is required.
    const policies: [string, string, Agency, ApplicationCategory, string[]][] = [
      [RNP_POLICY, RNP_CAMPAIGN, 'RNP', 'BASIC_POLICE_COURSE', ['NATIONAL_ID', 'GOOD_CONDUCT_CERTIFICATE']],
      [RDF_POLICY, RDF_CAMPAIGN, 'RDF', 'GENERAL_ENLISTMENT', ['NATIONAL_ID', 'NON_CONVICTION_CERTIFICATE']],
    ];
    for (const [id, campaign, agency, category, required] of policies) {
      await tx`
        INSERT INTO public_core.campaign_policy_versions
          (id, campaign_id, agency, version_number, policy_document, policy_hash,
           hash_version, legal_basis_code, legal_basis_reference, created_by)
        VALUES (${id}, ${campaign}, ${agency}, 1, ${tx.json({ [category]: { requiredDocumentTypes: required } })},
                ${'e'.repeat(64)}, 1, 'TEST', 'selfcheck', ${OFFICER})`;
    }
    await tx`
      INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status, policy_version_id)
      VALUES (${RNP_ON}, 'RNP-97401', ${CITIZEN}, ${RNP_CAMPAIGN}, 'BASIC_POLICE_COURSE', 'SUBMITTED', ${RNP_POLICY}),
             (${RNP_OFF}, 'RNP-97402', ${CITIZEN_2}, ${RNP_CAMPAIGN}, 'BASIC_POLICE_COURSE', 'SUBMITTED', ${RNP_POLICY}),
             (${RNP_RIBHASH}, 'RNP-97403', ${CITIZEN_3}, ${RNP_CAMPAIGN}, 'BASIC_POLICE_COURSE', 'SUBMITTED', ${RNP_POLICY})`;
    await tx`
      INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status, policy_version_id)
      VALUES (${RDF_ON}, 'RDF-97404', ${CITIZEN}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT', 'SUBMITTED', ${RDF_POLICY})`;
  });
}

async function state(schema: 'rnp_ops' | 'rdf_ops', id: string): Promise<{ status: string; criminal: string }> {
  const rows = await admin<{ status: string; criminal: string }[]>`
    SELECT status::text AS status, criminal_clearance_status::text AS criminal FROM ${admin(schema)}.applications WHERE id = ${id}`;
  return rows[0] ?? { status: 'MISSING', criminal: 'MISSING' };
}

async function passAgeAndAcademic(repo: PgApplicationRepository, agency: Agency, id: string): Promise<void> {
  await repo.applyVettingResult({ dimension: 'AGE', applicationId: id, agency, ageStatus: 'ELIGIBLE', detail: { eligible: true }, correlationId: 'agency-check' });
  await repo.applyVettingResult({ dimension: 'ACADEMIC', applicationId: id, agency, academicStatus: 'ELIGIBLE', verifiedVia: 'NESA', requestId: 'agency-check', detail: { eligible: true }, correlationId: 'agency-check' });
}

async function main(): Promise<void> {
  console.log('\n══ application-service — agency record check: RNP reaches the exam (LIVE) ══');
  await cleanup();
  await seed();

  const sandbox = new PgApplicationRepository({ clearanceContentReviewAdmitsToExam: true, agencyRecordCheck: true });
  const production = new PgApplicationRepository({ clearanceContentReviewAdmitsToExam: false, agencyRecordCheck: true });
  const ribHash = new PgApplicationRepository({});

  // 1. The first verdict hands an RNP criminal gate to an officer.
  await sandbox.applyVettingResult({ dimension: 'AGE', applicationId: RNP_ON, agency: 'RNP', ageStatus: 'ELIGIBLE', detail: { eligible: true }, correlationId: 'agency-check' });
  check('RNP (no certificate asked): the first verdict puts the criminal gate in officer review', (await state('rnp_ops', RNP_ON)).criminal === 'UNDER_REVIEW', JSON.stringify(await state('rnp_ops', RNP_ON)));

  // 2. Sandbox rule on: age + academic pass → the exam goes ahead (slot, SMS, QR follow GREEN).
  await sandbox.applyVettingResult({ dimension: 'ACADEMIC', applicationId: RNP_ON, agency: 'RNP', academicStatus: 'ELIGIBLE', verifiedVia: 'NESA', requestId: 'agency-check', detail: { eligible: true }, correlationId: 'agency-check' });
  const on = await state('rnp_ops', RNP_ON);
  check('sandbox rule on: RNP reaches DOCUMENT_REVIEW_GREEN while the officer check is open', on.status === 'DOCUMENT_REVIEW_GREEN' && on.criminal === 'UNDER_REVIEW', JSON.stringify(on));

  // 3. Production (rule off): the officer check starts, the exam waits for the decision.
  await passAgeAndAcademic(production, 'RNP', RNP_OFF);
  const off = await state('rnp_ops', RNP_OFF);
  check('rule off (production): RNP is in officer review and waits at CRIMINAL_CLEARANCE', off.status === 'CRIMINAL_CLEARANCE' && off.criminal === 'UNDER_REVIEW', JSON.stringify(off));

  // 4. The Irembo flow off (RIB_HASH answers every category): nothing changes.
  await passAgeAndAcademic(ribHash, 'RNP', RNP_RIBHASH);
  check('Irembo flow off: the agency check never starts (RIB_HASH answers)', (await state('rnp_ops', RNP_RIBHASH)).criminal === 'PENDING');

  // 5. A category that ASKS for the certificate waits for the citizen's number.
  await passAgeAndAcademic(sandbox, 'RDF', RDF_ON);
  const rdf = await state('rdf_ops', RDF_ON);
  check('RDF (certificate asked): the criminal gate stays PENDING, no exam yet', rdf.criminal === 'PENDING' && rdf.status !== 'DOCUMENT_REVIEW_GREEN', JSON.stringify(rdf));

  // 6. Redelivery is idempotent.
  const again = await sandbox.applyVettingResult({ dimension: 'AGE', applicationId: RNP_ON, agency: 'RNP', ageStatus: 'ELIGIBLE', detail: { eligible: true }, correlationId: 'agency-check' });
  check('a redelivered verdict changes nothing', again.kind === 'NO_CHANGE', again.kind);

  // 7. Acceptance refuses while the officer check is open.
  await admin`UPDATE rnp_ops.applications SET status = 'FINAL_SHORTLIST' WHERE id = ${RNP_ON}`;
  const officers = new PgOfficerTransitionRepository(undefined, { clearanceContentReviewAdmitsToExam: true });
  const accept = await officers.accept({ actor: { agency: 'RNP', dbRole: 'usrp_rnp_officer', officerId: OFFICER, correlationId: 'agency-check' }, applicationId: RNP_ON });
  check('acceptance is refused with the CRIMINAL lane named', accept.kind === 'NOT_APPLICABLE' && 'heldLanes' in accept && (accept.heldLanes ?? []).includes('CRIMINAL'), JSON.stringify(accept));

  await cleanup();
  await admin.end();
  await sql.end();
  console.log(failures === 0 ? '\nAGENCY RECORD CHECK PROVEN (live) ✓' : `\nAGENCY RECORD CHECK FAILED: ${String(failures)} check(s)`);
  if (failures > 0) process.exit(1);
}

main().catch(async (error: unknown) => {
  console.error('SELF-CHECK CRASHED:', error);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});

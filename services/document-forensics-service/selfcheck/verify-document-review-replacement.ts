// ══════════════════════════════════════════════════════════════════
// document-forensics-service — LIVE proof that a re-upload withdraws the review
// (evaluation D14, ADR-032/ADR-048)
//
// THE DEFECT THIS PINS. A corrected re-upload overwrites the SAME object key, so
// the citizen keeps one document per type and no superseded national ID stays at
// rest under a key no row points at (domain/object-key.ts — deliberate, not a
// bug). The document row is therefore updated in place, and before this change
// it kept `human_reviewed_by_id / _at / human_review_decision`: the record went
// on claiming that a named officer had approved bytes they never saw, and the
// amber queue's join (`human_reviewed_by_id IS NULL`) dropped the NEW,
// unreviewed document out of the reviewer's queue.
//
// The fix is narrow on both sides, and both sides are proven here:
//   • the ingress path passes objectReplaced → the stamps are cleared;
//   • the analyze/ path does NOT → re-scoring the same stored object leaves a
//     human decision alone (a scan is not new content).
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   ADMIN_DATABASE_URL='postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY=... pnpm --filter @usrp/document-forensics-service selfcheck:review
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import type { ForensicsFlags } from '@usrp/shared-types';
import { PgDocumentRecordStore } from '../src/index.js';

const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const APPLICANT_ID = '9f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f';
const APPLICATION_ID = '9f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f';
const PROCESSING_CODE = 'RDF-99001';
const OBJECT_KEY = 'rdf/9f2f2f2f/ALEVEL_CERTIFICATE/v1.pdf';
const REVIEWER_ID = '9f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f';

const FLAGS: ForensicsFlags = {
  elaAnomalyDetected: null,
  fontMismatchDetected: null,
  stampCloneDetected: null,
  ganGeneratedDetected: null,
  c2paManifestValid: null,
  virusScanClean: true,
  metadataStripped: true,
  overallScore: 92,
};

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function fixture(): Promise<void> {
  await cleanup();
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${randomUUID().replace(/-/g, '')}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${APPLICATION_ID}, ${PROCESSING_CODE}, ${APPLICANT_ID}, ${randomUUID()},
            'GENERAL_ENLISTMENT', 'DOCUMENT_REVIEW_AMBER'::rdf_ops.application_status)`;
}

async function cleanup(): Promise<void> {
  await admin`DELETE FROM rdf_ops.document_records WHERE application_id = ${APPLICATION_ID}`;
  await admin`DELETE FROM rdf_ops.applications WHERE id = ${APPLICATION_ID}`;
  await admin`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
}

/** The officer's decision, stamped exactly as the amber adjudication writes it. */
async function stampReview(): Promise<void> {
  await admin`
    UPDATE rdf_ops.document_records SET
      human_reviewed_by_id = ${REVIEWER_ID},
      human_reviewed_at = now(),
      human_review_decision = 'CLEAR'
    WHERE application_id = ${APPLICATION_ID}`;
}

interface Stamps {
  readonly reviewer: string | null;
  readonly decision: string | null;
}
async function stamps(): Promise<Stamps> {
  const rows = await admin<{ reviewer: string | null; decision: string | null }[]>`
    SELECT human_reviewed_by_id AS reviewer, human_review_decision AS decision
    FROM rdf_ops.document_records WHERE application_id = ${APPLICATION_ID}`;
  return rows[0] ?? { reviewer: null, decision: null };
}

/** The amber queue's predicate: a flagged document a human has NOT reviewed. */
async function inAmberQueue(): Promise<boolean> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rdf_ops.document_records
    WHERE application_id = ${APPLICATION_ID}
      AND forensics_lane = 'AMBER'::rdf_ops.document_lane
      AND human_reviewed_by_id IS NULL`;
  return (rows[0]?.n ?? 0) > 0;
}

async function main(): Promise<void> {
  console.log('document review replacement — a re-upload withdraws the decision, a re-scan does not');
  const store = new PgDocumentRecordStore();
  const base = {
    applicationId: APPLICATION_ID,
    agency: 'RDF' as const,
    documentType: 'ALEVEL_CERTIFICATE' as const,
    objectBucket: 'usrp-documents',
    objectKey: OBJECT_KEY,
    fileSizeBytes: 2048,
    virusScanStatus: 'CLEAN' as const,
  };

  try {
    await fixture();

    console.log('\n── 1. first upload stores the verdict');
    const first = await store.recordVerdict({ ...base, verdict: { lane: 'GREEN', score: 92, flags: FLAGS } });
    check('the first upload is RECORDED', first.kind === 'RECORDED', JSON.stringify(first));
    check('nothing to withdraw on a first upload', first.kind === 'RECORDED' && first.reviewCleared !== true);

    console.log('\n── 2. a human decision is stamped on the stored bytes');
    await stampReview();
    check('the fixture officer decision is on the row', (await stamps()).reviewer === REVIEWER_ID);

    console.log('\n── 3. analyze/ re-scores the SAME object and must not withdraw it');
    const reanalyzed = await store.recordVerdict({ ...base, verdict: { lane: 'GREEN', score: 88, flags: FLAGS } });
    const afterRescore = await stamps();
    check('a re-analysis reports no withdrawal', reanalyzed.kind === 'RECORDED' && reanalyzed.reviewCleared !== true);
    check('the human decision SURVIVES a re-scan', afterRescore.reviewer === REVIEWER_ID && afterRescore.decision === 'CLEAR', JSON.stringify(afterRescore));

    console.log('\n── 4. a corrected re-upload REPLACES the bytes and withdraws the decision');
    const replaced = await store.recordVerdict({ ...base, objectReplaced: true, verdict: { lane: 'AMBER', score: 55, flags: FLAGS } });
    const afterReplace = await stamps();
    check('the replacement reports the withdrawal', replaced.kind === 'RECORDED' && replaced.reviewCleared === true, JSON.stringify(replaced));
    check('the reviewer stamps are GONE', afterReplace.reviewer === null && afterReplace.decision === null, JSON.stringify(afterReplace));
    check('the replaced document is back in the amber queue', await inAmberQueue());
    check('the row is still ONE row per (application, object key)', (await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.document_records WHERE application_id = ${APPLICATION_ID}`)[0]?.n === 1);

    console.log('\n── 5. a replacement of an UNREVIEWED document withdraws nothing');
    const again = await store.recordVerdict({ ...base, objectReplaced: true, verdict: { lane: 'AMBER', score: 54, flags: FLAGS } });
    check('no review to clear → reviewCleared is false', again.kind === 'RECORDED' && again.reviewCleared === false, JSON.stringify(again));

    console.log('\n── 6. the cross-agency guard still holds');
    const wrongAgency = await store.recordVerdict({ ...base, agency: 'RNP', verdict: { lane: 'GREEN', score: 92, flags: FLAGS } });
    check('an RDF application claimed by RNP → APPLICATION_NOT_FOUND', wrongAgency.kind === 'APPLICATION_NOT_FOUND', JSON.stringify(wrongAgency));
  } finally {
    await cleanup().catch((error: unknown) => { console.error('cleanup failed', error); });
    await Promise.all([sql.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
  }

  console.log(`\nDOCUMENT REVIEW REPLACEMENT: ${String(pass)} passed, ${String(fail)} failed`);
  console.log(fail === 0 ? '✓ a replaced document never keeps a review of bytes that no longer exist' : '✗ D14 NOT PROVEN');
  if (fail > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('SELF-CHECK CRASHED:', error);
  process.exitCode = 1;
});

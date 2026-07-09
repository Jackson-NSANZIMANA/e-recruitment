// ══════════════════════════════════════════════════════════════════
// application-service — Lifecycle monotonicity self-check (pure domain)
//
// deriveApplicationStatus is the projection's decision core, and it makes ONE
// load-bearing promise (stated in its own header): the top-level status is
// MONOTONIC — it never regresses to an earlier stage. Every consumer of the
// application aggregate relies on that: scheduling fires on the transition INTO
// DOCUMENT_REVIEW_GREEN, and application-service re-emits
// APPLICATION_ELIGIBILITY_CLEARED on it. If a redelivered vetting event can pull
// a row that is already SCHEDULED back to GREEN, it re-fires scheduling and
// re-mints the applicant's exam invitation — a correctness AND compliance defect.
//
// This proof pins that invariant deterministically, with no infrastructure: it
// exercises deriveApplicationStatus directly. It is the executable spec for the
// GREEN → SLOT_ASSIGNED seam and everything downstream of it.
//
//   npx tsx services/application-service/selfcheck/verify-lifecycle.ts
// ══════════════════════════════════════════════════════════════════

import { APPLICATION_STATUSES, type ApplicationStatus } from '@usrp/shared-types';
import { deriveApplicationStatus, type VettingEvidence } from '../src/domain/lifecycle.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const ALL_PASS: VettingEvidence = {
  ageStatus: 'ELIGIBLE',
  academicStatus: 'ELIGIBLE',
  criminalStatus: 'CLEARED',
};
const ALL_PENDING: VettingEvidence = {
  ageStatus: 'PENDING',
  academicStatus: 'PENDING',
  criminalStatus: 'PENDING',
};

console.log('\n── Forward advance within the vetting ladder ──');
// The evidence accumulates; each new verdict advances one stage, never skips backward.
check(
  'SUBMITTED + academic verdict → ACADEMIC_VETTING',
  deriveApplicationStatus('SUBMITTED', { ...ALL_PENDING, academicStatus: 'ELIGIBLE' }) ===
    'ACADEMIC_VETTING',
);
check(
  'ACADEMIC_VETTING + criminal verdict → CRIMINAL_CLEARANCE',
  deriveApplicationStatus('ACADEMIC_VETTING', {
    ...ALL_PENDING,
    academicStatus: 'ELIGIBLE',
    criminalStatus: 'CLEARED',
  }) === 'CRIMINAL_CLEARANCE',
);
check(
  'CRIMINAL_CLEARANCE + all pass → DOCUMENT_REVIEW_GREEN',
  deriveApplicationStatus('CRIMINAL_CLEARANCE', ALL_PASS) === 'DOCUMENT_REVIEW_GREEN',
);

console.log('\n── MONOTONICITY: a redelivered vetting event never regresses a row ──');
// These are the statuses that live at or past the positive eligibility terminal.
// The three vetting gates run at-least-once; a redelivery that recomputes all-pass
// must be a NO-OP once the row has moved on — never a step back to GREEN.
const AT_OR_PAST_GREEN: readonly ApplicationStatus[] = [
  'DOCUMENT_REVIEW_GREEN',
  'DOCUMENT_REVIEW_AMBER',
  'SLOT_ASSIGNED',
  'PHYSICAL_TEST_SCHEDULED',
  'PHYSICAL_TEST_COMPLETE',
  'MEDICAL_REVIEW',
  'FINAL_SHORTLIST',
];
for (const status of AT_OR_PAST_GREEN) {
  const out = deriveApplicationStatus(status, ALL_PASS);
  check(`${status} + redelivered all-pass → stays ${status}`, out === status, `got ${out}`);
}

console.log('\n── Terminal states are never left ──');
for (const terminal of ['REJECTED', 'WITHDRAWN', 'ACCEPTED'] as const) {
  check(
    `${terminal} + all-pass → stays ${terminal}`,
    deriveApplicationStatus(terminal, ALL_PASS) === terminal,
  );
  check(
    `${terminal} + hard-fail → stays ${terminal}`,
    deriveApplicationStatus(terminal, { ...ALL_PASS, ageStatus: 'INELIGIBLE' }) === terminal,
  );
}

console.log('\n── Fail-closed policy preserved (in-vetting hard fail → REJECTED) ──');
// A hard fail while still IN the vetting ladder disqualifies (terminal REJECTED),
// overriding stage progress. This is deliberately unchanged by the monotonicity
// fix; late disqualification AFTER the eligibility terminal is a separate
// owner-policy question and is intentionally NOT auto-decided here.
check(
  'SUBMITTED + age INELIGIBLE → REJECTED',
  deriveApplicationStatus('SUBMITTED', { ...ALL_PASS, ageStatus: 'INELIGIBLE' }) === 'REJECTED',
);
check(
  'CRIMINAL_CLEARANCE + criminal FLAGGED_CONVICTION → REJECTED',
  deriveApplicationStatus('CRIMINAL_CLEARANCE', {
    ...ALL_PASS,
    criminalStatus: 'FLAGGED_CONVICTION',
  }) === 'REJECTED',
);

console.log('\n── Idempotence & no-evidence no-op ──');
check(
  'SUBMITTED + all pending → stays SUBMITTED',
  deriveApplicationStatus('SUBMITTED', ALL_PENDING) === 'SUBMITTED',
);
check(
  'DOCUMENT_REVIEW_GREEN + all pass → stays GREEN (idempotent)',
  deriveApplicationStatus('DOCUMENT_REVIEW_GREEN', ALL_PASS) === 'DOCUMENT_REVIEW_GREEN',
);

console.log('\n── Every non-terminal status: all-pass never yields an EARLIER stage ──');
// Exhaustive monotonicity sweep across the canonical ordering: for any current
// status, the derived status is never ranked lower than the current one.
const TERMINALS = new Set<ApplicationStatus>(['REJECTED', 'WITHDRAWN', 'ACCEPTED']);
const rank = (s: ApplicationStatus): number => APPLICATION_STATUSES.indexOf(s);
let regressions = 0;
for (const status of APPLICATION_STATUSES) {
  if (TERMINALS.has(status)) continue;
  const out = deriveApplicationStatus(status, ALL_PASS);
  // A move to a terminal fail is allowed (not a stage regression); a move to an
  // earlier NON-terminal stage is a regression.
  if (!TERMINALS.has(out) && rank(out) < rank(status)) {
    regressions += 1;
    console.error(`      regression: ${status} → ${out}`);
  }
}
check('no status regresses under redelivered all-pass evidence', regressions === 0);

console.log('\n───────────────────────────────────────────────');
if (failures === 0) console.log('LIFECYCLE MONOTONICITY PROVEN (pure domain) ✓');
else console.error(`${failures} ASSERTION(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);

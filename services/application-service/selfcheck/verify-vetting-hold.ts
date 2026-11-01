// ══════════════════════════════════════════════════════════════════
// application-service — VETTING HOLD PROOF (D10, zero infrastructure)
//
// THE DEFECT. The review queue (`listAmberQueue`) lists applications held on a
// criminal-clearance UNDER_REVIEW or on a NESA review. Every other item on that
// screen has a verb — an amber document hold is adjudicated. These two had a
// listing and nothing else: an officer could see the work and not do it, so the
// application sat in the queue forever while the citizen waited.
//
// THIS PROOF PINS FOUR THINGS, in the order a defect could hide:
//
//   1. THERE IS A VERB, and it is guarded by its own permission
//      (`vetting.hold.resolve`), not by the adjudication permission — the
//      accept side must be able to hold a resolver to four eyes.
//   2. THE REASON IS THE VERDICT. Each closed reason names a dimension and a
//      decision; a body that contradicts its own reason is refused, never
//      coerced, because an audit trail reading "REJECT / CLEARANCE_CONFIRMED"
//      is worse than a refusal.
//   3. THE PRECONDITION IS THE QUEUE'S. An application that is not genuinely
//      held cannot be "resolved": it is NOT_HELD (409) and nothing is written.
//      The verb's gate and the console's work item cannot drift.
//   4. FOUR EYES ON THE ACCEPT SIDE (CLEARANCE_REVIEW_EXCLUDES_ACCEPTER, ON by
//      default): the officer who resolved a hold may not accept that applicant.
//
// `§1`/`§2` run the REAL use case against a fake repository. `§3`/`§4` read the
// shipped source, because the predicate and the four-eyes read live in SQL and
// the accept transaction — where a fake would only test the fake. They are
// written as structural assertions with the exact anchors named, so a refactor
// that drops the rule fails here rather than in a live rehearsal.
// ══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryEventBus } from '@usrp/shared-events';
import {
  AMBER_QUEUE_ACTIONS,
  VETTING_HOLD_REASONS,
  VETTING_HOLD_DIMENSIONS,
  type VettingHoldReasonSpec,
} from '@usrp/shared-types';
import type { Principal } from '@usrp/shared-auth';
import { OfficerTransitionsService } from '../src/application/officer-transitions.service.js';
import type {
  AcceptInput,
  AcceptOutcome,
  AdjudicateInput,
  AdjudicateOutcome,
  FinalDecisionInput,
  MedicalReviewInput,
  OfficerTransitionOutcome,
  OfficerTransitionRepository,
  VettingHoldInput,
  VettingHoldOutcome,
} from '../src/ports/officer-transition-repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}
function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

const OFFICER_ID = 'a1000000-0000-4000-8000-00000000d001';
const APPLICATION = 'a1000000-0000-4000-8000-0000000000aa';
const context = { correlationId: 'd10', causationId: 'd10' };

const officer: Principal = {
  kind: 'officer',
  subjectId: OFFICER_ID,
  agency: 'RDF',
  roles: ['adjudicator'],
  posts: [],
} as unknown as Principal;

/** Records what the repository was asked to do, so "nothing was written" is provable. */
const calls: VettingHoldInput[] = [];
let nextOutcome: VettingHoldOutcome = {
  kind: 'APPLIED',
  dimension: 'CRIMINAL',
  fromStatus: 'CRIMINAL_CLEARANCE',
  toStatus: 'DOCUMENT_REVIEW_GREEN',
  statusChanged: true,
  clearedToGreen: true,
  applicantId: 'a1000000-0000-4000-8000-0000000000bb',
  campaignId: 'a1000000-0000-4000-8000-0000000000cc',
  category: 'GENERAL_ENLISTMENT',
};

/** Only `vettingHold` is on the path under test; the rest must never be reached. */
const repository: OfficerTransitionRepository = {
  medicalReview: (_input: MedicalReviewInput): Promise<OfficerTransitionOutcome> => Promise.reject(new Error('unexpected medicalReview')),
  finalDecision: (_input: FinalDecisionInput): Promise<OfficerTransitionOutcome> => Promise.reject(new Error('unexpected finalDecision')),
  accept: (_input: AcceptInput): Promise<AcceptOutcome> => Promise.reject(new Error('unexpected accept')),
  adjudicate: (_input: AdjudicateInput): Promise<AdjudicateOutcome> => Promise.reject(new Error('unexpected adjudicate')),
  vettingHold: (input: VettingHoldInput): Promise<VettingHoldOutcome> => {
    calls.push(input);
    return Promise.resolve(nextOutcome);
  },
} as OfficerTransitionRepository;

const bus = new InMemoryEventBus();
const service = new OfficerTransitionsService({ repository, eventBus: bus });
const published: { eventType: string; action?: string; metadata?: Record<string, unknown> }[] = [];
const originalPublish = bus.publish.bind(bus);
bus.publish = (event: never): Promise<void> => {
  const e = event as unknown as { eventType: string; action?: string; metadata?: Record<string, unknown> };
  published.push(e);
  return originalPublish(event);
};

// ── 1. The verb exists, and it is its own post ─────────────────────
section('1. The queue has a verb, and it carries its own authority');
const permissionSource = readFileSync(join(REPO, 'packages/shared-auth/src/permissions.ts'), 'utf8');
check(
  'vetting.hold.resolve is a declared permission',
  /'vetting\.hold\.resolve',/.test(permissionSource),
);
check(
  'it is granted to the adjudicator (the post that reads the evidence)',
  /adjudicator: new Set<Permission>\(\[[\s\S]{0,120}'vetting\.hold\.resolve'/.test(permissionSource),
);
check(
  'it is NOT granted to decision_authority — accept must not also resolve',
  /decision_authority: new Set<Permission>\(\[([^\]]*)\]\)/.exec(permissionSource)?.[1]?.includes('vetting.hold.resolve') !== true,
);
const edgeOps = readFileSync(join(REPO, 'services/edge-gateway/src/domain/edge-operations.ts'), 'utf8');
check(
  'the edge exposes exactly one vetting-hold operation, on its own permission',
  /resolveVettingHold:[\s\S]{0,260}permission: 'vetting\.hold\.resolve'/.test(edgeOps),
);
const serviceRoutes = readFileSync(
  join(REPO, 'services/application-service/src/adapters/http/officer-transitions.controller.ts'),
  'utf8',
);
check(
  'the service route requires vetting.hold.resolve, not adjudication.decide',
  /VETTING_HOLD_PATH,[\s\S]{0,600}requireOfficerPermission\(principal, 'vetting\.hold\.resolve'\)/.test(serviceRoutes),
);

// ── 2. The reason IS the verdict ───────────────────────────────────
section('2. The reason is the verdict: a contradictory body is refused, not coerced');
const contradiction = await service.vettingHold({
  actor: officer,
  applicationId: APPLICATION,
  dimension: 'ACADEMIC', // the reason says CRIMINAL
  decision: 'CLEAR',
  reason: 'CLEARANCE_CONFIRMED',
  notes: null,
  context,
});
check(
  'a CRIMINAL reason sent as ACADEMIC → INVALID_VETTING_HOLD_REASON (nothing written)',
  contradiction.kind === 'INVALID_VETTING_HOLD_REASON' && calls.length === 0,
  `${contradiction.kind}; ${String(calls.length)} repository call(s)`,
);

const flipped = await service.vettingHold({
  actor: officer,
  applicationId: APPLICATION,
  dimension: 'CRIMINAL',
  decision: 'REJECT', // the reason says CLEAR
  reason: 'CLEARANCE_CONFIRMED',
  notes: null,
  context,
});
check(
  'a CLEAR reason sent as REJECT → INVALID_VETTING_HOLD_REASON (nothing written)',
  flipped.kind === 'INVALID_VETTING_HOLD_REASON' && calls.length === 0,
);
const reasonSpecs: readonly VettingHoldReasonSpec[] = Object.values(VETTING_HOLD_REASONS);
check(
  'every reason names exactly one dimension and a verdict that writes evidence',
  reasonSpecs.every(
    (s) =>
      (s.dimension === 'CRIMINAL' ? s.criminalStatus !== undefined : s.academicStatus !== undefined) &&
      (s.decision === 'CLEAR'
        ? s.criminalStatus === undefined || s.criminalStatus === 'CLEARED'
        : s.criminalStatus === undefined || s.criminalStatus.startsWith('FLAGGED_')),
  ),
);
check(
  'the dimension set is closed to the two the queue can hold',
  VETTING_HOLD_DIMENSIONS.join(',') === 'CRIMINAL,ACADEMIC',
);

// ── 3. The precondition is the queue's ─────────────────────────────
section("3. The verb's precondition is the queue's predicate");
const readRepo = readFileSync(
  join(REPO, 'services/application-service/src/adapters/application-read.pg-repository.ts'),
  'utf8',
);
const writeRepo = readFileSync(
  join(REPO, 'services/application-service/src/adapters/officer-transition.pg-repository.ts'),
  'utf8',
);
check(
  'the queue lists a criminal hold on UNDER_REVIEW',
  /criminal_clearance_status::text = 'UNDER_REVIEW'/.test(readRepo),
);
check(
  'the resolve transaction requires the same UNDER_REVIEW, under the row lock',
  /criminal_clearance_status === 'UNDER_REVIEW'/.test(writeRepo) && /FOR UPDATE/.test(writeRepo),
);
check(
  'the queue lists a NESA review on PENDING + NESA_REVIEW_REQUIRED',
  /failureCode' = 'NESA_REVIEW_REQUIRED'/.test(readRepo),
);
check(
  'the resolve transaction requires the same NESA predicate',
  /'NESA_REVIEW_REQUIRED'/.test(writeRepo),
);
check(
  'the resolve writes the REASON evidence, never a value derived from prose',
  /criminalStatus: nextCriminal|nextCriminal = spec\.criminalStatus/.test(writeRepo) ||
    /const nextCriminal = spec\.criminalStatus/.test(writeRepo),
);
check(
  'a resolved row is re-derived by the pure lifecycle, not by a table here',
  /deriveApplicationStatus\(current\.status/.test(writeRepo),
);
check(
  'the resolver is a durable fact on the row (rls/0045), not an inference from history',
  /vetting_hold_resolved_by = \$\{actor\.officerId\}/.test(writeRepo),
);

// NOT_HELD is a no-op end-to-end: the use case must not audit a refusal.
calls.length = 0;
published.length = 0;
nextOutcome = { kind: 'NOT_HELD', dimension: 'CRIMINAL', currentStatus: 'DOCUMENT_REVIEW_AMBER' };
const notHeld = await service.vettingHold({
  actor: officer,
  applicationId: APPLICATION,
  dimension: 'CRIMINAL',
  decision: 'CLEAR',
  reason: 'CLEARANCE_CONFIRMED',
  notes: null,
  context,
});
check('a resolved-by-someone-else item → NOT_HELD (409 at the boundary)', notHeld.kind === 'NOT_HELD');
check('NOT_HELD writes no audit entry and announces nothing', published.length === 0, JSON.stringify(published));

// ── 4. Four eyes on the accept side ────────────────────────────────
section('4. Separation of duties: the resolver may not accept');
nextOutcome = {
  kind: 'APPLIED',
  dimension: 'CRIMINAL',
  fromStatus: 'CRIMINAL_CLEARANCE',
  toStatus: 'DOCUMENT_REVIEW_GREEN',
  statusChanged: true,
  clearedToGreen: true,
  applicantId: 'a1000000-0000-4000-8000-0000000000bb',
  campaignId: 'a1000000-0000-4000-8000-0000000000cc',
  category: 'GENERAL_ENLISTMENT',
};
calls.length = 0;
published.length = 0;
const applied = await service.vettingHold({
  actor: officer,
  applicationId: APPLICATION,
  dimension: 'CRIMINAL',
  decision: 'CLEAR',
  reason: 'CLEARANCE_CONFIRMED',
  notes: 'record obtained, no disqualifying entry',
  context,
});
check('a genuine resolution → APPLIED', applied.kind === 'APPLIED');
check(
  'the repository received the principal as the actor and the reason verbatim',
  calls.length === 1 &&
    calls[0]?.actor.officerId === OFFICER_ID &&
    calls[0]?.reason === 'CLEARANCE_CONFIRMED' &&
    calls[0]?.dimension === 'CRIMINAL',
);
check(
  'the trail records the closed reason code and the dimension',
  published.some(
    (e) =>
      e.eventType === 'AUDIT_ENTRY' &&
      e.metadata?.['reasonCode'] === 'CLEARANCE_CONFIRMED' &&
      e.metadata?.['dimension'] === 'CRIMINAL',
  ),
  JSON.stringify(published.map((e) => e.metadata)),
);
check(
  'reaching DOCUMENT_REVIEW_GREEN re-announces the clearance (the slot lane runs)',
  published.some((e) => e.eventType === 'APPLICATION_ELIGIBILITY_CLEARED'),
  JSON.stringify(published.map((e) => e.eventType)),
);
check(
  'the accept side refuses the resolver (rule ACCEPT_EXCLUDES_CLEARANCE_REVIEWER)',
  /clearanceReviewExcludesAccepter[\s\S]{0,400}'ACCEPT_EXCLUDES_CLEARANCE_REVIEWER'/.test(writeRepo),
);
const configSource = readFileSync(join(REPO, 'services/application-service/src/config.ts'), 'utf8');
check(
  'the rule is ON by default (an agency opts OUT, it does not opt in)',
  /SOD_CLEARANCE_REVIEW_EXCLUDES_ACCEPTER: withDefault\(boolean\(\), true\)/.test(configSource),
);
check(
  'the four-eyes read happens BEFORE the cross-agency lock (a refusal touches no shared row)',
  writeRepo.indexOf('ACCEPT_EXCLUDES_CLEARANCE_REVIEWER') < writeRepo.indexOf('Cross-agency accept-lock'),
);

// ── 5. The queue names the verb ────────────────────────────────────
// The other half of D10: the queue returned status + reasons and the console
// had to INFER which verb applied, which is how "Adjudicate" ends up offered on
// a row only a vetting-hold resolution can move.
section('5. The queue tells the console which verb applies');
check(
  'the action set is closed to the two verbs the queue can need',
  AMBER_QUEUE_ACTIONS.join(',') === 'ADJUDICATE,RESOLVE_VETTING_HOLD',
);
const readPort = readFileSync(
  join(REPO, 'services/application-service/src/ports/application-read-repository.ts'),
  'utf8',
);
check('the queue row carries the actions (not just status + reasons)', /readonly actions: readonly AmberQueueAction\[\]/.test(readPort));
check(
  'RESOLVE_VETTING_HOLD is derived from the same predicate the verb requires',
  /function queueActions[\s\S]{0,600}RESOLVE_VETTING_HOLD/.test(readRepo) &&
    /criminal_status === 'UNDER_REVIEW'/.test(readRepo),
);
const edgeProjections = readFileSync(
  join(REPO, 'services/edge-gateway/src/adapters/http/projections.ts'),
  'utf8',
);
check(
  'the edge filters the action set (an unknown verb never reaches a console)',
  /function queueActions[\s\S]{0,300}v === 'ADJUDICATE' \|\| v === 'RESOLVE_VETTING_HOLD'/.test(edgeProjections),
);
check(
  'the transition projection keeps statusChanged and the dimension (a status can hold)',
  /statusChanged\?: boolean/.test(edgeProjections) && /dimension\?: 'CRIMINAL' \| 'ACADEMIC'/.test(edgeProjections),
);

// ── Verdict ────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\u001b[0;32m' : '\u001b[0;31m'}${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
if (fail > 0) {
  console.error(`\nVETTING HOLD FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\u001b[0;32mVETTING HOLD OK\u001b[0m');

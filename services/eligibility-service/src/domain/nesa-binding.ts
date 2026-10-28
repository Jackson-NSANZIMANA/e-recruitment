// ══════════════════════════════════════════════════════════════════
// eligibility-service — the NESA gate: BIND, then evaluate (ADR-048 §2.2)
//
// Pure. Given the applicant's verified identity facts and the NESA results,
// decide what may happen next, in this order:
//
//   1. binding (shared-identity-match): NOT_BOUND stops here, as a
//      CORRECTABLE outcome ("this record does not match your identity"),
//      never an eligibility verdict; a PARTIAL name or an unreadable holder
//      field is REVIEW, and so is a binding that could not compare the NID
//      hint (an identity verified before rls/0042 holds none, and SDMS
//      carries no date of birth, so name and sex alone would decide);
//   2. published:false → PENDING (retried, never ineligible);
//   3. malpractice, an unrecognised level type, or a non-PASS division →
//      REVIEW (human), never automatic;
//   4. otherwise EVALUATE against the category's education requirement.
//
// The decision carries the binding's per-field results and reasons only:
// never a name, a hint or a date.
// ══════════════════════════════════════════════════════════════════

import { bindCredential, type BindingResult, type IdentityFacts } from '@usrp/shared-identity-match';
import type { QualificationLevel } from '@usrp/shared-types';
import type { NesaResults } from './nesa.types.js';

/** Codes recorded as eligibilityResult.failureCode on a PENDING academic verdict. */
export const NESA_GATE_CODES = {
  NOT_BOUND: 'NESA_RECORD_NOT_BOUND',
  UNPUBLISHED: 'NESA_RESULTS_UNPUBLISHED',
  REVIEW: 'NESA_REVIEW_REQUIRED',
} as const;

/**
 * Citizen-safe copy for NOT_BOUND. Names no other person and no value; the
 * applicant may correct the index number. (en; rw/fr belong to the frontend
 * i18n bundles, from the code.)
 */
export const NESA_NOT_BOUND_CITIZEN_MESSAGE =
  'This record does not match your identity. Check the examination index number and correct it if needed.';

export type NesaReviewReason = 'NAME_PARTIAL' | 'HOLDER_FIELD_UNREADABLE' | 'NID_HINT_NOT_COMPARED' | 'MALPRACTICE' | 'UNKNOWN_LEVEL_TYPE' | 'DIVISION_NOT_PASS';

export interface EducationFacts {
  readonly qualificationLevel: QualificationLevel;
  readonly percentageScore?: number;
}

export type NesaGateDecision =
  | { readonly kind: 'NOT_BOUND'; readonly binding: BindingResult }
  | { readonly kind: 'PENDING_UNPUBLISHED'; readonly binding: BindingResult }
  | { readonly kind: 'REVIEW'; readonly binding: BindingResult; readonly reasons: readonly NesaReviewReason[] }
  | { readonly kind: 'EVALUATE'; readonly binding: BindingResult; readonly facts: EducationFacts };

/** Divisions treated as a completed examination (observed: PASS). Default taken, owner to confirm. */
const PASSING_DIVISIONS: ReadonlySet<string> = new Set(['PASS']);

export function decideNesaGate(identity: IdentityFacts, results: NesaResults): NesaGateDecision {
  const binding = bindCredential(identity, {
    holderName: results.holder.name,
    sex: results.holder.sex,
    nationalIdHint: results.holder.nationalIdHint,
  }, { requiredFields: ['sex', 'nationalIdHint'] });
  if (binding.outcome === 'NOT_BOUND') return { kind: 'NOT_BOUND', binding };
  if (!results.published) return { kind: 'PENDING_UNPUBLISHED', binding };

  const reasons: NesaReviewReason[] = [];
  if (binding.outcome === 'REVIEW') reasons.push(binding.nameMatch === 'PARTIAL' ? 'NAME_PARTIAL' : 'HOLDER_FIELD_UNREADABLE');
  else if (binding.fields.nationalIdHint === 'NOT_COMPARED') reasons.push('NID_HINT_NOT_COMPARED');
  if (results.malpractice) reasons.push('MALPRACTICE');
  if (results.qualificationLevel === null) reasons.push('UNKNOWN_LEVEL_TYPE');
  if (!PASSING_DIVISIONS.has(results.division)) reasons.push('DIVISION_NOT_PASS');
  if (reasons.length > 0 || results.qualificationLevel === null) return { kind: 'REVIEW', binding, reasons };

  return {
    kind: 'EVALUATE',
    binding,
    facts: {
      qualificationLevel: results.qualificationLevel,
      ...(results.weightedPercent === null ? {} : { percentageScore: results.weightedPercent }),
    },
  };
}

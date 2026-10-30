// ══════════════════════════════════════════════════════════════════
// eligibility-service — the campaign's pinned policy v2 applied to the gates
// (ADR-049). PURE. Without a v2 block every function returns its input
// unchanged, so a v1-only campaign behaves exactly as before.
// ══════════════════════════════════════════════════════════════════

import {
  educationSatisfied,
  ageEnvelope,
  evaluateAgeForQualification,
  scienceSatisfied,
  type PolicyV2,
  type QualificationLevel,
  type SpecialistField,
} from '@usrp/shared-campaign-policy';
import { ageInYears } from './age-rules.js';
import type { EducationEligibilityResult } from './education-rules.js';

/** The pinned policy of one application's category. */
export interface PinnedPolicy {
  readonly v2: PolicyV2;
  /** The date the age is measured on (the v1 age.referenceDate). */
  readonly referenceDate: string;
}

/** Age gate: the band the campaign printed (its widest window; qualification caps narrow it at the academic gate). */
export function ageWindowFromPolicy(policy: PinnedPolicy): { readonly minAge: number; readonly maxAge: number } {
  const w = ageEnvelope(policy.v2);
  return { minAge: w.minimumAge, maxAge: w.maximumAge };
}

export interface QualificationEvidence {
  readonly level: QualificationLevel;
  readonly field: SpecialistField | null;
  readonly sciencePercent: number | undefined;
  readonly dateOfBirth: string;
}

/**
 * Academic gate under v2: education alternatives, the science bar, and the age cap BY QUALIFICATION
 * (both facts are known only here). A refusal names the cap, never the date of birth.
 */
export function applyPolicyV2Education<T extends EducationEligibilityResult>(
  result: T,
  policy: PinnedPolicy | null,
  evidence: QualificationEvidence,
): T {
  // v2 replaces the engine constants: it can tighten (a qualification cap) or widen (an alternative level).
  if (policy === null || result.academicStatus === 'PENDING') return result;
  const v2 = policy.v2;
  if (!educationSatisfied(v2, evidence.level)) {
    return { ...result, academicStatus: 'INELIGIBLE', meetsRequirement: false, reason: `Qualification ${evidence.level} is not one of the levels this campaign accepts.` };
  }
  if (!scienceSatisfied(v2, evidence.sciencePercent)) {
    return { ...result, academicStatus: 'INELIGIBLE', meetsRequirement: false, reason: `The secondary science mark does not reach the ${String(v2.minimumSciencePercent)}% this campaign requires.` };
  }
  let age: number;
  try {
    age = ageInYears(evidence.dateOfBirth, new Date(`${policy.referenceDate}T00:00:00Z`));
  } catch {
    return { ...result, academicStatus: 'INELIGIBLE', meetsRequirement: false, reason: 'The age could not be established against the campaign reference date.' };
  }
  const verdict = evaluateAgeForQualification(v2, { level: evidence.level, field: evidence.field }, age);
  if (!verdict.eligible) {
    const reason =
      verdict.code === 'ABOVE_CAP'
        ? `Age ${String(age)} exceeds the maximum age ${String(verdict.cap)} for a ${evidence.level} qualification in this campaign.`
        : verdict.code === 'BELOW_MINIMUM'
          ? `Age ${String(age)} is below the minimum age ${String(verdict.minimum)} for this campaign.`
          : `No age limit in this campaign covers a ${evidence.level} qualification.`;
    return { ...result, academicStatus: 'INELIGIBLE', meetsRequirement: false, reason };
  }
  return { ...result, academicStatus: 'ELIGIBLE', meetsRequirement: true, reason: `Qualification ${evidence.level} and age ${String(age)} satisfy this campaign's policy.` };
}

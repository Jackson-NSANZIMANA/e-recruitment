// ══════════════════════════════════════════════════════════════════
// eligibility-service — Education eligibility rules (pure domain)
//
// The academic gate for the NESA (A-Level) path: given a category and a
// NESA-verified results payload, decide whether the candidate's
// qualification meets that category's education requirement, using the
// ground-truth EDUCATION_REQUIREMENTS from the official announcements.
// Pure and deterministic — no I/O, no clock of its own (the caller passes
// `asOf`), so it is trivially testable and reused wherever academic
// eligibility is computed.
//
// SCOPE: this evaluates the NESA/A-Level requirement (accepted level +, for
// the RCS 4-year UR track, the ≥70% science threshold). Degree (HEC) paths
// and the UR-program match (which needs the applicant's DECLARED program,
// not present in a NESA results payload) are handled in the HEC slice.
// ══════════════════════════════════════════════════════════════════

import {
  EDUCATION_REQUIREMENTS,
  type AcademicEligibilityStatus,
  type ApplicationCategory,
  type EducationLevel,
  type NESAVerifiedPayload,
  type QualificationLevel,
} from '@usrp/shared-types';

/**
 * Map a NESA qualification level onto the canonical education-level ladder.
 * NESA reports secondary-completion levels; the ladder is what the accepted
 * levels in EDUCATION_REQUIREMENTS are expressed in. Total over the three
 * QualificationLevel values so the mapping can never silently drop one.
 */
export const NESA_QUALIFICATION_TO_EDUCATION_LEVEL: Readonly<
  Record<QualificationLevel, EducationLevel>
> = {
  A2: 'A_LEVEL_A2',
  A1: 'A1_IPRC',
  O_LEVEL: 'O_LEVEL_S3',
} as const;

/** The academic verdict for the NESA path, carrying only derived facts. */
export interface EducationEligibilityResult {
  readonly academicStatus: AcademicEligibilityStatus; // ELIGIBLE | INELIGIBLE
  /** True iff every applicable NESA requirement is satisfied. */
  readonly meetsRequirement: boolean;
  readonly reason: string;
  /** The category's minimum required level (for transparency in the audit). */
  readonly requiredMinLevel: EducationLevel;
  /** The candidate's level as mapped from the NESA qualification. */
  readonly evaluatedLevel: EducationLevel;
  readonly evaluationDate: string;
}

/**
 * Evaluate the NESA/A-Level education gate for `category` against a
 * NESA-verified `payload`. `asOf` stamps the evaluation date only.
 *
 * Preconditions: the category is a NESA-verified category (caller enforces
 * `EDUCATION_REQUIREMENTS[category].nesaVerificationRequired`). Fails CLOSED
 * — any unmet or unverifiable requirement yields INELIGIBLE, never a throw.
 */
export function evaluateNesaEducation(
  category: ApplicationCategory,
  payload: NESAVerifiedPayload,
  asOf: Date,
): EducationEligibilityResult {
  const requirement = EDUCATION_REQUIREMENTS[category];
  const evaluatedLevel = NESA_QUALIFICATION_TO_EDUCATION_LEVEL[payload.qualificationLevel];
  const evaluationDate = asOf.toISOString();

  const meetsLevel = requirement.acceptedLevels.includes(evaluatedLevel);

  // The RCS 4-year UR track additionally requires a science score ≥ threshold.
  // If the requirement demands a percentage the payload does not carry, we
  // cannot verify it — fail closed rather than pass on missing data.
  const scoreThreshold = requirement.minScienceGradePercent;
  const scienceApplies = scoreThreshold !== undefined;
  const scienceScore = payload.percentageScore;
  const meetsScience =
    !scienceApplies || (scienceScore !== undefined && scienceScore >= scoreThreshold);

  const meetsRequirement = meetsLevel && meetsScience;

  const reason = meetsRequirement
    ? `Qualification ${evaluatedLevel} satisfies the ${requirement.minLevel} requirement for ${category}${
        scienceApplies ? ` (science ${String(scienceScore)}% ≥ ${scoreThreshold}%)` : ''
      }.`
    : !meetsLevel
      ? `Qualification ${evaluatedLevel} does not meet the ${requirement.minLevel} minimum for ${category}.`
      : scienceScore === undefined
        ? `Category ${category} requires a science score ≥ ${scoreThreshold}% but NESA returned none.`
        : `Science score ${scienceScore}% is below the ${scoreThreshold}% minimum for ${category}.`;

  return {
    academicStatus: meetsRequirement ? 'ELIGIBLE' : 'INELIGIBLE',
    meetsRequirement,
    reason,
    requiredMinLevel: requirement.minLevel,
    evaluatedLevel,
    evaluationDate,
  };
}

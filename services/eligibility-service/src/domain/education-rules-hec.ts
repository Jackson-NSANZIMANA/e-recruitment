// ══════════════════════════════════════════════════════════════════
// eligibility-service — HEC (degree/diploma) education rules (pure domain)
//
// The academic gate for the HEC path: given a category and an HEC-verified
// degree payload, decide whether the credential meets that category's
// education requirement. Two checks:
//   1. LEVEL — the degree's education level is among the category's
//      accepted levels (EDUCATION_REQUIREMENTS, ground truth).
//   2. SPECIALIST FIELD — for the two specialist categories, the degree's
//      field must be one the category recognises (the field that also
//      justifies the relaxed maximum age — the age-exception seam).
//
// Pure and deterministic — no I/O, no clock of its own. Fails CLOSED: any
// unmet or unverifiable requirement yields INELIGIBLE, never a throw.
//
// The age-exception seam: a degree category carries a higher maxAge than
// the base 18–25 band (university +1, specialist +2). That relaxed band is
// applied by the AGE gate via AGE_CRITERIA[category].maxAge; it is only
// legitimate because a qualifying degree is required and verified HERE.
// This module surfaces `appliedMaxAge` + `ageExceptionApplies` so the
// linkage is explicit and auditable, without re-running the age gate.
// ══════════════════════════════════════════════════════════════════

import {
  AGE_CRITERIA,
  EDUCATION_REQUIREMENTS,
  RDF_SPECIALIST_FIELDS,
  RCS_SPECIALIST_FIELDS,
  type ApplicationCategory,
  type EducationLevel,
  type HECVerifiedPayload,
} from '@usrp/shared-types';
import type { EducationEligibilityResult } from './education-rules.js';

/** The base maximum age before any degree-driven exception. */
const BASE_MAX_AGE = 25;

/**
 * Specialist categories whose eligibility additionally requires the degree
 * to be in one of a recognised set of fields. Non-specialist degree
 * categories (university/officer tracks) have no field restriction.
 */
const SPECIALIST_FIELDS_BY_CATEGORY: Partial<Record<ApplicationCategory, readonly string[]>> = {
  RESERVE_FORCE_SPECIALIST: RDF_SPECIALIST_FIELDS,
  OFFICER_ONE_YEAR_SPECIALIST: RCS_SPECIALIST_FIELDS,
};

/** The HEC academic verdict, extending the shared education result with the
 * age-exception linkage this path is responsible for. */
export interface HecEducationEligibilityResult extends EducationEligibilityResult {
  /** The category's maximum age (relaxed for degree categories). */
  readonly appliedMaxAge: number;
  /** True when appliedMaxAge exceeds the base band — a degree-driven exception. */
  readonly ageExceptionApplies: boolean;
  /** The degree's specialist field, when the category recognises one. */
  readonly specialistField: string | null;
}

/**
 * Evaluate the HEC/degree education gate for `category` against an
 * HEC-verified `payload`. `asOf` stamps the evaluation date only.
 *
 * Precondition: the category is an HEC-verified category (caller enforces
 * `EDUCATION_REQUIREMENTS[category].hecVerificationRequired`).
 */
export function evaluateHecEducation(
  category: ApplicationCategory,
  payload: HECVerifiedPayload,
  asOf: Date,
): HecEducationEligibilityResult {
  const requirement = EDUCATION_REQUIREMENTS[category];
  const evaluatedLevel: EducationLevel = payload.educationLevel;
  const evaluationDate = asOf.toISOString();

  const meetsLevel = requirement.acceptedLevels.includes(evaluatedLevel);

  const requiredFields = SPECIALIST_FIELDS_BY_CATEGORY[category];
  const specialistApplies = requiredFields !== undefined;
  const meetsSpecialist =
    !specialistApplies ||
    (payload.specialistField !== null && requiredFields.includes(payload.specialistField));

  const meetsRequirement = meetsLevel && meetsSpecialist;

  const appliedMaxAge = AGE_CRITERIA[category].maxAge;
  const ageExceptionApplies = appliedMaxAge > BASE_MAX_AGE;

  const reason = meetsRequirement
    ? `Degree ${evaluatedLevel} satisfies the ${requirement.minLevel} requirement for ${category}${
        specialistApplies ? ` (specialist field ${String(payload.specialistField)} recognised)` : ''
      }${ageExceptionApplies ? `; qualifies the relaxed maximum age of ${appliedMaxAge}` : ''}.`
    : !meetsLevel
      ? `Degree level ${evaluatedLevel} does not meet the ${requirement.minLevel} minimum for ${category}.`
      : payload.specialistField === null
        ? `Category ${category} requires a recognised specialist field but the degree declares none.`
        : `Specialist field ${payload.specialistField} is not recognised for ${category}.`;

  return {
    academicStatus: meetsRequirement ? 'ELIGIBLE' : 'INELIGIBLE',
    meetsRequirement,
    reason,
    requiredMinLevel: requirement.minLevel,
    evaluatedLevel,
    evaluationDate,
    appliedMaxAge,
    ageExceptionApplies,
    specialistField: payload.specialistField,
  };
}

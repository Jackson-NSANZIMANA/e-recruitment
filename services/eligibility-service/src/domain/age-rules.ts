// ══════════════════════════════════════════════════════════════════
// eligibility-service — Age eligibility rules (pure domain)
//
// The canonical age gate: given a category and a date of birth, decide
// whether the applicant's age falls within that category's band, using
// the ground-truth AGE_CRITERIA from the official announcements. Pure and
// deterministic — no I/O, no clock of its own (the caller passes `asOf`),
// so it is trivially testable and reused wherever eligibility is computed.
//
// NOTE: this evaluates the BASE min/max band. Education/specialist age
// exceptions (e.g. +1/+2 years for university/specialist tracks) require
// verified NESA/HEC data and are applied in the education slice, not here.
// ══════════════════════════════════════════════════════════════════

import { AGE_CRITERIA, type AgeEligibilityResult, type ApplicationCategory } from '@usrp/shared-types';
import { InvalidDateOfBirthError } from './eligibility.errors.js';

const DOB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whole years elapsed between `dateOfBirth` (YYYY-MM-DD) and `asOf`, in UTC. */
export function ageInYears(dateOfBirth: string, asOf: Date): number {
  if (!DOB_PATTERN.test(dateOfBirth)) {
    throw new InvalidDateOfBirthError('expected format YYYY-MM-DD');
  }
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) {
    throw new InvalidDateOfBirthError('not a real calendar date');
  }
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - dob.getUTCMonth();
  // Not yet had this year's birthday? subtract one.
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/** Evaluate the age band for `category` against `dateOfBirth` as of `asOf`. */
export function evaluateAgeEligibility(
  category: ApplicationCategory,
  dateOfBirth: string,
  asOf: Date,
): AgeEligibilityResult {
  const criteria = AGE_CRITERIA[category];
  const age = ageInYears(dateOfBirth, asOf);
  const appliedMaxAge = criteria.maxAge; // base cap; exceptions handled in the education slice
  const eligible = age >= criteria.minAge && age <= appliedMaxAge;

  const reason = eligible
    ? `Age ${age} is within the ${criteria.minAge}–${appliedMaxAge} band for ${category}.`
    : age < criteria.minAge
      ? `Age ${age} is below the minimum age ${criteria.minAge} for ${category}.`
      : `Age ${age} exceeds the maximum age ${appliedMaxAge} for ${category}.`;

  return {
    eligible,
    ageAtEvaluation: age,
    dateOfBirth, // PII — carried in the domain result but stripped at every edge (HTTP/event)
    evaluationDate: asOf.toISOString(),
    reason,
    appliedMaxAge,
  };
}

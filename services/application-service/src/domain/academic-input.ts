// ══════════════════════════════════════════════════════════════════
// application-service — Academic-input rule (pure domain)
//
// APPLICANT_SUBMITTED carries two academic-verification inputs — a NESA
// index number (A-Level path) and an HEC registration number (degree
// path) — of which exactly one is populated and the other null. Which one
// a given category needs is not a free choice: it is fixed by the
// ground-truth EDUCATION_REQUIREMENTS in @usrp/shared-types
// (nesaVerificationRequired vs hecVerificationRequired).
//
// This rule maps a category to its required credential and validates that
// the submission carries it. Pure and deterministic — no I/O — so it is
// trivially testable and cannot drift from the requirements table.
// ══════════════════════════════════════════════════════════════════

import { EDUCATION_REQUIREMENTS, type ApplicationCategory } from '@usrp/shared-types';

/** Which academic registry must verify this category's qualification. */
export type AcademicPath = 'NESA' | 'HEC';

/** The resolved academic inputs for the submitted event (exactly one non-null). */
export interface ResolvedAcademicInputs {
  readonly path: AcademicPath;
  readonly nesaIndexNumber: string | null;
  readonly hecRegistrationNumber: string | null;
}

/** Outcome of validating a submission's academic inputs against its category. */
export type AcademicInputResult =
  | { readonly ok: true; readonly resolved: ResolvedAcademicInputs }
  | { readonly ok: false; readonly reason: string };

/** The academic registry a category is verified through (total over the table). */
export function academicPathForCategory(category: ApplicationCategory): AcademicPath {
  const requirement = EDUCATION_REQUIREMENTS[category];
  // The table is authored so exactly one of the two flags is true per
  // category. HEC (degree) takes precedence if both were ever set — degree
  // holders are verified through HEC, not NESA.
  if (requirement.hecVerificationRequired) return 'HEC';
  if (requirement.nesaVerificationRequired) return 'NESA';
  // No category in the ground-truth table leaves both false; guard anyway.
  throw new Error(`Category "${category}" declares no academic verification path`);
}

/**
 * Resolve and validate the academic inputs a submission provides against
 * the credential its category requires. The caller passes whatever the
 * applicant supplied (either may be absent); this returns the canonical
 * {nesaIndexNumber, hecRegistrationNumber} pair for the event, or a
 * business reason the submission is rejected. Fails CLOSED — a missing
 * required credential is a rejection, never a silent null.
 */
export function resolveAcademicInputs(
  category: ApplicationCategory,
  supplied: { readonly nesaIndexNumber?: string | null; readonly hecRegistrationNumber?: string | null },
): AcademicInputResult {
  const path = academicPathForCategory(category);
  const nesa = normalize(supplied.nesaIndexNumber);
  const hec = normalize(supplied.hecRegistrationNumber);

  if (path === 'NESA') {
    if (nesa === null) {
      return { ok: false, reason: `Category "${category}" requires a NESA index number.` };
    }
    return { ok: true, resolved: { path, nesaIndexNumber: nesa, hecRegistrationNumber: null } };
  }

  // path === 'HEC'
  if (hec === null) {
    return { ok: false, reason: `Category "${category}" requires an HEC registration number.` };
  }
  return { ok: true, resolved: { path, nesaIndexNumber: null, hecRegistrationNumber: hec } };
}

/** Trim to a non-empty string, or null. */
function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

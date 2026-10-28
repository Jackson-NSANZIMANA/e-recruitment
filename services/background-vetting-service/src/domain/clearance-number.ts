// The citizen-held Irembo application number: a letter, 12 digits, then 4 letters
// (ADR-048 §2.3, observed shape). Validation is shape only: whether it exists is
// the registry's answer.

export const CLEARANCE_NUMBER_PATTERN = /^[A-Z][0-9]{12}[A-Z]{4}$/;

/** Trim, drop spaces and hyphens people type, upper-case. */
export function normaliseClearanceNumber(raw: string): string {
  return raw.trim().replace(/[\s-]/g, '').toUpperCase();
}

/** The normalised number, or null when it is not in the observed shape. */
export function parseClearanceNumber(raw: string): string | null {
  const normalised = normaliseClearanceNumber(raw);
  return CLEARANCE_NUMBER_PATTERN.test(normalised) ? normalised : null;
}

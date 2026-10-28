// The citizen-held Irembo application number of a criminal-record certificate:
// a letter, 12 digits, then 4 letters (ADR-048 §2.3, observed shape). Shape only:
// whether the certificate exists is the registry's answer, asked by
// background-vetting-service.

export const CLEARANCE_NUMBER_PATTERN = /^[A-Z][0-9]{12}[A-Z]{4}$/;

/** The normalised number (spaces and hyphens dropped, upper-case), or null when it is not in the observed shape. */
export function parseClearanceNumber(raw: string): string | null {
  const normalised = raw.trim().replace(/[\s-]/g, '').toUpperCase();
  return CLEARANCE_NUMBER_PATTERN.test(normalised) ? normalised : null;
}

// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — synthetic National ID numbers (ADR-047 §3.4)
//
// Observed structure (16 digits):
//   1 · YYYY birth year · sex digit (8 male, 7 female) · 7-digit serial ·
//   issue digit · 2 control digits
// The control algorithm is not public, so it is NOT emulated and no adapter
// may validate it.
//
// THE SANDBOX SERIAL BLOCK: every synthetic NID's serial starts with 999
// (serials 9990000–9999999). scripts/check-tracked-secrets.mjs refuses any
// tracked 16-digit NID outside this block. A structurally valid NID could
// belong to a real person, so even these never leave the sandbox (ADR-047
// §3.1 fences); the block only makes accidental real numbers detectable.
// ══════════════════════════════════════════════════════════════════

/** The documented sandbox block. Kept identical to the CI rule's pattern. */
export const SYNTHETIC_NID_PATTERN = /^1\d{4}[78]999\d{7}$/;

export function isSyntheticNid(nid: string): boolean {
  return SYNTHETIC_NID_PATTERN.test(nid);
}

/** Compose a synthetic NID. `serial` is 0..9999 within the block. */
export function syntheticNid(birthYear: number, sex: 'MALE' | 'FEMALE', serial: number, issue = 0): string {
  if (!Number.isInteger(serial) || serial < 0 || serial > 9999) throw new RangeError('serial must be 0..9999');
  const nid = `1${String(birthYear)}${sex === 'MALE' ? '8' : '7'}999${String(serial).padStart(4, '0')}${String(issue % 10)}00`;
  if (!isSyntheticNid(nid)) throw new Error('synthetic NID outside its block');
  return nid;
}

/** The spaced document number as printed on the card: "1 YYYY S SSSSSSS I CC". */
export function spacedDocumentNumber(nid: string): string {
  return `${nid.slice(0, 1)} ${nid.slice(1, 5)} ${nid.slice(5, 6)} ${nid.slice(6, 13)} ${nid.slice(13, 14)} ${nid.slice(14)}`;
}

/** SDMS's masked hint: the first 4 and last 4 digits. */
export function maskedHint(nid: string): string {
  return `${nid.slice(0, 4)}********${nid.slice(12)}`;
}

// ══════════════════════════════════════════════════════════════════
// identity-service — Rwandan mobile number normalisation
//
// NIDA does not hold a citizen's phone: SIM registration lives with the
// operators. The number is therefore something the citizen TELLS us and then
// proves control of with an OTP — it is a contact channel, not an identity
// anchor. This module is the single place that decides what a deliverable
// number looks like.
//
// Canonical form: E.164, `+2507XXXXXXXX` (12 characters).
// Accepted spellings: `07XXXXXXXX`, `2507XXXXXXXX`, `+2507XXXXXXXX`,
// `002507XXXXXXXX`, and the country code followed by the trunk 0 that citizens
// often keep (`+250 07…`, `+250 (0)7…`), with spaces, hyphens, dots or brackets.
//
// Only the operator prefixes USRP has agreed to deliver to are accepted
// (MTN Rwanda 078/079, Airtel Rwanda 072/073). Widening this list is a policy
// edit, so it is a named constant rather than a regex buried in a handler.
// ══════════════════════════════════════════════════════════════════

/** Subscriber prefixes (digits after the country code) USRP will SMS. */
export const SUPPORTED_MSISDN_PREFIXES: readonly string[] = Object.freeze(['72', '73', '78', '79']);

const E164_RE = /^\+250(\d{2})(\d{7})$/;

/**
 * The canonical `+2507XXXXXXXX` form, or null when the input is not a
 * deliverable Rwandan mobile number. Never throws: a bad number is a business
 * outcome, and the caller decides how uniformly to answer it.
 */
export function normalizeRwandanMsisdn(raw: string): string | null {
  let compact = raw.replace(/[\s().-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  // The trunk 0 kept after the country code: +250 078… is +250 78….
  compact = compact.replace(/^(\+?250)0(?=\d{9}$)/, '$1');
  let national: string;
  if (/^\+250\d{9}$/.test(compact)) national = compact.slice(4);
  else if (/^250\d{9}$/.test(compact)) national = compact.slice(3);
  else if (/^0\d{9}$/.test(compact)) national = compact.slice(1);
  else return null;

  const candidate = `+250${national}`;
  const match = E164_RE.exec(candidate);
  if (match === null) return null;
  const prefix = match[1];
  return prefix !== undefined && SUPPORTED_MSISDN_PREFIXES.includes(prefix) ? candidate : null;
}

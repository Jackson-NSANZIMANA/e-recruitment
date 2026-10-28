// ══════════════════════════════════════════════════════════════════
// shared-sms — E.164 normalisation for Rwandan numbers
//
// Applicants type "0788000123" (or paste "+250 788 000 123"); the operator
// wants "+250788000123". Anything that cannot be read unambiguously yields
// null, and the channel then reports FAILED rather than guess.
//
//   07XXXXXXXX        → +2507XXXXXXXX  (10 digits, national format)
//   2507XXXXXXXX      → +2507XXXXXXXX
//   +2507XXXXXXXX     → unchanged
//   00250 7XXXXXXXX   → +2507XXXXXXXX
//   +<other country>  → kept when it is a well-formed E.164 number
// ══════════════════════════════════════════════════════════════════

const RWANDA_MOBILE = /^7[2389][0-9]{7}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

export function normaliseToE164(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (compact === '') return null;
  if (compact.startsWith('+')) {
    if (!E164.test(compact)) return null;
    if (compact.startsWith('+250')) return RWANDA_MOBILE.test(compact.slice(4)) ? compact : null;
    return compact;
  }
  let digits = compact;
  if (digits.startsWith('00')) return normaliseToE164(`+${digits.slice(2)}`);
  if (!/^[0-9]+$/.test(digits)) return null;
  if (digits.startsWith('250')) return normaliseToE164(`+${digits}`);
  if (digits.startsWith('0')) digits = digits.slice(1);
  else return null;
  return RWANDA_MOBILE.test(digits) ? `+250${digits}` : null;
}

/** "***NN": enough to eyeball a flow, useless to an attacker. */
export function maskDestination(destination: string): string {
  return `***${destination.slice(-2)}`;
}

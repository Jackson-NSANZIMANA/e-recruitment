// ══════════════════════════════════════════════════════════════════
// rehearsal — the venue-roster assertion (ADR-039, B-5)
//
// `pnpm rehearse --roster [--expect-code <processingCode>]` signs in as the
// Gasabo gate officer, reads the roster for "Rehearsal Venue — Gasabo" today
// through the edge and asserts it is minimal: it may hold the persona's
// processing code (when expected) and nothing identifying.
// ══════════════════════════════════════════════════════════════════

export class RosterAssertion extends Error {
  override readonly name = 'RosterAssertion';
}

const ALLOWED_KEYS = new Set(['processingCode', 'category', 'status', 'admission', 'requiredPaperItems']);
/** Anything that would identify a person must never appear, in a key or a value. */
const IDENTIFYING_KEY = /name|nid|national|phone|email|birth|address|photo|biometric|applicant/i;

/** PURE. Throws RosterAssertion unless the roster is minimal and (optionally) holds `expectCode`. */
export function assertGasaboRoster(body: unknown, expectCode: string | null): number {
  const fail = (message: string): never => {
    throw new RosterAssertion(message);
  };
  if (body === null || typeof body !== 'object') return fail('roster body is not an object');
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return fail('roster has no candidates array');
  for (const row of candidates as unknown[]) {
    if (row === null || typeof row !== 'object') return fail('roster row is not an object');
    for (const key of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(key)) return fail(`roster row carries non-minimal field "${key}"`);
      if (IDENTIFYING_KEY.test(key)) return fail(`roster row carries identifying field "${key}"`);
    }
  }
  const serialised = JSON.stringify(body);
  if (/\b\d{16}\b/.test(serialised)) return fail('roster contains a 16-digit number (National ID shape)');
  if (expectCode !== null && !(candidates as { processingCode?: unknown }[]).some((c) => c.processingCode === expectCode)) {
    return fail(`roster does not contain processing code ${expectCode}`);
  }
  return candidates.length;
}

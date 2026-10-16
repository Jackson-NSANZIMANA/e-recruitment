// Every control-plane write takes one UUID Idempotency-Key. A rehearsal
// derives each key from what the step IS (scenario, campaign code, step), so
// re-running the same rehearsal on the same day replays the stored answers
// instead of failing or duplicating — the platform's own retry semantics.

import { createHash } from 'node:crypto';

/** PURE. A UUID-shaped (v4 bits) key that is a function of `parts` only. */
export function deterministicKey(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(`usrp-rehearsal\u0000${parts.join('\u0000')}`).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ══════════════════════════════════════════════════════════════════
// biometric-service — ReferenceSource port (ADR-037 §2)
//
// Where the reference face a live capture is compared against comes from.
//
//   CARD_PORTRAIT  the portrait printed on the candidate's physical card,
//                  photographed and matched ON THE DEVICE. The server never
//                  sees a face: it receives a device-attested record.
//   NIDA_PORTRAIT  the NIDA registry portrait, matched server-side behind the
//                  BiometricMatcher port. NOT AUTHORISED: it fails closed
//                  until G2G authorisation and a lawful basis exist.
//   NONE           manual identity only.
//
// A source answers ONE question for each path: may it be used, and how.
// ══════════════════════════════════════════════════════════════════

import type { ReferenceSourceId } from '../domain/evidence-record.js';

export type ReferenceSourceStatus =
  /** Matching happens on the device; the server accepts a signed record. */
  | 'DEVICE_ATTESTED'
  /** Matching happens on the server through the BiometricMatcher port. */
  | 'SERVER_MATCH'
  /** Refused: no authorisation / lawful basis. Fails closed. */
  | 'NOT_AUTHORISED'
  /** No biometric comparison at all (manual identity). */
  | 'MANUAL_ONLY';

export interface ReferenceSource {
  readonly id: ReferenceSourceId;
  readonly status: ReferenceSourceStatus;
}

/** The complete, fixed set of sources this deployment knows. */
export interface ReferenceSourceRegistry {
  source(id: ReferenceSourceId): ReferenceSource;
  all(): readonly ReferenceSource[];
}

// ══════════════════════════════════════════════════════════════════
// application-service — Canonical submission request hash (ADR-027)
//
// The fingerprint that separates an HONEST RETRY from a REUSED KEY.
//
// The front door is idempotent on `(applicantId, idempotencyKey)`. That pair
// alone cannot tell the two cases apart:
//
//   • the kiosk's network dropped and it re-sent the IDENTICAL request
//     ⇒ replay the first result; filing twice would be the bug;
//   • a client reused a key it had already spent on a DIFFERENT submission
//     ⇒ refuse (KEY_REUSED). Replaying would silently return someone the
//     wrong application; filing would silently spend the key twice.
//
// So the ledger stores a hash of the request's BUSINESS CONTENT and compares
// it on every re-presentation of the key.
//
// CANONICALISATION — why not JSON.stringify
//
// `JSON.stringify` is key-ORDER dependent: `{a,b}` and `{b,a}` are the same
// request and two different strings, so a client that happened to serialise
// its retry in another order would be told KEY_REUSED for an identical
// submission. The encoding below is therefore built from a FIXED, ordered
// field list, independent of how the request arrived on the wire.
//
// It is also LENGTH-PREFIXED. With a plain delimiter, the distinct requests
//     nesa="A|B", hec=null   and   nesa="A", hec="B"
// can serialise to the same bytes — a hash collision that is trivially
// reachable from user input, and would make two genuinely different
// submissions look like a replay of each other. Encoding every value as
// `<byteLength>:<value>` makes every field boundary unforgeable.
//
// NULL is encoded as a marker that no string can produce (`-`, where a
// present value always starts with a digit), so "absent" and "" differ.
//
// The hash deliberately covers ONLY what the citizen submitted. It excludes
// the campaign (resolved server-side — the same request sent in two different
// campaign windows is a different application, and the live-intent index, not
// this hash, is what governs that) and every transport/trace field
// (correlation id, request id, timestamps), which must not make an identical
// retry look like a new request.
// ══════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { ApplicationCategory, ApplicationChannel } from '@usrp/shared-types';

/** The business content of one submission — everything the citizen chose. */
export interface CanonicalSubmission {
  readonly applicantId: string;
  readonly category: ApplicationCategory;
  readonly channel: ApplicationChannel;
  readonly nesaIndexNumber: string | null;
  readonly hecRegistrationNumber: string | null;
}

/**
 * The FIXED field order. Appending a new field here changes every hash, which
 * is correct: it changes what "the same request" means. Never reorder.
 */
const FIELD_ORDER = [
  'applicantId',
  'category',
  'channel',
  'nesaIndexNumber',
  'hecRegistrationNumber',
] as const satisfies readonly (keyof CanonicalSubmission)[];

/** `<byteLength>:<value>` for a string, `-` for null. Boundaries cannot be forged. */
function encodeValue(value: string | null): string {
  if (value === null) return '-';
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/**
 * The exact bytes that get hashed. Exported so the proof can assert the
 * encoding itself (order-independence, null/empty distinction, no collision
 * between delimiter-bearing values) rather than only the digest.
 */
export function canonicalRequestString(submission: CanonicalSubmission): string {
  return FIELD_ORDER.map((field) => `${field}=${encodeValue(submission[field])}`).join('\n');
}

/**
 * SHA-256 (hex) of the canonical encoding. Stable across key order, process
 * restarts and Node versions — it is persisted in
 * `public_core.submission_requests.request_hash` and compared on every retry.
 */
export function canonicalRequestHash(submission: CanonicalSubmission): string {
  return createHash('sha256').update(canonicalRequestString(submission), 'utf8').digest('hex');
}

// ══════════════════════════════════════════════════════════════════
// edge-gateway — Outbound leak guard
//
// Every other response on this boundary is built by an ALLOWLIST projection, so
// an unexpected upstream field cannot reach a browser. Exactly one payload is
// not: the per-record `results` array from `POST /v1/field-sync/scores`, whose
// item shape has not yet been transcribed from the upstream service. Guessing a
// keep-list there would silently drop outcomes a field tablet needs to converge
// a re-upload, which is worse than forwarding it.
//
// So it is forwarded — through this guard, which FAILS CLOSED. If a forbidden
// key or a National-ID-shaped run ever appears in that payload, the request
// becomes a 502 rather than a disclosure, and the log line names the key so the
// projection can be written properly.
//
// This is the honest position: an un-transcribed shape is forwarded under a
// guard and recorded as a named residual, not quietly trusted.
// ══════════════════════════════════════════════════════════════════

import { HttpError } from '@usrp/shared-http';
import { isRecord } from './validation.js';

const FORBIDDEN_OUTBOUND_KEYS: ReadonlySet<string> = new Set([
  'nationalid',
  'nationalidhash',
  'nidhash',
  'password',
  'otp',
  'token',
  'sessiontoken',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'clientsecret',
  'privatekey',
  'credential',
  'upstreamcredential',
  'dateofbirth',
  'dob',
  'phonenumber',
  'phone',
  'fullname',
  'applicantid',
]);

const NID_SHAPED = /\d{16}/;
const MAX_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fail(what: string, correlationId: string): never {
  console.error(
    JSON.stringify({
      msg: 'edge_outbound_leak_blocked',
      correlationId,
      blocked: what,
      detail:
        'An un-projected upstream payload carried a field the browser boundary forbids. ' +
        'Write an explicit projection for it rather than relaxing this guard.',
    }),
  );
  throw new HttpError(502, 'UPSTREAM_CONTRACT_MISMATCH', undefined, { expose: false });
}

/** Throws 502 rather than let an unexpected field cross the boundary. */
export function assertNoLeakedFields(value: unknown, correlationId: string, depth = 0): void {
  if (depth > MAX_DEPTH) fail('depth-limit', correlationId);
  if (typeof value === 'string') {
    if (NID_SHAPED.test(value)) fail('national-id-shaped-value', correlationId);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoLeakedFields(entry, correlationId, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_OUTBOUND_KEYS.has(normalizeKey(key))) fail(`key:${key}`, correlationId);
    assertNoLeakedFields(entry, correlationId, depth + 1);
  }
}

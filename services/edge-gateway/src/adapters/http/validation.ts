// ══════════════════════════════════════════════════════════════════
// edge-gateway — Inbound validation
//
// The edge forwards a request shape it has CONSTRUCTED, never one it received.
// Every controller reads named fields through these helpers and builds a fresh
// object for the upstream call, so an unexpected property physically cannot
// travel: there is no spread of the request body anywhere in this service.
//
// THREE FIELD CLASSES ARE REFUSED OUTRIGHT rather than ignored:
//
//   agency*          — agency is an authorization input and is read from the
//                      verified session. Silently ignoring it would leave a
//                      frontend author believing they had set it.
//   nationalIdHash   — a client-computed identity claim over 16 structured
//                      digits: forgeable by the client AND brute-forceable
//                      offline in seconds. Identity resolves server-side
//                      against NIDA.
//   credential-ish   — token / sessionToken / password fields on operations
//                      that have no business carrying one.
//
// Refusing beats ignoring: an ignored authorization field is a security control
// the caller thinks exists. That is how the previous frontend shipped a browser
// -computed nationalIdHash for a month.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RequestContext } from '@usrp/shared-http';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Rwandan National ID: exactly 16 digits. Same rule as shared-security. */
const NATIONAL_ID_RE = /^\d{16}$/;

/** Normalized field names no browser request may carry, on ANY operation. */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'agency',
  'agencycode',
  'nationalidhash',
  'nidhash',
  'token',
  'accesstoken',
  'sessiontoken',
  'refreshtoken',
  'authorization',
  'bearer',
  'clientid',
  'clientsecret',
  'dbrole',
  'principal',
  'actor',
  'officerid',
  'subjectid',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The one error a rejected field produces. Named so the audit line is useful. */
export class ForbiddenFieldError extends HttpError {
  readonly field: string;

  constructor(field: string) {
    super(
      400,
      'FORBIDDEN_FIELD',
      `Field "${field}" is not accepted at the browser boundary.`,
    );
    this.name = 'ForbiddenFieldError';
    this.field = field;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse the JSON body, require an object, and reject forbidden fields at the
 * TOP LEVEL and one level down (the only nesting any edge request has: the
 * field-sync score records).
 */
export async function readJsonBody(ctx: RequestContext): Promise<Record<string, unknown>> {
  const parsed = await ctx.json<unknown>();
  if (!isRecord(parsed)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'A JSON object body is required.');
  }
  assertNoForbiddenFields(parsed, 0);
  return parsed;
}

export function assertNoForbiddenFields(value: unknown, depth: number): void {
  if (depth > 2) return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenFields(entry, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(normalizeKey(key))) {
      throw new ForbiddenFieldError(key);
    }
    assertNoForbiddenFields(entry, depth + 1);
  }
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw new HttpError(400, 'INVALID_REQUEST', `Field "${field}" must be a UUID.`);
  }
  return value.trim();
}

/**
 * A 16-digit National ID.
 *
 * The error deliberately says only that the SHAPE is wrong. It must never
 * distinguish "well-formed but unknown", which would restore the enumeration
 * oracle the 202 exists to close.
 */
export function requireNationalId(value: unknown): string {
  if (typeof value !== 'string' || !NATIONAL_ID_RE.test(value.trim())) {
    throw new HttpError(400, 'INVALID_REQUEST', 'A National ID must be 16 digits.');
  }
  return value.trim();
}

export function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      `Field "${field}" must be a string of 1–${maxLength} characters.`,
    );
  }
  return value;
}

export function optionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, field, maxLength);
}

export function requireOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', `Field "${field}" is not an accepted value.`);
  }
  return value as T;
}

/**
 * `?applicationId=` — a QUERY parameter, not a path parameter. shared-http has
 * no path-parameter syntax (ADR-005), so `/applications/{id}` is unroutable and
 * would 404 for every input rather than fail loudly.
 */
export function requireApplicationIdQuery(ctx: RequestContext): string {
  return requireUuid(ctx.query.get('applicationId') ?? undefined, 'applicationId');
}

/** The officer note surfaced in the status history. Rendered verbatim to an
 *  applicant, which is why a National ID inside one is refused here. */
export function optionalNote(value: unknown, maxLength: number): string | undefined {
  const note = optionalBoundedString(value, 'note', maxLength);
  if (note === undefined) return undefined;
  if (/\d{16}/.test(note)) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'A note must not contain a National ID — it is shown to the applicant verbatim.',
    );
  }
  return note;
}

// ══════════════════════════════════════════════════════════════════
// edge-gateway — Inbound validation
//
// Shape checks only, and they answer with the CONTRACT'S error body rather than
// a helpful one. A 400 on the credential and OTP routes is byte-identical to a
// 401, because "your National ID is the wrong length" and "no such citizen" must
// not be separable by an unauthenticated caller.
//
// THE `nationalIdHash` REJECTION IS NOT VALIDATION, IT IS A REFUSAL. The old
// frontend computed an HMAC of the National ID in the browser and sent it as an
// identity assertion. A Rwandan National ID is 16 structured digits, so an
// unsalted hash is a reversible identifier — brute-forceable offline in seconds
// — and a client-computed identity claim is one the client can fabricate. Such a
// body is rejected outright rather than forwarded with the field ignored: a
// silently-dropped field is one a client keeps sending and one a future proxy
// change starts honouring.
// ══════════════════════════════════════════════════════════════════

const NATIONAL_ID_RE = /^[0-9]{16}$/;
const OTP_RE = /^[0-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Field names that must never appear in a request body. */
const FORBIDDEN_FIELDS: readonly string[] = ['nationalIdHash', 'national_id_hash'];

export function containsForbiddenField(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return FORBIDDEN_FIELDS.some((field) => field in (body as Record<string, unknown>));
}

export function readNationalId(body: unknown): string | null {
  const value = pick(body, 'nationalId');
  return typeof value === 'string' && NATIONAL_ID_RE.test(value.trim()) ? value.trim() : null;
}

export function readOtp(body: unknown): string | null {
  const value = pick(body, 'otp');
  return typeof value === 'string' && OTP_RE.test(value.trim()) ? value.trim() : null;
}

export function readApplicationId(body: unknown): string | null {
  const value = pick(body, 'applicationId');
  return typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim() : null;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function readBoundedString(body: unknown, key: string, max: number): string | null {
  const value = pick(body, key);
  if (typeof value !== 'string') return null;
  return value.length >= 1 && value.length <= max ? value : null;
}

/**
 * An optional bounded string.
 *
 * A DISCRIMINATED result, not a string sentinel: returning the literal
 * 'INVALID' would collapse into `string` and make a note whose text happens to
 * be "INVALID" indistinguishable from a rejected one. Cheap bug to write, very
 * annoying to find in an officer's free-text field.
 */
export type OptionalText =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false };

export function readOptionalText(body: unknown, key: string, max: number): OptionalText {
  const value = pick(body, key);
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > max) return { ok: false };
  return { ok: true, value };
}

export function readEnum<T extends string>(
  body: unknown,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = pick(body, key);
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function pick(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  return (body as Record<string, unknown>)[key];
}

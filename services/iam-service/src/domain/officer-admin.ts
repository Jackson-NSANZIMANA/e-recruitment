// ══════════════════════════════════════════════════════════════════
// iam-service — Officer lifecycle domain (ADR-036). PURE.
//
// The closed vocabularies and input guards of the officer-admin commands.
// The rls/0033 command functions are AUTHORITATIVE and enforce every rule
// again inside the transaction (same agency, last active admin, actor still
// an active agency_admin) — these functions only refuse obviously invalid
// input before a database round-trip and give the HTTP layer typed outcomes.
// Every function is total and side-effect free.
// ══════════════════════════════════════════════════════════════════

/** Posts an agency administrator may assign. agency_admin is deliberately absent. */
export const ASSIGNABLE_POSTS = [
  'reviewer',
  'screening_officer',
  'field_supervisor',
  'medical_officer',
  'adjudicator',
  'decision_authority',
  'dpo',
] as const;
export type AssignablePost = (typeof ASSIGNABLE_POSTS)[number];

/** Closed reason codes per command, so audit payloads are PII-free by construction. */
export const ASSIGN_POSTS_REASONS = ['POSTING_CHANGE', 'CORRECTION', 'TEMPORARY_COVER', 'OTHER'] as const;
export const DISABLE_REASONS = ['LEFT_SERVICE', 'SUSPENDED', 'SECURITY_CONCERN', 'EXTENDED_LEAVE', 'OTHER'] as const;
export const ENABLE_REASONS = ['RETURNED_TO_DUTY', 'SUSPENSION_LIFTED', 'CORRECTION', 'OTHER'] as const;
export const REVOKE_SESSIONS_REASONS = ['DEVICE_LOST', 'SECURITY_CONCERN', 'OTHER'] as const;

export type AssignPostsReason = (typeof ASSIGN_POSTS_REASONS)[number];
export type DisableReason = (typeof DISABLE_REASONS)[number];
export type EnableReason = (typeof ENABLE_REASONS)[number];
export type RevokeSessionsReason = (typeof REVOKE_SESSIONS_REASONS)[number];

/** Every refusal a command can answer. Names a rule, never a person. */
export const OFFICER_REFUSALS = [
  'INVALID_HANDLE',
  'HANDLE_TAKEN',
  'INVALID_POSTS',
  'UNKNOWN_POST',
  'AGENCY_ADMIN_NOT_ASSIGNABLE',
  'INVALID_REASON',
  'NOT_FOUND',
  'SELF_MODIFICATION',
  'LAST_ACTIVE_ADMIN',
  'NOT_PENDING_ACTIVATION',
  // Four-eyes release (ADR-036 addendum).
  'SAME_ADMIN',
  'ALREADY_RELEASED',
  'ACTIVATION_EXPIRED',
] as const;
export type OfficerRefusal = (typeof OFFICER_REFUSALS)[number];

export type OfficerStatus = 'active' | 'disabled' | 'pending';

/** A pending activation waits for a second administrator, then for the officer. */
export type ActivationState = 'PENDING_RELEASE' | 'RELEASED';

/** The listing row. Never a credential, a code or a code hash. */
export interface OfficerView {
  readonly officerId: string;
  readonly loginHandle: string;
  readonly posts: readonly string[];
  readonly status: OfficerStatus;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly activationExpiresAt: string | null;
  readonly activationState: ActivationState | null;
  /** True only in the list: the viewing administrator may release this officer's code. */
  readonly releasableByYou: boolean;
}

/** Shown exactly once, to the RELEASING (second) administrator; never at create or reissue. */
export interface ActivationCode {
  readonly code: string;
  readonly expiresAt: string;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION_RE = /^[A-Za-z0-9._:-]{3,128}$/;
/** XXXXX-XXXXX-XXXXX-XXXXX over the 32-symbol alphabet; dashes and case optional. */
const ACTIVATION_CODE_RE = /^[A-HJ-NP-Z2-9]{20}$/;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function isAssignablePost(value: string): value is AssignablePost {
  return (ASSIGNABLE_POSTS as readonly string[]).includes(value);
}

/** PURE. The canonical handle (trimmed, lower-case) or null when malformed. */
export function normaliseHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const handle = raw.trim().toLowerCase();
  return HANDLE_RE.test(handle) ? handle : null;
}

export function isUuid(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID_RE.test(raw);
}

/**
 * PURE. A sorted, duplicate-free post set, or the refusal. Mirrors
 * officer_private_posts_refusal in rls/0033 (same order of checks).
 */
export function validatePosts(raw: unknown):
  | { readonly ok: true; readonly posts: readonly AssignablePost[] }
  | { readonly ok: false; readonly refusal: 'INVALID_POSTS' | 'UNKNOWN_POST' | 'AGENCY_ADMIN_NOT_ASSIGNABLE' } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ASSIGNABLE_POSTS.length) {
    return { ok: false, refusal: 'INVALID_POSTS' };
  }
  if (!raw.every((p): p is string => typeof p === 'string')) return { ok: false, refusal: 'INVALID_POSTS' };
  if (raw.includes('agency_admin')) return { ok: false, refusal: 'AGENCY_ADMIN_NOT_ASSIGNABLE' };
  if (!raw.every(isAssignablePost)) return { ok: false, refusal: 'UNKNOWN_POST' };
  if (new Set(raw).size !== raw.length) return { ok: false, refusal: 'INVALID_POSTS' };
  return { ok: true, posts: [...raw].sort() };
}

/** PURE. True iff `raw` is one of the closed reason codes. */
export function isReason<T extends string>(allowed: readonly T[], raw: unknown): raw is T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw);
}

/** PURE. An administrator never changes their own posts, status or sessions. */
export function isSelfModification(actorId: string, targetOfficerId: string): boolean {
  return actorId.toLowerCase() === targetOfficerId.toLowerCase();
}

/**
 * PURE. Whether disabling `target` would leave the agency with no active
 * administrator. The authoritative count is taken under an advisory lock in
 * officer_set_status; this is the same rule, stated once in code.
 */
export function wouldRemoveLastActiveAdmin(
  target: { readonly status: OfficerStatus; readonly posts: readonly string[] },
  otherActiveAdmins: number,
): boolean {
  return target.status === 'active' && target.posts.includes('agency_admin') && otherActiveAdmins === 0;
}

/** PURE. Accepts the code with or without dashes and in any case; null when malformed. */
export function normaliseActivationCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const compact = raw.replace(/[\s-]/g, '').toUpperCase();
  return ACTIVATION_CODE_RE.test(compact) ? compact : null;
}

/** PURE. The password policy at activation (length only; the KDF does the rest). */
export function isAcceptablePassword(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= MIN_PASSWORD_LENGTH && raw.length <= MAX_PASSWORD_LENGTH;
}

/**
 * PURE. The correlation id is caller-controlled (x-correlation-id). Only a
 * well-formed one reaches the audit envelope; otherwise the fallback is used.
 */
export function safeCorrelationId(raw: string, fallback: string): string {
  return CORRELATION_RE.test(raw) ? raw : fallback;
}

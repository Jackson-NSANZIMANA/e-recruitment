// ══════════════════════════════════════════════════════════════════
// @usrp/shared-identity-match — credential-to-identity binding (ADR-048 §2.1)
//
// A credential (NESA results, an Irembo certificate, ...) is evidence only if
// it belongs to the applicant. This module decides that, from a handful of
// holder facts, and nothing else:
//
//   name           token MULTISETS after NFKD + diacritic strip + upper-case,
//                  so "NSANZIMANA Jackson" ≡ "Jackson Nsanzimana" ≡ "Jáckson
//                  NSANZIMANA". PARTIAL when one side is a subset of the other,
//                  or exactly one token on each side differs by one edit.
//   date of birth  DD/MM/YYYY (Irembo, SDMS) and YYYY-MM-DD (USRP), compared
//                  as calendar dates.
//   sex            exact, where the claim states it.
//   NID hint       first 4 + last 4 digits ("NNNN********NNNN", SDMS), where
//                  the claim states it.
//
// Outcomes:
//   BOUND      everything compared matches and the name is EXACT;
//   REVIEW     the name is PARTIAL, or a stated value is unreadable, and
//              nothing contradicts: a human decides (amber queue);
//   NOT_BOUND  the DOB, sex or NID hint contradicts, or the name is a
//              MISMATCH: "this record does not match your identity". This is
//              NOT an eligibility verdict; the applicant may correct the number.
//
// PURE and TOTAL: no I/O, no clock, no throw for any input. The caller keeps
// only the outcome and the per-field results; the compared values are never
// part of the result, so they cannot leak through it.
// ══════════════════════════════════════════════════════════════════

export type NameMatch = 'EXACT' | 'PARTIAL' | 'MISMATCH';

/**
 * Per-field result. `NOT_COMPARED` means one side did not state the field;
 * `UNREADABLE` means a side stated it in a form this module cannot parse.
 */
export type FieldResult = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'NOT_COMPARED' | 'UNREADABLE';

export type BindingOutcome = 'BOUND' | 'REVIEW' | 'NOT_BOUND';

export type Sex = 'MALE' | 'FEMALE';

/** The applicant's verified identity (from NIDA, as USRP stores it). */
export interface IdentityFacts {
  readonly fullName: string;
  /** YYYY-MM-DD or DD/MM/YYYY. */
  readonly dateOfBirth: string;
  readonly sex?: string | null;
  /**
   * The first 4 and last 4 digits of the applicant's NID, as 8 digits. Null
   * for identities verified before the hint was captured (rls/0042).
   */
  readonly nationalIdHint?: string | null;
}

/** What the credential says about its holder. Every field but the name is optional. */
export interface CredentialClaim {
  readonly holderName: string;
  readonly dateOfBirth?: string | null;
  readonly sex?: string | null;
  /** Masked NID as the registry prints it, e.g. "1199********1234", or 8 digits. */
  readonly nationalIdHint?: string | null;
}

export interface BindingFields {
  readonly name: FieldResult;
  readonly dateOfBirth: FieldResult;
  readonly sex: FieldResult;
  readonly nationalIdHint: FieldResult;
}

export interface BindingResult {
  readonly outcome: BindingOutcome;
  readonly nameMatch: NameMatch;
  readonly fields: BindingFields;
}

// ── Names ─────────────────────────────────────────────────────────

/**
 * Canonical name tokens: NFKD, combining marks removed, upper-case, apostrophes
 * dropped (N'DAYISHIMIYE ≡ NDAYISHIMIYE), every other non-letter a separator
 * (Jean-Pierre ≡ Jean Pierre).
 */
export function nameTokens(name: string): readonly string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/['’ʼ`]/g, '')
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length > 0);
}

/** True when the optimal-string-alignment distance between `a` and `b` is at most 1. */
export function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const diffs: number[] = [];
    for (let i = 0; i < la; i += 1) {
      if (a[i] !== b[i]) {
        diffs.push(i);
        if (diffs.length > 2) return false;
      }
    }
    if (diffs.length === 1) return true;
    // One adjacent transposition counts as one edit.
    const [i, j] = diffs;
    return i !== undefined && j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  // One insertion/deletion.
  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
    } else {
      if (skipped) return false;
      skipped = true;
      j += 1;
    }
  }
  return true;
}

function multiset(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Tokens of `from` not consumed by `against` (multiset difference). */
function leftover(from: Map<string, number>, against: Map<string, number>): string[] {
  const rest: string[] = [];
  for (const [token, count] of from) {
    const used = Math.min(count, against.get(token) ?? 0);
    for (let k = used; k < count; k += 1) rest.push(token);
  }
  return rest;
}

/** Shortest token length eligible for the one-edit allowance (avoids "JO" ≈ "JA"). */
const FUZZY_MIN_LENGTH = 3;

export function compareNames(left: string, right: string): NameMatch {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length === 0 || b.length === 0) return 'MISMATCH';
  const ma = multiset(a);
  const mb = multiset(b);
  const onlyA = leftover(ma, mb);
  const onlyB = leftover(mb, ma);
  if (onlyA.length === 0 && onlyB.length === 0) return 'EXACT';
  // Subset either way (a missing middle name), with at least one shared token.
  const shared = a.length - onlyA.length;
  if (shared > 0 && (onlyA.length === 0 || onlyB.length === 0)) return 'PARTIAL';
  // Exactly one differing token on each side, one edit apart.
  if (onlyA.length === 1 && onlyB.length === 1) {
    const [x, y] = [onlyA[0] ?? '', onlyB[0] ?? ''];
    if (Math.min(x.length, y.length) >= FUZZY_MIN_LENGTH && editDistanceAtMostOne(x, y)) return 'PARTIAL';
  }
  return 'MISMATCH';
}

// ── Dates of birth ───────────────────────────────────────────────

/** Parse DD/MM/YYYY, D/M/YYYY, DD-MM-YYYY or YYYY-MM-DD into YYYY-MM-DD; null if invalid. */
export function parseDateOfBirth(raw: string): string | null {
  const value = raw.trim();
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
  if (match !== null) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
    if (match === null) return null;
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  }
  if (month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Sex and NID hint ──────────────────────────────────────────────

export function normaliseSex(raw: string): Sex | null {
  const value = raw.trim().toUpperCase();
  if (value === 'MALE' || value === 'M') return 'MALE';
  if (value === 'FEMALE' || value === 'F') return 'FEMALE';
  return null;
}

/** "1199********1234" or "11991234" → "11991234"; null if unreadable. */
export function parseNationalIdHint(raw: string): string | null {
  const value = raw.replace(/\s+/g, '');
  const masked = /^(\d{4})[*xX•]{8}(\d{4})$/.exec(value);
  if (masked !== null) return `${masked[1] ?? ''}${masked[2] ?? ''}`;
  if (/^\d{8}$/.test(value)) return value;
  return null;
}

/** The 8-digit hint of a full 16-digit NID (first 4 + last 4); null if malformed. */
export function nationalIdHintOf(nationalId: string): string | null {
  const digits = nationalId.replace(/\s+/g, '');
  if (!/^\d{16}$/.test(digits)) return null;
  return `${digits.slice(0, 4)}${digits.slice(12)}`;
}

// ── The rule ─────────────────────────────────────────────────────

function present(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.trim() !== '';
}

function compareField(
  identityRaw: string | null | undefined,
  claimRaw: string | null | undefined,
  parse: (raw: string) => string | null,
): FieldResult {
  if (!present(claimRaw) || !present(identityRaw)) return 'NOT_COMPARED';
  const claim = parse(claimRaw);
  const identity = parse(identityRaw);
  if (claim === null || identity === null) return 'UNREADABLE';
  return claim === identity ? 'MATCH' : 'MISMATCH';
}

const NAME_FIELD: Readonly<Record<NameMatch, FieldResult>> = { EXACT: 'MATCH', PARTIAL: 'PARTIAL', MISMATCH: 'MISMATCH' };

/** Bind a credential claim to the applicant's identity. PURE and TOTAL. */
export function bindCredential(identity: IdentityFacts, claim: CredentialClaim): BindingResult {
  const nameMatch = compareNames(identity.fullName, claim.holderName);
  const fields: BindingFields = {
    name: NAME_FIELD[nameMatch],
    dateOfBirth: compareField(identity.dateOfBirth, claim.dateOfBirth, parseDateOfBirth),
    sex: compareField(identity.sex, claim.sex, normaliseSex),
    nationalIdHint: compareField(identity.nationalIdHint, claim.nationalIdHint, parseNationalIdHint),
  };
  const all = Object.values(fields) as FieldResult[];
  const outcome: BindingOutcome = all.includes('MISMATCH')
    ? 'NOT_BOUND'
    : all.includes('PARTIAL') || all.includes('UNREADABLE')
      ? 'REVIEW'
      : 'BOUND';
  return { outcome, nameMatch, fields };
}

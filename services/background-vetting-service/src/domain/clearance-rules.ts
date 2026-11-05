// ══════════════════════════════════════════════════════════════════
// background-vetting-service — the clearance decision (ADR-048 §2.3), pure
//
// The ordered checks, each stopping the chain (ADR-048 §2.3, with one security
// refinement: the binding runs right after "found", so a citizen who is not the
// holder learns nothing about another person's certificate beyond "no such
// certificate" or "not yours"):
//
//   1. found            NOT_FOUND → correctable
//   2. identity binding bindCredential: the certificate must be THIS
//                       applicant's (NOT_BOUND is correctable, never a verdict)
//   3. authentic        a withdrawn certificate → correctable
//   4. allowed type     the policy's allowlist; an equivalence certificate
//                       fails here as WRONG_TYPE
//   5. validity window  issued within `validityDays` of the reference date
//   6. content          a distinct "no record" type is conclusive → CLEARED;
//                       any other allowed type can carry a conviction → REVIEW
//                       (CLEARANCE_CONTENT_REVIEW), an officer decides
//
// A partial name is a REVIEW reason of its own (IDENTITY_NAME_PARTIAL).
// Correctable failures are NOT eligibility verdicts: the application is never
// rejected for them and the citizen copy names no other person.
//
// PURE and total: no I/O, no clock (the reference date is an argument), no
// throw. The result carries closed codes and per-field binding results only,
// never a name, a date of birth or a certificate value.
// ══════════════════════════════════════════════════════════════════

import { bindCredential, type BindingFields, type IdentityFacts } from '@usrp/shared-identity-match';
import type {
  ClearanceFailureCode,
  ClearanceLookup,
  ClearancePolicy,
  ClearanceReviewReason,
} from './clearance.types.js';

export type ClearanceDecision =
  | {
      readonly kind: 'CLEARED';
      readonly certificateType: string;
      readonly issuedOn: string;
      readonly binding: BindingFields;
    }
  | {
      readonly kind: 'REVIEW';
      readonly reasons: readonly ClearanceReviewReason[];
      readonly certificateType: string;
      readonly issuedOn: string;
      readonly binding: BindingFields;
    }
  | {
      readonly kind: 'CORRECTION_NEEDED';
      readonly code: ClearanceFailureCode;
      readonly certificateType: string | null;
      readonly issuedOn: string | null;
      readonly binding: BindingFields | null;
    };

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
}

/** Whole days from `issuedOn` to `referenceDate`; null if either is unreadable. */
export function daysBetween(issuedOn: string, referenceDate: string): number | null {
  const a = dayNumber(issuedOn);
  const b = dayNumber(referenceDate);
  return a === null || b === null ? null : b - a;
}

export function decideClearance(
  lookup: ClearanceLookup,
  identity: IdentityFacts,
  policy: ClearancePolicy,
  referenceDate: string,
): ClearanceDecision {
  if (lookup.status === 'NOT_FOUND') {
    return { kind: 'CORRECTION_NEEDED', code: 'CERTIFICATE_NOT_FOUND', certificateType: null, issuedOn: null, binding: null };
  }
  const c = lookup.certificate;

  // NOT IN FORCE comes first, because Irembo returns NOTHING to bind to in that case —
  // no name, no date of birth, no issue date (ADR-048 §2.3 amendment). The answer names
  // no holder and no date, so it discloses nothing the registry's own public endpoint
  // does not already tell any caller, while the citizen is finally told the truth:
  // request a new certificate. Treating this as a malformed body retried for ever.
  if (!c.authentic) {
    return { kind: 'CORRECTION_NEEDED', code: 'CERTIFICATE_NOT_VALID', certificateType: null, issuedOn: null, binding: null };
  }

  // In force, so every field is present; the type says so.
  const issuedOn = c.issuedOn ?? null;
  const known = { certificateType: c.type, issuedOn };

  // Binding FIRST among the remaining checks: whoever is not the holder learns only
  // "not found", "not yours" or "not in force", never the type, validity window or
  // age of someone else's certificate (the security review, S12b finding 1).
  // A certificate in force always prints a date of birth: a binding that did not compare it can never be BOUND on name alone.
  const binding = bindCredential(identity, { holderName: c.holderName ?? '', dateOfBirth: c.holderDob ?? '' }, { requiredFields: ['dateOfBirth'] });
  if (binding.outcome === 'NOT_BOUND') {
    return { kind: 'CORRECTION_NEEDED', code: 'CERTIFICATE_NOT_BOUND', ...known, binding: binding.fields };
  }

  if (!policy.allowedTypes.has(c.type)) return { kind: 'CORRECTION_NEEDED', code: 'CERTIFICATE_WRONG_TYPE', ...known, binding: binding.fields };

  const age = issuedOn === null ? null : daysBetween(issuedOn, referenceDate);
  // A future-dated or unreadable issue date cannot be inside a window that ends today.
  if (age === null || age < 0 || age > policy.validityDays) {
    return { kind: 'CORRECTION_NEEDED', code: 'CERTIFICATE_EXPIRED', ...known, binding: binding.fields };
  }

  const reasons: ClearanceReviewReason[] = [];
  if (binding.outcome === 'REVIEW') reasons.push(binding.nameMatch === 'PARTIAL' ? 'IDENTITY_NAME_PARTIAL' : 'IDENTITY_HOLDER_UNREADABLE');
  if (!policy.noRecordTypes.has(c.type)) reasons.push('CLEARANCE_CONTENT_REVIEW');
  if (reasons.length > 0) return { kind: 'REVIEW', reasons, ...known, binding: binding.fields };
  return { kind: 'CLEARED', ...known, binding: binding.fields };
}

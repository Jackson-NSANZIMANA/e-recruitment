// ══════════════════════════════════════════════════════════════════
// application-service — Gate admission (pure domain, BUILD-003, ADR-034)
//
// A candidate arrives at the venue gate with the QR the portal gave them
// (ADR-033): the signed slot invitation, valid for the whole exam day. The
// screening officer scans it and sights the national ID card. Admission SPENDS
// the QR: it can admit exactly one person, once.
//
// The checks run in a fixed order, and the order is part of the contract:
//
//   1. MALFORMED_TICKET   not a USRP-SLOT.v1 token with the claims we issue
//   2. WRONG_AGENCY       the ticket belongs to another agency's exam
//   3. UNKNOWN_TICKET     no such application in this agency
//   4. TICKET_NOT_ISSUED  the token is not byte-identical to the one stored
//                         on the application (forged, altered, or stale)
//   5. ALREADY_ADMITTED   the QR was already spent — checked BEFORE venue and
//                         day, so a copied screenshot is called a duplicate at
//                         whichever gate it reaches, not a "wrong venue"
//   6. NOT_ADMISSIBLE     withdrawn, rejected, on hold, or past the stage
//   7. WRONG_VENUE        this gate is not the venue on the ticket
//   8. TOO_EARLY/EXPIRED  today (Africa/Kigali) is not the exam day
//   9. IDENTITY_MISMATCH  the card's national ID is not this applicant's —
//                         asked LAST, so the match function is only ever
//                         consulted for a genuine, unspent, on-site ticket
//
// Authenticity without a key: application-service holds no QR public key. It
// does not need one — a token byte-identical to the one stored (write-once,
// rls/0031) on the application IS the token scheduling signed. Gates that are
// offline verify the signature locally; this service is the single-use
// authority, which only an online check can be.
//
// PURE: no I/O. `now` is injected.
// ══════════════════════════════════════════════════════════════════

import { timingSafeEqual } from 'node:crypto';
import { AGENCIES, type Agency, type ApplicationStatus } from '@usrp/shared-types';

/** Every outcome, success included. Mirrors the CHECK constraint of rls/0032. */
export const GATE_OUTCOMES = [
  'ADMITTED',
  'ALREADY_ADMITTED',
  'MALFORMED_TICKET',
  'WRONG_AGENCY',
  'UNKNOWN_TICKET',
  'TICKET_NOT_ISSUED',
  'NOT_ADMISSIBLE',
  'WRONG_VENUE',
  'TOO_EARLY',
  'EXPIRED',
  'IDENTITY_MISMATCH',
] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/** The ticket refusals: the QR itself is not a valid ticket here. */
export const INVALID_TICKET_OUTCOMES: ReadonlySet<GateOutcome> = new Set<GateOutcome>([
  'MALFORMED_TICKET',
  'WRONG_AGENCY',
  'UNKNOWN_TICKET',
  'TICKET_NOT_ISSUED',
]);

/** Statuses from which a candidate may be admitted to the exam. */
export const ADMISSIBLE_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'SLOT_ASSIGNED',
  'PHYSICAL_TEST_SCHEDULED',
]);

/** The exam day is a Rwandan calendar day. Kigali is UTC+2 with no DST. */
export const GATE_TIME_ZONE = 'Africa/Kigali';

/** The claims the gate needs from the ticket (a subset of SlotInvitationClaims). */
export interface GateTicketClaims {
  readonly ticketId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly campaignId: string;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  readonly expiresAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGENCY_SET: ReadonlySet<string> = new Set(AGENCIES);
/** A QR payload far longer than any token we issue is refused before parsing. */
export const MAX_TICKET_LENGTH = 4096;

/**
 * Read the claims WITHOUT verifying the signature (see header: authenticity is
 * equality with the stored token). Never throws; anything off-shape is null.
 */
export function parseGateTicket(token: string): GateTicketClaims | null {
  if (token.length === 0 || token.length > MAX_TICKET_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'USRP-SLOT' || parts[1] !== 'v1') return null;
  let c: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[2] ?? '', 'base64url').toString('utf8'));
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    c = decoded as Record<string, unknown>;
  } catch {
    return null;
  }
  const { ticketId, applicationId, agency, campaignId, venueName, examDate, reportingTimeHour, expiresAt } = c;
  if (
    typeof ticketId !== 'string' || ticketId.length === 0 || ticketId.length > 64 ||
    typeof applicationId !== 'string' || !UUID_RE.test(applicationId) ||
    typeof agency !== 'string' || !AGENCY_SET.has(agency) ||
    typeof campaignId !== 'string' || !UUID_RE.test(campaignId) ||
    typeof venueName !== 'string' || venueName.trim().length === 0 ||
    typeof examDate !== 'string' || !DATE_RE.test(examDate) ||
    typeof reportingTimeHour !== 'number' || !Number.isInteger(reportingTimeHour) ||
    typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))
  ) {
    return null;
  }
  return {
    ticketId,
    applicationId: applicationId.toLowerCase(),
    agency: agency as Agency,
    campaignId,
    venueName,
    examDate,
    reportingTimeHour,
    expiresAt,
  };
}

/** Venue names compare case- and whitespace-insensitively (typed at the gate). */
export function normalizeVenueName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('en');
}

/** The calendar day (YYYY-MM-DD) it is in Kigali at `now`. */
export function kigaliDate(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: GATE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Constant-time equality: the stored token is a bearer credential. */
export function sameToken(stored: string | null, presented: string): boolean {
  if (stored === null) return false;
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What the repository found, under the row lock, for checks 3–8. */
export interface GateRowFacts {
  readonly status: ApplicationStatus;
  readonly storedToken: string | null;
  readonly alreadyAdmitted: boolean;
}

export type PreIdentityDecision =
  | { readonly kind: 'REFUSE'; readonly outcome: Exclude<GateOutcome, 'ADMITTED' | 'IDENTITY_MISMATCH'> }
  | { readonly kind: 'CHECK_IDENTITY' };

/**
 * Checks 3–8, in contract order. `row` is null when the application is not in
 * this agency's schema. Returns CHECK_IDENTITY only for a genuine, unspent,
 * admissible ticket presented at the right venue on the exam day.
 */
export function decideBeforeIdentity(
  claims: GateTicketClaims,
  presentedToken: string,
  row: GateRowFacts | null,
  gateVenueName: string,
  now: Date,
): PreIdentityDecision {
  if (row === null) return { kind: 'REFUSE', outcome: 'UNKNOWN_TICKET' };
  if (!sameToken(row.storedToken, presentedToken)) return { kind: 'REFUSE', outcome: 'TICKET_NOT_ISSUED' };
  if (row.alreadyAdmitted) return { kind: 'REFUSE', outcome: 'ALREADY_ADMITTED' };
  if (!ADMISSIBLE_STATUSES.has(row.status)) return { kind: 'REFUSE', outcome: 'NOT_ADMISSIBLE' };
  if (normalizeVenueName(gateVenueName) !== normalizeVenueName(claims.venueName)) {
    return { kind: 'REFUSE', outcome: 'WRONG_VENUE' };
  }
  const today = kigaliDate(now);
  if (today < claims.examDate) return { kind: 'REFUSE', outcome: 'TOO_EARLY' };
  if (today > claims.examDate || now.getTime() >= Date.parse(claims.expiresAt)) {
    return { kind: 'REFUSE', outcome: 'EXPIRED' };
  }
  return { kind: 'CHECK_IDENTITY' };
}

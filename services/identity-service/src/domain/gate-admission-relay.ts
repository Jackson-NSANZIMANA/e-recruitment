// ══════════════════════════════════════════════════════════════════
// identity-service — Gate admission relay projection (pure, ADR-034)
//
// identity-service is the gate's front door only because it alone holds the
// national-id HMAC key. It decides nothing: application-service does. What it
// relays is REBUILT from a closed allowlist here, so a field application-
// service may add tomorrow cannot reach the gate tablet by accident, and a
// body that does not match the contract is a 502, never relayed.
// ══════════════════════════════════════════════════════════════════

export interface RelayedResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONFLICTS = new Set(['ALREADY_ADMITTED', 'NOT_ADMISSIBLE', 'IDENTITY_MISMATCH', 'MANUAL_IDENTITY_REQUIRED', 'WRONG_VENUE', 'TOO_EARLY', 'EXPIRED']);
/** ADR-037: the identity method an admission recorded. */
const IDENTITY_METHODS = new Set(['NATIONAL_ID_CARD', 'NATIONAL_ID_CARD+CARD_PORTRAIT', 'NATIONAL_ID_CARD+SUPERVISOR']);
const INVALID_REASONS = new Set(['MALFORMED_TICKET', 'WRONG_AGENCY', 'UNKNOWN_TICKET', 'TICKET_NOT_ISSUED']);

function str(v: unknown, max = 200): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isoInstant(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function candidate(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c['applicationId'] !== 'string' || !UUID_RE.test(c['applicationId'])) return null;
  if (!str(c['processingCode'], 32) || typeof c['category'] !== 'string' || !CODE_RE.test(c['category'])) return null;
  return { applicationId: c['applicationId'], processingCode: c['processingCode'], category: c['category'] };
}

/** The allowlisted result for an application-service status + body, or null. */
export function projectGateAdmission(status: number, raw: unknown): RelayedResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;

  if (status === 200) {
    const cand = candidate(b['candidate']);
    if (
      b['outcome'] !== 'ADMITTED' || cand === null || !str(b['venueName']) ||
      typeof b['examDate'] !== 'string' || !DATE_RE.test(b['examDate']) ||
      typeof b['reportingTimeHour'] !== 'number' || !isoInstant(b['admittedAt']) ||
      typeof b['statusAdvanced'] !== 'boolean' ||
      typeof b['identityMethod'] !== 'string' || !IDENTITY_METHODS.has(b['identityMethod'])
    ) {
      return null;
    }
    return {
      status: 200,
      body: {
        outcome: 'ADMITTED',
        candidate: cand,
        venueName: b['venueName'],
        examDate: b['examDate'],
        reportingTimeHour: b['reportingTimeHour'],
        admittedAt: b['admittedAt'],
        statusAdvanced: b['statusAdvanced'],
        identityMethod: b['identityMethod'],
      },
    };
  }

  if (status === 409) {
    const error = b['error'];
    if (typeof error !== 'string' || !CONFLICTS.has(error)) return null;
    switch (error) {
      case 'ALREADY_ADMITTED': {
        const cand = candidate(b['candidate']);
        if (cand === null || !isoInstant(b['admittedAt']) || !str(b['venueName']) || typeof b['admittedBySelf'] !== 'boolean') return null;
        return {
          status: 409,
          body: { error, candidate: cand, admittedAt: b['admittedAt'], venueName: b['venueName'], admittedBySelf: b['admittedBySelf'] },
        };
      }
      case 'NOT_ADMISSIBLE': {
        const cand = candidate(b['candidate']);
        if (cand === null || typeof b['currentStatus'] !== 'string' || !CODE_RE.test(b['currentStatus'])) return null;
        return { status: 409, body: { error, candidate: cand, currentStatus: b['currentStatus'] } };
      }
      case 'IDENTITY_MISMATCH':
      case 'MANUAL_IDENTITY_REQUIRED': {
        const cand = candidate(b['candidate']);
        if (cand === null) return null;
        return { status: 409, body: { error, candidate: cand } };
      }
      case 'WRONG_VENUE':
        if (!str(b['ticketVenueName'])) return null;
        return { status: 409, body: { error, ticketVenueName: b['ticketVenueName'] } };
      default: // TOO_EARLY | EXPIRED
        if (typeof b['examDate'] !== 'string' || !DATE_RE.test(b['examDate'])) return null;
        return { status: 409, body: { error, examDate: b['examDate'] } };
    }
  }

  if (status === 422) {
    if (b['error'] !== 'INVALID_TICKET' || typeof b['reason'] !== 'string' || !INVALID_REASONS.has(b['reason'])) return null;
    return { status: 422, body: { error: 'INVALID_TICKET', reason: b['reason'] } };
  }

  return null;
}

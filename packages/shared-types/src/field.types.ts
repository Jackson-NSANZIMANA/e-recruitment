// ── Field Tablet Physical Test Scoring ───────────────────────────

export interface PhysicalTestMetrics {
  readonly heightCm: number;             // Bounds: 140-220
  readonly weightKg: number;             // Bounds: 40-150
  readonly run3kmTimeSeconds: number;    // 3km run time
  readonly chestCm: number;
  readonly medicalFitnessStatus: 'FIT' | 'UNFIT' | 'PENDING_REVIEW';
  readonly additionalNotes?: string;
}

export interface FieldScoreRecord {
  readonly applicationId: string;
  readonly qrInvitationCode: string;     // Scanned from applicant's QR
  readonly metrics: PhysicalTestMetrics;
  readonly capturedAt: string;           // ISO 8601
  readonly deviceId: string;
  readonly capturingOfficerId: string;
  readonly vectorClock: Record<string, number>;
  readonly deviceSignature: string;      // Ed25519 signature
  readonly signedPayloadHash: string;    // SHA-256 of metrics payload
}

/**
 * Why a field-sync record was REFUSED (D11). Closed set, because the tablet's
 * sync centre renders one state per reason and a free-text reason is a reason
 * nobody tests.
 *
 * OFFICER_MISMATCH is the D11 fix: the record's signed capturingOfficerId did
 * not name the officer who is uploading it. The device signs its own claim about
 * who captured a citizen's physical test; the platform's answer is that the
 * authenticated principal is the only actor, so a disagreeing claim is refused
 * rather than stored.
 */
export type FieldScoreRejectReason =
  | 'UNENROLLED_DEVICE'
  | 'REVOKED_DEVICE'
  | 'AGENCY_MISMATCH'
  | 'OFFICER_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'TICKET_MISMATCH'
  | 'NOT_ADMITTED';

// ── CRDT Merge Result ─────────────────────────────────────────────

export interface CRDTMergeResult {
  readonly merged: boolean;
  readonly conflict: boolean;
  readonly conflictReason?: string;
  readonly winningRecord?: FieldScoreRecord;
}

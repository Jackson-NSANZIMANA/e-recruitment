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

// ── CRDT Merge Result ─────────────────────────────────────────────

export interface CRDTMergeResult {
  readonly merged: boolean;
  readonly conflict: boolean;
  readonly conflictReason?: string;
  readonly winningRecord?: FieldScoreRecord;
}

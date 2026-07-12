// ══════════════════════════════════════════════════════════════════
// field-sync-service — FieldScoreStore port
//
// Owns the physical_test_scores CRDT log in the applicant's OWNING agency ops
// schema (ADR-006 / ADR-010 §4). It performs the vector-clock merge decision
// under a per-application lock and materialises the result:
//   • sync()            — merge one verified record; append / flag conflict / no-op
//   • resolveConflict() — an officer picks the authoritative record; clear the
//                         conflict and surface that record so the application
//                         can finally advance.
// All writes run as usrp_system_service. The cross-agency guard is the
// application lookup: an application absent from THIS agency's schema ⇒ NOT_FOUND.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';
import type { VectorClock } from '../domain/vector-clock.js';

/** A verified score record ready to merge (signature already checked upstream). */
export interface SyncRecordInput {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly qrInvitationCode: string;
  readonly deviceId: string;
  readonly capturingOfficerId: string;
  readonly capturedAt: string;
  readonly vectorClock: VectorClock;
  readonly deviceSignature: string;
  readonly signedPayloadHash: string;
  readonly metrics: {
    readonly heightCm: number;
    readonly weightKg: number;
    readonly run3kmTimeSeconds: number;
    readonly chestCm: number;
    readonly medicalFitnessStatus: string;
    readonly additionalNotes?: string;
  };
}

/** Application-derived fields the FIELD_SCORE_CAPTURED event needs. */
export interface CapturedContext {
  readonly scoreId: string;
  readonly campaignId: string;
  readonly isWalkIn: boolean;
}

export type SyncOutcome =
  /** First record / valid correction stored as the new head — emit + advance. */
  | ({ readonly kind: 'ACCEPTED' | 'SUPERSEDED' } & CapturedContext)
  /** Concurrent with a head — both kept, conflict flagged, application HELD (no emit). */
  | ({ readonly kind: 'CONFLICT' } & CapturedContext)
  /** Older than / equal to the head — no-op. */
  | { readonly kind: 'STALE' }
  /** Exact signed payload already stored — idempotent no-op. */
  | { readonly kind: 'DUPLICATE' }
  /** No such application in THIS agency's schema — the cross-agency write guard. */
  | { readonly kind: 'NOT_FOUND' };

export interface ResolveConflictInput {
  readonly applicationId: string;
  readonly agency: Agency;
  /** The score row the officer selects as authoritative. */
  readonly scoreId: string;
  /** Free-text/label recorded in sync_conflict_resolution (≤50 chars). */
  readonly resolution: string;
}

/** The chosen record's fields — enough to emit FIELD_SCORE_CAPTURED for it. */
export interface ResolvedRecord extends CapturedContext {
  readonly deviceId: string;
  readonly capturingOfficerId: string;
  readonly vectorClock: VectorClock;
  readonly signedPayloadHash: string;
}

export type ResolveOutcome =
  | ({ readonly kind: 'RESOLVED' } & ResolvedRecord)
  /** No application in this agency's schema. */
  | { readonly kind: 'NOT_FOUND' }
  /** The application has no flagged conflict to resolve. */
  | { readonly kind: 'NO_CONFLICT' }
  /** The chosen score row does not belong to this application. */
  | { readonly kind: 'SCORE_NOT_FOUND' };

export interface FieldScoreStore {
  sync(input: SyncRecordInput): Promise<SyncOutcome>;
  resolveConflict(input: ResolveConflictInput): Promise<ResolveOutcome>;
}

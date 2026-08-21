// ══════════════════════════════════════════════════════════════════
// field-sync-service — FieldScoreStore adapter (PostgreSQL)
//
// The CRDT log lives in physical_test_scores, one immutable row per captured
// record. All work runs as usrp_system_service inside one transaction per
// record, holding a FOR UPDATE lock on the applications row so concurrent syncs
// for the same applicant serialise (offline tablets can race on re-connect).
//
// The pure decideMerge() (domain) chooses the action from the incoming clock
// and the stored set; this adapter materialises it:
//   ACCEPT / SUPERSEDE → INSERT the new head, clear any conflict flags (a
//                        dominating record resolves a prior conflict).
//   CONFLICT           → INSERT the record AND flag the whole set; the app is
//                        held (no event emitted by the caller).
//   STALE / DUPLICATE  → no write.
// Corrections are always NEW rows — stored history is never mutated (ADR-003 §4).
// The cross-agency guard is the application lookup: absent here ⇒ NOT_FOUND.
// ══════════════════════════════════════════════════════════════════

import { sql, asJsonb } from '@usrp/shared-database';
import { decideMerge } from '../domain/merge.js';
import type { VectorClock } from '../domain/vector-clock.js';
import { OPS_SCHEMA } from '../domain/agency-schema.js';
import { FieldSyncPersistenceError } from '../domain/field-sync.errors.js';
import type {
  FieldScoreStore,
  ResolveConflictInput,
  ResolveOutcome,
  SyncOutcome,
  SyncRecordInput,
} from '../ports/field-score-store.js';

const SYSTEM_ROLE = 'usrp_system_service';

interface AppRow {
  readonly campaign_id: string;
  readonly is_walk_in: boolean;
}
interface StoredRow {
  readonly id: string;
  readonly vector_clock: VectorClock;
  readonly signed_payload_hash: string;
}

export class PgFieldScoreStore implements FieldScoreStore {
  async sync(input: SyncRecordInput): Promise<SyncOutcome> {
    const schema = sql(OPS_SCHEMA[input.agency]);
    try {
      return await sql.begin(async (tx): Promise<SyncOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // Lock the application → serialise concurrent syncs; also the
        // cross-agency guard (0 rows ⇒ not in THIS agency's schema).
        const appRows = await tx<AppRow[]>`
          SELECT campaign_id, is_walk_in
          FROM ${schema}.applications
          WHERE id = ${input.applicationId}
          FOR UPDATE
        `;
        const app = appRows[0];
        if (!app) return { kind: 'NOT_FOUND' };

        const existing = await tx<StoredRow[]>`
          SELECT id, vector_clock, signed_payload_hash
          FROM ${schema}.physical_test_scores
          WHERE application_id = ${input.applicationId}
        `;

        const decision = decideMerge(
          { vectorClock: input.vectorClock, signedPayloadHash: input.signedPayloadHash },
          existing.map((r) => ({
            vectorClock: r.vector_clock,
            signedPayloadHash: r.signed_payload_hash,
          })),
        );

        if (decision.kind === 'DUPLICATE') return { kind: 'DUPLICATE' };
        if (decision.kind === 'STALE') return { kind: 'STALE' };

        // ACCEPT | SUPERSEDE | CONFLICT all append a new immutable record.
        const isConflict = decision.kind === 'CONFLICT';
        const insertedRows = await tx<{ id: string }[]>`
          INSERT INTO ${schema}.physical_test_scores
            (application_id, vector_clock, device_id,
             height_cm, weight_kg, run_3km_time_seconds, chest_cm,
             medical_fitness_status, additional_notes,
             device_signature, signed_payload_hash,
             capturing_officer_id, captured_at, synced_at, sync_conflict_detected)
          VALUES (
            ${input.applicationId},
            ${tx.json(asJsonb(input.vectorClock))},
            ${input.deviceId},
            ${input.metrics.heightCm},
            ${input.metrics.weightKg},
            ${input.metrics.run3kmTimeSeconds},
            ${input.metrics.chestCm},
            ${input.metrics.medicalFitnessStatus},
            ${input.metrics.additionalNotes ?? null},
            ${input.deviceSignature},
            ${input.signedPayloadHash},
            ${input.capturingOfficerId},
            ${input.capturedAt}::timestamptz,
            now(),
            ${isConflict}
          )
          RETURNING id
        `;
        const scoreId = insertedRows[0]?.id;
        if (!scoreId) throw new FieldSyncPersistenceError('Score insert returned no row');

        // Keep sync_conflict_detected consistent across the record set: a
        // dominating record RESOLVES a prior conflict; a concurrent one CREATES
        // one. Flag/unflag the whole application's rows in one statement.
        await tx`
          UPDATE ${schema}.physical_test_scores
          SET sync_conflict_detected = ${isConflict}
          WHERE application_id = ${input.applicationId}
        `;

        if (isConflict) {
          return { kind: 'CONFLICT', scoreId, campaignId: app.campaign_id, isWalkIn: app.is_walk_in };
        }
        return {
          kind: decision.kind === 'SUPERSEDE' ? 'SUPERSEDED' : 'ACCEPTED',
          scoreId,
          campaignId: app.campaign_id,
          isWalkIn: app.is_walk_in,
        };
      });
    } catch (cause) {
      if (cause instanceof FieldSyncPersistenceError) throw cause;
      throw new FieldSyncPersistenceError('Failed to sync field score', { cause });
    }
  }

  async resolveConflict(input: ResolveConflictInput): Promise<ResolveOutcome> {
    const schema = sql(OPS_SCHEMA[input.agency]);
    try {
      return await sql.begin(async (tx): Promise<ResolveOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        const appRows = await tx<AppRow[]>`
          SELECT campaign_id, is_walk_in
          FROM ${schema}.applications
          WHERE id = ${input.applicationId}
          FOR UPDATE
        `;
        const app = appRows[0];
        if (!app) return { kind: 'NOT_FOUND' };

        const conflicted = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM ${schema}.physical_test_scores
          WHERE application_id = ${input.applicationId} AND sync_conflict_detected = true
        `;
        if ((conflicted[0]?.n ?? 0) === 0) return { kind: 'NO_CONFLICT' };

        const chosen = await tx<
          {
            device_id: string;
            capturing_officer_id: string;
            vector_clock: VectorClock;
            signed_payload_hash: string;
          }[]
        >`
          SELECT device_id, capturing_officer_id, vector_clock, signed_payload_hash
          FROM ${schema}.physical_test_scores
          WHERE id = ${input.scoreId} AND application_id = ${input.applicationId}
        `;
        const rec = chosen[0];
        if (!rec) return { kind: 'SCORE_NOT_FOUND' };

        // Clear the conflict across the set; stamp the resolution on the chosen
        // record. History is not deleted — the losing records remain, now
        // superseded by the officer's explicit choice.
        await tx`
          UPDATE ${schema}.physical_test_scores
          SET sync_conflict_detected = false
          WHERE application_id = ${input.applicationId}
        `;
        await tx`
          UPDATE ${schema}.physical_test_scores
          SET sync_conflict_resolution = ${input.resolution}
          WHERE id = ${input.scoreId}
        `;

        return {
          kind: 'RESOLVED',
          scoreId: input.scoreId,
          campaignId: app.campaign_id,
          isWalkIn: app.is_walk_in,
          deviceId: rec.device_id,
          capturingOfficerId: rec.capturing_officer_id,
          vectorClock: rec.vector_clock,
          signedPayloadHash: rec.signed_payload_hash,
        };
      });
    } catch (cause) {
      if (cause instanceof FieldSyncPersistenceError) throw cause;
      throw new FieldSyncPersistenceError('Failed to resolve field-score conflict', { cause });
    }
  }
}

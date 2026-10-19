// ══════════════════════════════════════════════════════════════════
// application-service — BiometricEvidenceRepository adapter (PostgreSQL, rls/0034)
//
// Every call is one transaction AS THE OFFICER'S AGENCY ROLE. The row-level
// policy of rls/0034 hides SHADOW evidence from that role, so neither the
// officer read nor a confirmation can ever touch it. The confirmation insert
// is guarded again by the engine trigger (advisory NO_MATCH/INCONCLUSIVE,
// same application and ticket, not the capturing officer) and by the UNIQUE
// evidence_id index; the checks here only turn those into clean outcomes.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import {
  EVIDENCE_OUTCOMES,
  isManualIdentityReason,
  requiresManualIdentity,
  type EvidenceOutcome,
  type ManualIdentityReason,
} from '../domain/gate-identity.js';
import type {
  BiometricEvidenceRepository,
  ConfirmManualIdentityOutcome,
  EvidenceListOutcome,
  EvidenceView,
} from '../ports/biometric-evidence-repository.js';
import type { StageEvents } from '../ports/event-outbox.js';
import type { OfficerActor } from '../ports/officer-transition-repository.js';
import { stageEvents } from './outbox/pg-event-outbox.js';

interface EvidenceRow {
  readonly record_id: string;
  readonly ticket_id: string;
  readonly reference_source: string;
  readonly method: string;
  readonly consent_state: string;
  readonly outcome: string;
  readonly not_attempted_reason: string | null;
  readonly liveness_score_bp: number | null;
  readonly match_score_bp: number | null;
  readonly model_id: string | null;
  readonly model_version: string | null;
  readonly threshold_policy_version: string;
  readonly mode: string;
  readonly captured_at: Date;
  readonly received_at: Date;
  readonly reason_code: string | null;
  readonly confirmed_at: Date | null;
}

function outcomeOf(value: string): EvidenceOutcome {
  if (!(EVIDENCE_OUTCOMES as readonly string[]).includes(value)) {
    throw new ApplicationPersistenceError('Biometric evidence carries an unknown outcome');
  }
  return value as EvidenceOutcome;
}

function toView(row: EvidenceRow): EvidenceView {
  // Defence in depth: the policy already hides SHADOW; never project one.
  if (row.mode !== 'ADVISORY') throw new ApplicationPersistenceError('Non-advisory evidence reached an officer read');
  const reason = row.reason_code;
  return {
    recordId: row.record_id,
    ticketId: row.ticket_id,
    referenceSource: row.reference_source,
    method: row.method,
    consentState: row.consent_state,
    outcome: outcomeOf(row.outcome),
    notAttemptedReason: row.not_attempted_reason,
    livenessScoreBp: row.liveness_score_bp,
    matchScoreBp: row.match_score_bp,
    modelId: row.model_id,
    modelVersion: row.model_version,
    thresholdPolicyVersion: row.threshold_policy_version,
    mode: 'ADVISORY',
    capturedAt: row.captured_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    manualIdentity: reason !== null && isManualIdentityReason(reason) && row.confirmed_at !== null
      ? { reasonCode: reason, confirmedAt: row.confirmed_at.toISOString() }
      : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export class PgBiometricEvidenceRepository implements BiometricEvidenceRepository {
  async list(actor: OfficerActor, applicationId: string): Promise<EvidenceListOutcome> {
    const schema = sql(schemaForAgency(actor.agency));
    try {
      return await sql.begin(async (tx): Promise<EvidenceListOutcome> => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;
        const app = await tx<{ id: string }[]>`SELECT id FROM ${schema}.applications WHERE id = ${applicationId}`;
        if (!app[0]) return { kind: 'NOT_FOUND' };
        const rows = await tx<EvidenceRow[]>`
          SELECT e.record_id, e.ticket_id, e.reference_source, e.method, e.consent_state, e.outcome,
                 e.not_attempted_reason, e.liveness_score_bp, e.match_score_bp, e.model_id,
                 e.model_version, e.threshold_policy_version, e.mode, e.captured_at, e.received_at,
                 c.reason_code, c.confirmed_at
          FROM ${schema}.biometric_evidence AS e
          LEFT JOIN ${schema}.gate_manual_identity_confirmations AS c ON c.evidence_id = e.id
          WHERE e.application_id = ${applicationId}
          ORDER BY e.received_at, e.id
          LIMIT 50
        `;
        return { kind: 'OK', applicationId, evidence: rows.map(toView) };
      });
    } catch (err) {
      if (err instanceof ApplicationPersistenceError) throw err;
      throw new ApplicationPersistenceError('Reading biometric evidence failed', { cause: err });
    }
  }

  async confirm(
    actor: OfficerActor,
    recordId: string,
    reasonCode: ManualIdentityReason,
    stage: StageEvents<ConfirmManualIdentityOutcome>,
  ): Promise<ConfirmManualIdentityOutcome> {
    const schema = sql(schemaForAgency(actor.agency));
    try {
      return await sql.begin(async (tx): Promise<ConfirmManualIdentityOutcome> => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;
        const rows = await tx<{ id: string; application_id: string; ticket_id: string; outcome: string; officer_id: string; confirmed: boolean }[]>`
          SELECT e.id, e.application_id, e.ticket_id, e.outcome, e.officer_id,
                 EXISTS (SELECT 1 FROM ${schema}.gate_manual_identity_confirmations c WHERE c.evidence_id = e.id) AS confirmed
          FROM ${schema}.biometric_evidence AS e
          WHERE e.record_id = ${recordId}
        `;
        const ev = rows[0];
        if (!ev) return { kind: 'NOT_FOUND' };
        if (!requiresManualIdentity(outcomeOf(ev.outcome))) return { kind: 'NOT_REQUIRED' };
        if (ev.confirmed) return { kind: 'ALREADY_CONFIRMED' };
        if (ev.officer_id === actor.officerId) return { kind: 'SAME_OFFICER' };
        const inserted = await tx<{ id: string; confirmed_at: Date }[]>`
          INSERT INTO ${schema}.gate_manual_identity_confirmations
            (evidence_id, application_id, ticket_id, reason_code, confirmed_by_id, correlation_id)
          VALUES (${ev.id}, ${ev.application_id}, ${ev.ticket_id}, ${reasonCode}, ${actor.officerId},
                  ${/^[A-Za-z0-9._:-]{1,128}$/.test(actor.correlationId) ? actor.correlationId : null})
          RETURNING id, confirmed_at
        `;
        const row = inserted[0];
        if (!row) throw new ApplicationPersistenceError('Confirmation insert returned no row');
        const outcome: ConfirmManualIdentityOutcome = {
          kind: 'CONFIRMED',
          confirmationId: row.id,
          recordId,
          applicationId: ev.application_id,
          confirmedAt: row.confirmed_at.toISOString(),
        };
        await stageEvents(tx, stage(outcome));
        return outcome;
      });
    } catch (err) {
      // Two supervisors in the same instant: the UNIQUE index decides.
      if (isUniqueViolation(err)) return { kind: 'ALREADY_CONFIRMED' };
      if (err instanceof ApplicationPersistenceError) throw err;
      throw new ApplicationPersistenceError('Recording the manual identity confirmation failed', { cause: err });
    }
  }
}

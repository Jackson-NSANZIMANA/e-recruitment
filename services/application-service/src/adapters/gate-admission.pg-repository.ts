// ══════════════════════════════════════════════════════════════════
// application-service — GateAdmissionRepository adapter (PostgreSQL)
//
// One transaction AS THE OFFICER'S AGENCY ROLE (usrp_<agency>_officer), so a
// sibling agency's applications are not merely filtered out — the role has no
// grant on them. Inside it:
//
//   1. FOR UPDATE the application row. Two gates scanning the same QR in the
//      same instant serialise here; the second sees the first's admission.
//   2. decideBeforeIdentity() — the contract order of domain/gate-admission.ts.
//   3. Only for a genuine, unspent, on-venue, on-day ticket: ask
//      <schema>.gate_identity_matches(application, hash). The comparison runs
//      in the engine and answers a boolean; the stored hash is never read
//      into this process on the gate path.
//   4. ADMIT: insert the admission (UNIQUE application, UNIQUE ticket — single
//      use is a database fact), advance SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED
//      with an attributed history row, and stamp physical_test_scheduled_at.
//   5. Whatever the outcome, append the attempt, then stage the audit events
//      LAST (rls/0023 lets the officer role stage, never read, outbox rows).
//
// Backstop: if the unique index ever fires despite the lock (a write that
// bypassed this adapter), the transaction is retried once and the retry reads
// the existing admission — the answer is ALREADY_ADMITTED, never a 500.
// ══════════════════════════════════════════════════════════════════

import { sql, type SqlTransaction } from '@usrp/shared-database';
import type { ApplicationCategory, ApplicationStatus } from '@usrp/shared-types';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import { decideBeforeIdentity, type GateOutcome } from '../domain/gate-admission.js';
import { EVIDENCE_OUTCOMES, resolveGateIdentity, type EvidenceOutcome, type VisibleEvidence } from '../domain/gate-identity.js';
import type {
  GateAdmissionInput,
  GateAdmissionOutcome,
  GateAdmissionRepository,
  GateCandidate,
} from '../ports/gate-admission-repository.js';
import type { StageEvents } from '../ports/event-outbox.js';
import { stageEvents } from './outbox/pg-event-outbox.js';

interface ApplicationRow {
  readonly status: ApplicationStatus;
  readonly qr_signed_token: string | null;
  readonly processing_code: string;
  readonly category: ApplicationCategory;
  readonly campaign_id: string;
}

interface AdmissionRow {
  readonly admitted_at: Date;
  readonly venue_name: string;
  readonly admitted_by_id: string;
}

/** The unique index on gate_admissions refused a second admission. */
function isAdmissionUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint_name: constraint } = err as { code?: unknown; constraint_name?: unknown };
  return (
    code === '23505' &&
    typeof constraint === 'string' &&
    /^idx_(rdf|rnp|rcs)_gate_admissions_(application|ticket)$/.test(constraint)
  );
}

export class PgGateAdmissionRepository implements GateAdmissionRepository {
  async admit(
    input: GateAdmissionInput,
    stage: StageEvents<GateAdmissionOutcome>,
  ): Promise<GateAdmissionOutcome> {
    try {
      return await this.#attempt(input, stage);
    } catch (err) {
      if (isAdmissionUniqueViolation(err)) {
        try {
          return await this.#attempt(input, stage);
        } catch (retryErr) {
          throw new ApplicationPersistenceError('Gate admission failed on retry', { cause: retryErr });
        }
      }
      if (err instanceof ApplicationPersistenceError) throw err;
      throw new ApplicationPersistenceError('Gate admission failed', { cause: err });
    }
  }

  #attempt(input: GateAdmissionInput, stage: StageEvents<GateAdmissionOutcome>): Promise<GateAdmissionOutcome> {
    const { actor, claims } = input;
    const schemaName = schemaForAgency(actor.agency);
    const schema = sql(schemaName);

    return sql.begin(async (tx): Promise<GateAdmissionOutcome> => {
      await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

      const finish = async (
        outcome: GateAdmissionOutcome,
        applicationId: string | null,
      ): Promise<GateAdmissionOutcome> => {
        await recordAttempt(tx, schemaName, {
          applicationId,
          ticketId: claims?.ticketId ?? null,
          outcome: outcome.outcome,
          gateVenueName: input.gateVenueName,
          officerId: actor.officerId,
          correlationId: actor.correlationId,
        });
        await stageEvents(tx, stage(outcome));
        return outcome;
      };

      if (claims === null) return finish({ outcome: 'MALFORMED_TICKET' }, null);
      if (claims.agency !== actor.agency) return finish({ outcome: 'WRONG_AGENCY' }, null);

      const rows = await tx<ApplicationRow[]>`
        SELECT status, qr_signed_token, processing_code, category::text AS category, campaign_id
        FROM ${schema}.applications
        WHERE id = ${claims.applicationId}
        FOR UPDATE
      `;
      const app = rows[0];
      if (!app) return finish({ outcome: 'UNKNOWN_TICKET' }, null);

      const admissions = await tx<AdmissionRow[]>`
        SELECT admitted_at, venue_name, admitted_by_id
        FROM ${schema}.gate_admissions
        WHERE application_id = ${claims.applicationId}
      `;
      const prior = admissions[0];
      const candidate: GateCandidate = {
        applicationId: claims.applicationId,
        processingCode: app.processing_code,
        category: app.category,
      };

      const decision = decideBeforeIdentity(
        claims,
        input.token,
        { status: app.status, storedToken: app.qr_signed_token, alreadyAdmitted: prior !== undefined },
        input.gateVenueName,
        input.now,
      );
      if (decision.kind === 'REFUSE') {
        const refused = refusal(decision.outcome, candidate, app, claims, prior, actor.officerId);
        return finish(refused, claims.applicationId);
      }

      const match = await tx<{ matches: boolean }[]>`
        SELECT ${sql(schemaName)}.gate_identity_matches(${claims.applicationId}::uuid, ${input.nationalIdHash}) AS matches
      `;
      if (match[0]?.matches !== true) {
        return finish({ outcome: 'IDENTITY_MISMATCH', candidate }, claims.applicationId);
      }

      // Check 10 (ADR-037): biometric evidence for THIS ticket, as the officer's
      // own agency role — rls/0034 hides SHADOW rows from it, so they cannot
      // influence the admission. Evidence never refuses: an unconfirmed
      // negative only asks for supervised manual identity.
      const evidenceRows = await tx<{ id: string; outcome: string; confirmation_id: string | null; confirmed_by_id: string | null }[]>`
        SELECT e.id, e.outcome, c.id AS confirmation_id, c.confirmed_by_id
        FROM ${schema}.biometric_evidence AS e
        LEFT JOIN ${schema}.gate_manual_identity_confirmations AS c ON c.evidence_id = e.id
        WHERE e.application_id = ${claims.applicationId} AND e.ticket_id = ${claims.ticketId}
        ORDER BY e.received_at, e.id
      `;
      const identity = resolveGateIdentity(evidenceRows.map(toVisibleEvidence), actor.officerId);
      if (identity.kind === 'MANUAL_IDENTITY_REQUIRED') {
        return finish(
          { outcome: 'MANUAL_IDENTITY_REQUIRED', candidate, evidenceIds: identity.evidenceIds },
          claims.applicationId,
        );
      }

      const inserted = await tx<{ admitted_at: Date }[]>`
        INSERT INTO ${schema}.gate_admissions
          (application_id, ticket_id, campaign_id, venue_name, exam_date,
           identity_method, admitted_by_id, correlation_id)
        VALUES (
          ${claims.applicationId}, ${claims.ticketId}, ${app.campaign_id}, ${claims.venueName},
          ${claims.examDate}::date, ${identity.identityMethod}, ${actor.officerId}, ${actor.correlationId}
        )
        RETURNING admitted_at
      `;
      const admittedAt = inserted[0]?.admitted_at;
      if (admittedAt === undefined) throw new ApplicationPersistenceError('Admission insert returned no row');

      let advancedTo: 'PHYSICAL_TEST_SCHEDULED' | null = null;
      if (app.status === 'SLOT_ASSIGNED') {
        await tx`
          UPDATE ${schema}.applications SET
            status = 'PHYSICAL_TEST_SCHEDULED'::${schema}.application_status,
            physical_test_scheduled_at = ${admittedAt},
            updated_at = now()
          WHERE id = ${claims.applicationId}
        `;
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${claims.applicationId},
            'SLOT_ASSIGNED'::${schema}.application_status,
            'PHYSICAL_TEST_SCHEDULED'::${schema}.application_status,
            'Admitted at the venue gate',
            ${actor.officerId},
            ${actor.correlationId}
          )
        `;
        advancedTo = 'PHYSICAL_TEST_SCHEDULED';
      }

      return finish(
        {
          outcome: 'ADMITTED',
          candidate,
          ticketId: claims.ticketId,
          venueName: claims.venueName,
          examDate: claims.examDate,
          reportingTimeHour: claims.reportingTimeHour,
          admittedAt: admittedAt.toISOString(),
          fromStatus: app.status,
          advancedTo,
          identityMethod: identity.identityMethod,
          evidenceIds: identity.evidenceIds,
          confirmationIds: identity.confirmationIds,
        },
        claims.applicationId,
      );
    });
  }
}

function refusal(
  outcome: Exclude<GateOutcome, 'ADMITTED' | 'IDENTITY_MISMATCH' | 'MANUAL_IDENTITY_REQUIRED'>,
  candidate: GateCandidate,
  app: ApplicationRow,
  claims: { readonly venueName: string; readonly examDate: string },
  prior: AdmissionRow | undefined,
  officerId: string,
): GateAdmissionOutcome {
  switch (outcome) {
    case 'ALREADY_ADMITTED':
      // decideBeforeIdentity returns this only when a prior admission exists.
      return {
        outcome,
        candidate,
        admittedAt: prior?.admitted_at.toISOString() ?? '',
        venueName: prior?.venue_name ?? '',
        admittedBySelf: prior?.admitted_by_id === officerId,
      };
    case 'NOT_ADMISSIBLE':
      return { outcome, candidate, currentStatus: app.status };
    case 'WRONG_VENUE':
      return { outcome, ticketVenueName: claims.venueName };
    case 'TOO_EARLY':
    case 'EXPIRED':
      return { outcome, examDate: claims.examDate };
    case 'MALFORMED_TICKET':
    case 'WRONG_AGENCY':
    case 'UNKNOWN_TICKET':
    case 'TICKET_NOT_ISSUED':
      return { outcome };
  }
}

function toVisibleEvidence(row: {
  readonly id: string;
  readonly outcome: string;
  readonly confirmation_id: string | null;
  readonly confirmed_by_id: string | null;
}): VisibleEvidence {
  if (!(EVIDENCE_OUTCOMES as readonly string[]).includes(row.outcome)) {
    throw new ApplicationPersistenceError('Biometric evidence carries an unknown outcome');
  }
  return {
    evidenceId: row.id,
    outcome: row.outcome as EvidenceOutcome,
    confirmation: row.confirmation_id !== null && row.confirmed_by_id !== null
      ? { confirmationId: row.confirmation_id, confirmedById: row.confirmed_by_id }
      : null,
  };
}

async function recordAttempt(
  tx: SqlTransaction,
  schemaName: string,
  a: {
    readonly applicationId: string | null;
    readonly ticketId: string | null;
    readonly outcome: GateOutcome;
    readonly gateVenueName: string;
    readonly officerId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  await tx`
    INSERT INTO ${sql(schemaName)}.gate_admission_attempts
      (application_id, ticket_id, outcome, gate_venue_name, officer_id, correlation_id)
    VALUES (
      ${a.applicationId}, ${a.ticketId === null ? null : a.ticketId.slice(0, 64)}, ${a.outcome},
      ${a.gateVenueName.slice(0, 200)}, ${a.officerId}, ${a.correlationId.slice(0, 128)}
    )
  `;
}

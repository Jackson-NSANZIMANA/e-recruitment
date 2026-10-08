// ══════════════════════════════════════════════════════════════════
// application-service — WalkInRepository adapter (PostgreSQL)
//
// The walk-in lane's durable writes (ADR-012), both AS THE OFFICER'S DB ROLE
// — the registration is the first officer-role INSERT of an applications row
// (Slice 4 proved officer-role UPDATEs; rls/0001 grants INSERT + sequence
// USAGE, verified live). Cross-agency isolation is engine-enforced: the RDF
// officer role cannot touch sibling schemas at all.
//
//   createWalkInApplication — one tx: mint the processing code from the
//     agency sequence, INSERT at WALK_IN_REGISTERED (is_walk_in = true,
//     qr_invitation_code = the minted on-site ticket), append the opening
//     history row (null → WALK_IN_REGISTERED, performed_by = officer UUID).
//   vetOnSite — one tx: FOR UPDATE the row, gate on the autonomous AGE
//     verdict already projected onto it: ELIGIBLE → WALK_IN_ON_SITE_VETTING,
//     INELIGIBLE → WALK_IN_REJECTED (terminal), PENDING → AGE_PENDING (retry).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { AgeEligibilityStatus, ApplicationStatus } from '@usrp/shared-types';
import type {
  CreateWalkInInput,
  CreateWalkInOutcome,
  CreateWalkInResult,
  VetOnSiteInput,
  VetOnSiteOutcome,
  WalkInRepository,
} from '../ports/walk-in-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { AGENCY_TARGET } from '../domain/agency-schema.js';
import {
  CampaignUnavailableForApplicationError,
  findLiveApplication,
  isLiveIntentViolation,
  lockCampaignForApplicationInsert,
} from './application-insert.js';
import { stageEvents } from './outbox/pg-event-outbox.js';
import type { StageEvents } from '../ports/event-outbox.js';

export class PgWalkInRepository implements WalkInRepository {
  async createWalkInApplication(
    input: CreateWalkInInput,
    stage: StageEvents<CreateWalkInResult>,
  ): Promise<CreateWalkInOutcome> {
    const target = AGENCY_TARGET[input.actor.agency];
    const schema = sql(target.schema); // quoted identifier fragment
    const seqName = `${target.schema}.processing_code_seq`;

    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(input.actor.dbRole)}`;
        await lockCampaignForApplicationInsert(tx, input.actor.agency, input.campaignId);

        const inserted = await tx<{ id: string; processing_code: string }[]>`
          INSERT INTO ${schema}.applications
            (processing_code, applicant_id, campaign_id, category, status,
             is_walk_in, qr_invitation_code, qr_invitation_issued_at,
             nesa_index_number, hec_registration_number, submitted_at)
          VALUES (
            ${target.codePrefix} || '-' || lpad(nextval(${seqName}::regclass)::text, 5, '0'),
            ${input.applicantId},
            ${input.campaignId},
            ${input.category}::${schema}.application_category,
            'WALK_IN_REGISTERED',
            true,
            ${input.qrInvitationCode},
            now(),
            ${input.nesaIndexNumber},
            ${input.hecRegistrationNumber},
            now()
          )
          RETURNING id, processing_code
        `;
        const row = inserted[0];
        if (!row) {
          throw new ApplicationPersistenceError('Walk-in insert returned no row');
        }

        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${row.id},
            NULL,
            'WALK_IN_REGISTERED',
            'Walk-in registered on-site by field officer',
            ${input.actor.officerId},
            ${input.actor.correlationId}
          )
        `;

        const created: CreateWalkInResult = {
          applicationId: row.id,
          processingCode: row.processing_code,
        };

        // Stage LAST, still as the OFFICER role, so any staging failure rolls
        // the entire unit back (application, history, and both announcements).
        //
        // rls/0023 is what makes this reachable: it grants the officer roles
        // INSERT on the outbox — and only INSERT, under a producer-pinned
        // policy with no USING clause. Escalating to usrp_system_service here
        // instead would also work, but it would leave the transaction running
        // as the system role for its remaining lifetime, so any write added
        // after this line would silently lose the engine-enforced
        // cross-agency isolation that the officer role exists to provide.
        await stageEvents(tx, stage(created));

        return { kind: 'REGISTERED' as const, ...created };
      });
    } catch (cause) {
      if (cause instanceof CampaignUnavailableForApplicationError) {
        return { kind: 'NO_WALK_IN_CAMPAIGN' };
      }
      if (cause instanceof ApplicationPersistenceError) throw cause;
      // ADR-027: the live-intent index refused a second live application for
      // this candidate. Postgres has already aborted the transaction above,
      // so the winner is named in a fresh one and reported as a business
      // outcome — the officer gets the existing processing code, not a 500.
      if (isLiveIntentViolation(cause)) return await this.#existingApplication(input);
      throw new ApplicationPersistenceError('Failed to create walk-in application', { cause });
    }
  }

  /** Name the live application the candidate already holds. */
  async #existingApplication(input: CreateWalkInInput): Promise<CreateWalkInOutcome> {
    const target = AGENCY_TARGET[input.actor.agency];
    try {
      const existing = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(input.actor.dbRole)}`;
        return await findLiveApplication(
          tx,
          target,
          input.applicantId,
          input.campaignId,
          input.category,
        );
      });
      if (existing === null) {
        // Withdrawn between the refusal and this read — genuinely transient.
        throw new ApplicationPersistenceError(
          'live-intent conflict reported but no live application is visible',
        );
      }
      return { kind: 'ALREADY_APPLIED', ...existing };
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to resolve a duplicate walk-in', { cause });
    }
  }

  async vetOnSite(
    input: VetOnSiteInput,
    stage: StageEvents<VetOnSiteOutcome>,
  ): Promise<VetOnSiteOutcome> {
    const { actor, applicationId } = input;
    const schema = sql(AGENCY_TARGET[actor.agency].schema);

    try {
      return await sql.begin(async (tx): Promise<VetOnSiteOutcome> => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<
          { status: ApplicationStatus; age_eligibility_status: AgeEligibilityStatus }[]
        >`
          SELECT status, age_eligibility_status
          FROM ${schema}.applications WHERE id = ${applicationId} FOR UPDATE
        `;
        const current = rows[0];
        if (!current) return { kind: 'NOT_FOUND' };

        // Idempotent re-apply: already vetted (either verdict's landing spot).
        if (current.status === 'WALK_IN_ON_SITE_VETTING' || current.status === 'WALK_IN_REJECTED') {
          return { kind: 'NO_CHANGE', currentStatus: current.status };
        }
        if (current.status !== 'WALK_IN_REGISTERED') {
          return { kind: 'NOT_APPLICABLE', currentStatus: current.status };
        }

        // The gate itself: the AGE verdict the vetting projection landed off
        // the register's APPLICANT_SUBMITTED. On-site vetting asserts exactly
        // "identity NIDA-verified (register precondition) + age eligible" —
        // RIB/academic continue asynchronously on the backbone (owner D2); a
        // late flag routes to ADJUDICATION_REVIEW via the lifecycle policy.
        const age = current.age_eligibility_status;
        if (age === 'PENDING') {
          return { kind: 'AGE_PENDING', currentStatus: current.status };
        }
        const targetStatus: ApplicationStatus =
          age === 'ELIGIBLE' ? 'WALK_IN_ON_SITE_VETTING' : 'WALK_IN_REJECTED';

        await tx`
          UPDATE ${schema}.applications SET
            status = ${targetStatus}::${schema}.application_status,
            updated_at = now()
          WHERE id = ${applicationId}
        `;
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${applicationId},
            'WALK_IN_REGISTERED'::${schema}.application_status,
            ${targetStatus}::${schema}.application_status,
            ${`On-site vetting: age ${age}`},
            ${actor.officerId},
            ${actor.correlationId}
          )
        `;

        const applied: VetOnSiteOutcome = {
          kind: 'APPLIED',
          fromStatus: 'WALK_IN_REGISTERED',
          toStatus: targetStatus,
          ageStatus: age,
        };

        // As above: staged last, under the officer's own role (rls/0023).
        await stageEvents(tx, stage(applied));
        return applied;
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to apply on-site vetting', { cause });
    }
  }
}

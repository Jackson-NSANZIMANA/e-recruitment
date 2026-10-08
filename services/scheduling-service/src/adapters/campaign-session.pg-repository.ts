// BUILD-001 scheduling-service adapter for session configuration and coverage.
// Every changed session set is serialized on campaign row -> coverage head ->
// session row, and the session mutation, command ledger, coverage hash, and
// AUDIT_ENTRY outbox row commit atomically.

import { randomUUID } from 'node:crypto';
import {
  asJsonb,
  sql,
  stageOutboxEvents,
  type SqlTransaction,
} from '@usrp/shared-database';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import { campaignCoverageHash, type CampaignCoverageSessionValue } from '@usrp/shared-security';
import type {
  Agency,
  CampaignStatus,
  CampaignSessionInput,
} from '@usrp/shared-types';
import type {
  CampaignSessionCommand,
  CampaignSessionCommit,
  CampaignSessionRepository,
  StageCampaignSessionEvents,
} from '../ports/campaign-session.repository.js';
import { CampaignSessionCommandError } from '../application/campaign-session.service.js';
import { CampaignSessionInputError } from '../domain/campaign-session-validation.js';
import { SchedulingReadError, SchedulingWriteError } from '../domain/scheduling.errors.js';

const OUTBOX_PRODUCER = 'scheduling-service';
const OPERATION = 'configureCampaignSession';

interface CampaignRow {
  readonly id: string;
  readonly agency: Agency;
  readonly public_code: string;
  readonly status: CampaignStatus;
  readonly target_districts: unknown;
  readonly examination_start_date: string;
  readonly examination_end_date: string;
}

interface CoverageHeadRow {
  readonly coverage_version: number;
  readonly coverage_hash: string;
}

interface SessionRow {
  readonly id: string;
  readonly district: string;
  readonly province: string;
  readonly venue_name: string;
  readonly exam_date: string;
  readonly reporting_time_hour: number;
  readonly capacity_limit: number | null;
  readonly registered_count: number;
  readonly is_active: boolean;
}

interface SessionCommandRow {
  readonly command_id: string;
  readonly request_hash: string;
  readonly campaign_id: string;
  readonly response_status: number;
  readonly response_body: unknown;
  readonly created_at: Date | string;
}

interface DbClock {
  readonly occurred_at: Date | string;
}

function requireOfficer(actor: Principal): Extract<Principal, { readonly kind: 'officer' }> {
  if (actor.kind !== 'officer') {
    throw new CampaignSessionCommandError(403, 'FORBIDDEN', 'Campaign session commands require an officer principal.');
  }
  return actor;
}

function toDate(value: Date | string): Date {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new SchedulingReadError('Database returned an invalid transaction timestamp.');
  return result;
}

function arrayOfStrings(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (cause) {
      throw new SchedulingReadError('Campaign target_districts is invalid JSON.', { cause });
    }
  }
  if (!Array.isArray(parsed)) {
    throw new SchedulingReadError('Campaign target_districts is not a string array.');
  }
  const strings: string[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== 'string') {
      throw new SchedulingReadError('Campaign target_districts is not a string array.');
    }
    strings.push(entry);
  }
  return strings;
}

function coverageSession(session: SessionRow | CampaignSessionInput): CampaignCoverageSessionValue {
  if ('venue_name' in session) {
    return {
      district: session.district,
      province: session.province,
      venueName: session.venue_name,
      examDate: session.exam_date,
      reportingTimeHour: session.reporting_time_hour,
      capacityLimit: session.capacity_limit,
      isActive: session.is_active,
    };
  }
  return {
    district: session.district,
    province: session.province,
    venueName: session.venueName,
    examDate: session.examDate,
    reportingTimeHour: session.reportingTimeHour,
    capacityLimit: session.capacityLimit,
    isActive: session.isActive,
  };
}

function sameConfiguration(row: SessionRow, input: CampaignSessionInput): boolean {
  return row.district === input.district &&
    row.province === input.province &&
    row.venue_name.normalize('NFC') === input.venueName &&
    row.exam_date === input.examDate &&
    row.reporting_time_hour === input.reportingTimeHour &&
    row.capacity_limit === input.capacityLimit &&
    row.is_active === input.isActive;
}

function responseObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchedulingReadError('Stored campaign session response is not a JSON object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function pgInfo(error: unknown): { readonly code?: string; readonly constraint?: string } {
  if (error === null || typeof error !== 'object') return {};
  const value = error as { readonly code?: unknown; readonly constraint?: unknown };
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.constraint === 'string' ? { constraint: value.constraint } : {}),
  };
}

function mapDatabaseError(error: unknown): Error {
  if (
    error instanceof CampaignSessionCommandError ||
    error instanceof CampaignSessionInputError ||
    error instanceof SchedulingReadError ||
    error instanceof SchedulingWriteError
  ) return error;
  const info = pgInfo(error);
  if (info.code === '23505' && info.constraint?.includes('venue_campaign_district')) {
    return new CampaignSessionCommandError(409, 'SESSION_CONFLICT', 'A session already exists for this district.');
  }
  if (info.code === '23514' || info.code === '23503') {
    return new CampaignSessionCommandError(409, 'SESSION_CONFLICT', 'The session command conflicts with a stored campaign invariant.');
  }
  return new SchedulingWriteError('Campaign session transaction failed.', { cause: error });
}

export class PgCampaignSessionRepository implements CampaignSessionRepository {
  async configure(
    command: CampaignSessionCommand,
    stage: StageCampaignSessionEvents,
  ): Promise<CampaignSessionCommit> {
    const actor = requireOfficer(command.actor);
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(dbRoleForPrincipal(actor))}`;

        const prior = await this.#findCommand(tx, command, actor.subjectId);
        if (prior !== null) return this.#replay(prior, command, actor.agency);

        // First row lock for every new session write: the campaign aggregate.
        const campaigns = await tx<CampaignRow[]>`
          SELECT id, agency, public_code, status, target_districts,
                 examination_start_date, examination_end_date
          FROM public_core.recruitment_campaigns
          WHERE public_code = ${command.session.publicCode}
            AND agency = ${actor.agency}::public_core.agency
          FOR UPDATE
        `;
        const campaign = campaigns[0];
        if (campaign === undefined) {
          throw new CampaignSessionCommandError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        }
        const priorAfterLock = await this.#findCommand(tx, command, actor.subjectId);
        if (priorAfterLock !== null) return this.#replay(priorAfterLock, command, actor.agency);

        if (campaign.status !== 'DRAFT') {
          throw new CampaignSessionCommandError(409, 'INVALID_STATE', 'Sessions can be configured only while the campaign is a draft.');
        }
        const targetDistricts = campaign.target_districts === null
          ? []
          : arrayOfStrings(campaign.target_districts);
        if (!targetDistricts.includes(command.session.district)) {
          throw new CampaignSessionCommandError(422, 'DISTRICT_NOT_TARGETED', 'Session district is not in the campaign target set.');
        }
        if (
          command.session.examDate < campaign.examination_start_date ||
          command.session.examDate > campaign.examination_end_date
        ) {
          throw new CampaignSessionCommandError(422, 'INVALID_SESSION_DATE', 'Session exam date is outside the campaign examination window.');
        }

        // Lock the head after the campaign row. If a migrated legacy campaign
        // has no head yet, seed version zero with the exact rows present, then
        // lock the row we just created. Campaign locking serializes this path.
        let headRows = await tx<CoverageHeadRow[]>`
          SELECT coverage_version, coverage_hash
          FROM public_core.campaign_coverage_heads
          WHERE campaign_id = ${campaign.id}::uuid AND agency = ${actor.agency}::public_core.agency
          FOR UPDATE
        `;
        if (headRows[0] === undefined) {
          const seedSessions = await this.#readSessions(tx, campaign.id);
          const seedHash = campaignCoverageHash(campaign.id, seedSessions.map(coverageSession));
          await tx`
            INSERT INTO public_core.campaign_coverage_heads
              (campaign_id, agency, coverage_version, coverage_hash, updated_at)
            VALUES (
              ${campaign.id}::uuid,
              ${actor.agency}::public_core.agency,
              0,
              ${seedHash},
              transaction_timestamp()
            )
          `;
          headRows = await tx<CoverageHeadRow[]>`
            SELECT coverage_version, coverage_hash
            FROM public_core.campaign_coverage_heads
            WHERE campaign_id = ${campaign.id}::uuid AND agency = ${actor.agency}::public_core.agency
            FOR UPDATE
          `;
        }
        const head = headRows[0];
        if (head === undefined) throw new SchedulingWriteError('Coverage head was not available after initialization.');

        const currentSessions = await this.#readSessions(tx, campaign.id);
        const actualCurrentHash = campaignCoverageHash(campaign.id, currentSessions.map(coverageSession));
        if (actualCurrentHash !== head.coverage_hash) {
          throw new CampaignSessionCommandError(409, 'STALE_COVERAGE', 'Coverage head does not match the current session set.');
        }
        const existing = currentSessions.find((session) => session.district === command.session.district);
        const changed = existing === undefined || !sameConfiguration(existing, command.session);
        if (existing !== undefined && changed && existing.registered_count > 0) {
          throw new CampaignSessionCommandError(409, 'SESSION_ALREADY_RESERVED', 'A session with registered applicants cannot be reconfigured.');
        }

        const projectedSessions = existing === undefined
          ? [...currentSessions.map(coverageSession), coverageSession(command.session)]
          : changed
            ? currentSessions.map((session) => session.district === command.session.district
                ? coverageSession(command.session)
                : coverageSession(session))
            : currentSessions.map(coverageSession);
        const expectedHash = campaignCoverageHash(campaign.id, projectedSessions);
        const nextVersion = changed ? head.coverage_version + 1 : head.coverage_version;
        const occurredAt = await this.#transactionTime(tx);
        const responseBody = {
          status: changed ? 'SESSION_CONFIGURED' : 'SESSION_UNCHANGED',
          publicCode: campaign.public_code,
          district: command.session.district,
          coverageVersion: nextVersion,
          coverageHash: expectedHash,
        };
        const claim = await this.#claimCommand(
          tx,
          command,
          actor.subjectId,
          actor.agency,
          campaign.id,
          responseBody,
        );
        if (claim.replay !== null) return claim.replay;

        if (existing === undefined) {
          await tx`
            INSERT INTO public_core.campaign_venue_assignments
              (id, campaign_id, district, province, venue_name, exam_date,
               reporting_time_hour, capacity_limit, registered_count, is_active, created_at)
            VALUES (
              ${randomUUID()}::uuid,
              ${campaign.id}::uuid,
              ${command.session.district},
              ${command.session.province},
              ${command.session.venueName},
              ${command.session.examDate},
              ${command.session.reportingTimeHour},
              ${command.session.capacityLimit},
              0,
              ${command.session.isActive},
              ${occurredAt}::timestamptz
            )
          `;
        } else if (changed) {
          await tx`
            UPDATE public_core.campaign_venue_assignments
            SET province = ${command.session.province},
                venue_name = ${command.session.venueName},
                exam_date = ${command.session.examDate},
                reporting_time_hour = ${command.session.reportingTimeHour},
                capacity_limit = ${command.session.capacityLimit},
                is_active = ${command.session.isActive}
            WHERE campaign_id = ${campaign.id}::uuid
              AND district = ${command.session.district}
          `;
        }

        const committedSessions = await this.#readSessions(tx, campaign.id);
        const committedHash = campaignCoverageHash(campaign.id, committedSessions.map(coverageSession));
        if (committedHash !== expectedHash) {
          throw new CampaignSessionCommandError(409, 'STALE_COVERAGE', 'Committed session rows do not match the requested coverage hash.');
        }
        if (changed) {
          await tx`
            UPDATE public_core.campaign_coverage_heads
            SET coverage_version = ${nextVersion},
                coverage_hash = ${committedHash},
                updated_at = ${occurredAt}::timestamptz
            WHERE campaign_id = ${campaign.id}::uuid
              AND agency = ${actor.agency}::public_core.agency
          `;
        }

        const commit: CampaignSessionCommit = {
          commandId: claim.commandId,
          campaignId: campaign.id,
          publicCode: campaign.public_code,
          agency: actor.agency,
          actorId: actor.subjectId,
          responseStatus: 200,
          responseBody,
          replayed: false,
          occurredAt: occurredAt.toISOString(),
          changed,
          coverageVersion: nextVersion,
        };
        await stageOutboxEvents(tx, stage(commit), OUTBOX_PRODUCER);
        return commit;
      });
    } catch (cause) {
      throw mapDatabaseError(cause);
    }
  }

  async #readSessions(tx: SqlTransaction, campaignId: string): Promise<SessionRow[]> {
    return tx<SessionRow[]>`
      SELECT id, district, province, venue_name, exam_date, reporting_time_hour,
             capacity_limit, registered_count, is_active
      FROM public_core.campaign_venue_assignments
      WHERE campaign_id = ${campaignId}::uuid
      ORDER BY district, exam_date, venue_name
    `;
  }

  async #transactionTime(tx: SqlTransaction): Promise<Date> {
    const rows = await tx<DbClock[]>`SELECT transaction_timestamp() AS occurred_at`;
    const row = rows[0];
    if (row === undefined) throw new SchedulingWriteError('Database did not return transaction time.');
    return toDate(row.occurred_at);
  }

  async #findCommand(
    tx: SqlTransaction,
    command: CampaignSessionCommand,
    actorId: string,
  ): Promise<SessionCommandRow | null> {
    const rows = await tx<SessionCommandRow[]>`
      SELECT command_id, request_hash, campaign_id, response_status, response_body, created_at
      FROM public_core.session_command_requests
      WHERE actor_id = ${actorId}::uuid
        AND operation = ${OPERATION}
        AND idempotency_key = ${command.idempotencyKey}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.request_hash !== command.requestHash) {
      throw new CampaignSessionCommandError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different session command.');
    }
    return row;
  }

  async #claimCommand(
    tx: SqlTransaction,
    command: CampaignSessionCommand,
    actorId: string,
    agency: Agency,
    campaignId: string,
    responseBody: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly commandId: string; readonly replay: CampaignSessionCommit | null }> {
    const commandId = randomUUID();
    const rows = await tx<{ command_id: string }[]>`
      INSERT INTO public_core.session_command_requests
        (command_id, campaign_id, agency, actor_id, operation, idempotency_key,
         request_hash, response_status, response_body)
      VALUES (
        ${commandId}::uuid,
        ${campaignId}::uuid,
        ${agency}::public_core.agency,
        ${actorId}::uuid,
        ${OPERATION},
        ${command.idempotencyKey}::uuid,
        ${command.requestHash},
        200,
        ${tx.json(asJsonb(responseBody))}
      )
      ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING
      RETURNING command_id
    `;
    if (rows[0] !== undefined) return { commandId, replay: null };
    const prior = await this.#findCommand(tx, command, actorId);
    if (prior === null) {
      throw new CampaignSessionCommandError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key is unavailable for this session command.');
    }
    return { commandId: prior.command_id, replay: this.#replay(prior, command, agency) };
  }

  #replay(
    row: SessionCommandRow,
    command: CampaignSessionCommand,
    agency: Agency,
  ): CampaignSessionCommit {
    const responseBody = responseObject(row.response_body);
    return {
      commandId: row.command_id,
      campaignId: row.campaign_id,
      publicCode: command.session.publicCode,
      agency,
      actorId: command.actor.subjectId,
      responseStatus: row.response_status,
      responseBody,
      replayed: true,
      occurredAt: toDate(row.created_at).toISOString(),
      changed: responseBody['status'] === 'SESSION_CONFIGURED',
      coverageVersion: typeof responseBody['coverageVersion'] === 'number'
        ? responseBody['coverageVersion']
        : 0,
    };
  }
}

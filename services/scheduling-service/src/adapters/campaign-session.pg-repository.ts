// BUILD-001 scheduling-service adapter for session configuration and coverage.
// The service may read campaign/session rows under its agency-scoped role, but
// the only mutation is the narrow SECURITY DEFINER command function. That
// function owns locking, persistence, durable replay, and outbox/audit staging.

import { randomUUID } from 'node:crypto';
import {
  asJsonb,
  sql,
  type SqlTransaction,
} from '@usrp/shared-database';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import {
  campaignCoverageHash,
  canonicalCampaignCoverageJson,
  type CampaignCoverageSessionValue,
} from '@usrp/shared-security';
import type {
  Agency,
  CampaignSessionInput,
  CampaignStatus,
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
  readonly capacity_decision_code: 'UNBOUNDED_CAPACITY' | null;
  readonly registered_count: number;
  readonly is_active: boolean;
}

interface FunctionReply {
  readonly replayed: boolean;
  readonly commandId: string;
  readonly resourceId: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
  readonly occurredAt: Date | string;
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
    row.capacity_decision_code === input.capacityDecisionCode &&
    row.is_active === input.isActive;
}

function responseObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchedulingReadError('Stored campaign session response is not a JSON object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function functionReply(value: unknown): FunctionReply {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchedulingReadError('Campaign session command function returned an invalid result.');
  }
  const reply = value as Record<string, unknown>;
  if (
    typeof reply['replayed'] !== 'boolean' ||
    typeof reply['commandId'] !== 'string' ||
    typeof reply['resourceId'] !== 'string' ||
    typeof reply['responseStatus'] !== 'number' ||
    !Number.isInteger(reply['responseStatus']) ||
    reply['responseBody'] === null ||
    (typeof reply['occurredAt'] !== 'string' && !(reply['occurredAt'] instanceof Date))
  ) {
    throw new SchedulingReadError('Campaign session command function returned an incomplete result.');
  }
  return reply as unknown as FunctionReply;
}

function pgInfo(error: unknown): {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
} {
  if (error === null || typeof error !== 'object') return {};
  const value = error as {
    readonly code?: unknown;
    readonly constraint?: unknown;
    readonly message?: unknown;
  };
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.constraint === 'string' ? { constraint: value.constraint } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
}

function commandError(code: string, message: string, status = 409): CampaignSessionCommandError {
  return new CampaignSessionCommandError(status, code, message);
}

function mapDatabaseError(error: unknown): Error {
  if (
    error instanceof CampaignSessionCommandError ||
    error instanceof CampaignSessionInputError ||
    error instanceof SchedulingReadError ||
    error instanceof SchedulingWriteError
  ) return error;
  const info = pgInfo(error);
  if (info.code === '42501') {
    return commandError('FORBIDDEN', 'An active agency administrator is required for this command.', 403);
  }
  if (info.code === 'P0001' && info.message !== undefined) {
    const match = /^([A-Z][A-Z0-9_]+)/.exec(info.message);
    const code = match?.[1];
    if (code !== undefined) {
      const status = code === 'CAMPAIGN_NOT_FOUND' ? 404
        : code === 'INVALID_SESSION_CONFIGURATION' ? 422
          : code === 'DISTRICT_NOT_TARGETED' ? 422
            : code === 'INVALID_SESSION_DATE' ? 422
              : 409;
      return commandError(code, info.message, status);
    }
  }
  if (info.code === '23505' && info.constraint?.includes('venue_campaign_district')) {
    return commandError('SESSION_CONFLICT', 'A session already exists for this district.');
  }
  if (info.code === '23514' || info.code === '23503') {
    return commandError('SESSION_CONFLICT', 'The session command conflicts with a stored campaign invariant.');
  }
  if (info.code === '22023') {
    return commandError('INVALID_SESSION_CONFIGURATION', 'The session command payload is invalid.', 422);
  }
  return new SchedulingWriteError('Campaign session transaction failed.', { cause: error });
}

function replayCommit(
  reply: FunctionReply,
  command: CampaignSessionCommand,
  agency: Agency,
): CampaignSessionCommit {
  const responseBody = responseObject(reply.responseBody);
  return {
    commandId: reply.commandId,
    campaignId: reply.resourceId,
    publicCode: typeof responseBody['publicCode'] === 'string'
      ? responseBody['publicCode']
      : command.session.publicCode,
    agency,
    actorId: command.actor.subjectId,
    responseStatus: reply.responseStatus,
    responseBody,
    replayed: true,
    occurredAt: toDate(reply.occurredAt).toISOString(),
    changed: responseBody['status'] === 'SESSION_CONFIGURED',
    // Replay never stages a second domain event. This value is informative only
    // to callers; StageCampaignSessionEvents is skipped for replayed commits.
    coverageChanged: false,
    coverageVersion: typeof responseBody['coverageVersion'] === 'number'
      ? responseBody['coverageVersion']
      : 0,
  };
}

function rowCoverage(row: SessionRow): CampaignCoverageSessionValue {
  return coverageSession(row);
}

function validateHash(hash: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new CampaignSessionCommandError(500, 'INVALID_COVERAGE_HASH', `${label} is not a lowercase SHA-256 digest.`);
  }
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

        const prior = await this.#readReplay(tx, command, actor.subjectId, actor.agency);
        if (prior !== null) return replayCommit(prior, command, actor.agency);

        // The database command boundary exposes a narrow lock/read function.
        // It serializes session changes and publication on the campaign row.
        const campaign = await this.#lockCampaign(tx, actor.subjectId, actor.agency, command.session.publicCode);
        if (campaign === null) {
          throw new CampaignSessionCommandError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        }

        // Check replay again after a campaign-row lock wait, before evaluating
        // mutable state. Same-key concurrent requests return the original body.
        const priorAfterLock = await this.#readReplay(tx, command, actor.subjectId, actor.agency);
        if (priorAfterLock !== null) return replayCommit(priorAfterLock, command, actor.agency);

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

        // Lock coverage only after the campaign row. A missing head is an
        // existing legacy state: it is represented as version zero and seeded
        // by the command function without changing the legacy reservation count.
        const head = await this.#lockCoverageHead(tx, actor.subjectId, actor.agency, campaign.id);
        const currentSessions = await this.#readSessions(tx, campaign.id);
        const currentCoverageValues = currentSessions.map(rowCoverage);
        const currentCoverageCanonicalJson = canonicalCampaignCoverageJson(campaign.id, currentCoverageValues);
        const currentCoverageHash = campaignCoverageHash(campaign.id, currentCoverageValues);
        validateHash(currentCoverageHash, 'currentCoverageHash');
        const currentCoverageVersion = head?.coverage_version ?? 0;
        if (head !== undefined && head.coverage_hash !== currentCoverageHash) {
          throw new CampaignSessionCommandError(409, 'STALE_COVERAGE', 'Coverage head does not match the current session set.');
        }

        const existing = currentSessions.find((session) => session.district === command.session.district);
        const changed = existing === undefined || !sameConfiguration(existing, command.session);
        const coverageChanged = existing === undefined || !sameCoverageConfiguration(existing, command.session);
        if (existing !== undefined && changed && existing.registered_count > 0) {
          throw new CampaignSessionCommandError(409, 'SESSION_ALREADY_RESERVED', 'A session with registered applicants cannot be reconfigured.');
        }

        const projectedSessions = existing === undefined
          ? [...currentCoverageValues, rowCoverageFromInput(command.session)]
          : coverageChanged
            ? currentSessions.map((session) => session.district === command.session.district
                ? rowCoverageFromInput(command.session)
                : rowCoverage(session))
            : currentCoverageValues;
        const coverageCanonicalJson = canonicalCampaignCoverageJson(campaign.id, projectedSessions);
        const coverageHash = campaignCoverageHash(campaign.id, projectedSessions);
        validateHash(coverageHash, 'coverageHash');
        const coverageVersion = currentCoverageVersion + (coverageChanged ? 1 : 0);
        const occurredAt = await this.#transactionTime(tx);
        const responseBody = {
          status: changed ? 'SESSION_CONFIGURED' : 'SESSION_UNCHANGED',
          publicCode: campaign.public_code,
          district: command.session.district,
          coverageVersion,
          coverageHash,
          capacityDecisionCode: command.session.capacityDecisionCode,
        };
        const commandId = randomUUID();
        const commit: CampaignSessionCommit = {
          commandId,
          campaignId: campaign.id,
          publicCode: campaign.public_code,
          agency: actor.agency,
          actorId: actor.subjectId,
          responseStatus: 200,
          responseBody,
          replayed: false,
          occurredAt: occurredAt.toISOString(),
          changed,
          coverageChanged,
          coverageVersion,
        };
        const events = stage(commit);
        const reply = await this.#callWriteFunction(tx, {
          actorId: actor.subjectId,
          agency: actor.agency,
          operation: OPERATION,
          commandId,
          campaignId: campaign.id,
          publicCode: campaign.public_code,
          sessionId: randomUUID(),
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          currentCoverageCanonicalJson,
          currentCoverageHash,
          currentCoverageVersion,
          coverageCanonicalJson,
          coverageHash,
          correlationId: command.correlationId,
          occurredAt: commit.occurredAt,
          responseBody,
          session: {
            ...command.session,
            capacityDecisionCode: command.session.capacityDecisionCode,
          },
          events,
        });
        if (reply.replayed) return replayCommit(reply, command, actor.agency);
        if (
          reply.commandId !== commit.commandId ||
          reply.resourceId !== commit.campaignId ||
          reply.responseStatus !== commit.responseStatus
        ) {
          throw new SchedulingReadError('Campaign session command result does not match its staged command.');
        }
        return commit;
      });
    } catch (cause) {
      throw mapDatabaseError(cause);
    }
  }

  async #readReplay(
    tx: SqlTransaction,
    command: CampaignSessionCommand,
    actorId: string,
    agency: Agency,
  ): Promise<FunctionReply | null> {
    const rows = await tx<{ readonly replay: unknown }[]>`
      SELECT public_core.campaign_read_session_command_replay(
        ${actorId}::uuid,
        ${agency}::public_core.agency,
        ${OPERATION},
        ${command.idempotencyKey}::uuid,
        ${command.requestHash}
      ) AS replay
    `;
    const value = rows[0]?.replay;
    return value === null || value === undefined ? null : functionReply(value);
  }

  async #lockCampaign(
    tx: SqlTransaction,
    actorId: string,
    agency: Agency,
    publicCode: string,
  ): Promise<CampaignRow | null> {
    const rows = await tx<CampaignRow[]>`
      SELECT id, agency, public_code, status, target_districts,
             examination_start_date, examination_end_date
      FROM public_core.campaign_lock_for_command(
        ${actorId}::uuid,
        ${agency}::public_core.agency,
        ${publicCode}
      )
    `;
    return rows[0] ?? null;
  }

  async #lockCoverageHead(
    tx: SqlTransaction,
    actorId: string,
    agency: Agency,
    campaignId: string,
  ): Promise<CoverageHeadRow | undefined> {
    const rows = await tx<CoverageHeadRow[]>`
      SELECT coverage_version, coverage_hash
      FROM public_core.campaign_lock_coverage_head(
        ${actorId}::uuid,
        ${agency}::public_core.agency,
        ${campaignId}::uuid
      )
    `;
    return rows[0];
  }

  async #readSessions(tx: SqlTransaction, campaignId: string): Promise<SessionRow[]> {
    return await tx<SessionRow[]>`
      SELECT id, district, province, venue_name, exam_date, reporting_time_hour,
             capacity_limit, capacity_decision_code, registered_count, is_active
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

  async #callWriteFunction(
    tx: SqlTransaction,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<FunctionReply> {
    const rows = await tx<{ readonly result: unknown }[]>`
      SELECT public_core.scheduling_configure_campaign_session(
        ${tx.json(asJsonb(payload))}
      ) AS result
    `;
    return functionReply(rows[0]?.result);
  }
}

function rowCoverageFromInput(session: CampaignSessionInput): CampaignCoverageSessionValue {
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

function sameCoverageConfiguration(row: SessionRow, input: CampaignSessionInput): boolean {
  const oldValue = coverageSession(row);
  const newValue = rowCoverageFromInput(input);
  return oldValue.district === newValue.district &&
    oldValue.province === newValue.province &&
    oldValue.venueName.normalize('NFC') === newValue.venueName &&
    oldValue.examDate === newValue.examDate &&
    oldValue.reportingTimeHour === newValue.reportingTimeHour &&
    oldValue.capacityLimit === newValue.capacityLimit &&
    oldValue.isActive === newValue.isActive;
}

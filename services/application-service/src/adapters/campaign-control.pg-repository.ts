// BUILD-001 PostgreSQL adapter for the application-service-owned campaign
// aggregate. Reads stay agency-scoped; every mutation is delegated to one
// narrow database command function that authorizes, locks, persists the
// idempotency response, and stages its domain + AUDIT_ENTRY outbox rows.

import { randomUUID } from 'node:crypto';
import {
  asJsonb,
  sql,
  type SqlTransaction,
} from '@usrp/shared-database';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import {
  campaignCoverageHash,
  campaignFactUuid,
  canonicalCampaignCoverageJson,
} from '@usrp/shared-security';
import {
  DISTRICT_TO_PROVINCE,
  type Agency,
  type ApplicationCategory,
  type CampaignStatus,
  type CampaignPolicyInput,
  type CampaignCategoryPolicy,
  type District,
} from '@usrp/shared-types';
import type {
  CampaignCommit,
  CampaignContext,
  CampaignControlCommand,
  CampaignControlRepository,
  CampaignFact,
  StageCampaignEvents,
} from '../ports/campaign-control.repository.js';
import {
  CAMPAIGN_POLICY_HASH_VERSION,
  canonicalCampaignPolicy,
  hashCampaignPolicy,
} from '../domain/campaign-policy.js';
import {
  CampaignCommandError,
  CampaignPersistenceError,
  CampaignReadError,
} from '../domain/campaign-control.errors.js';

const CAMPAIGN_EVENT_NAMESPACE = 'c6c2ef80-2ef0-4eeb-b6a4-4f93d5a4ac11';
const OPERATION_NAME: Readonly<Record<CampaignControlCommand['operation'], string>> = {
  CREATE_DRAFT: 'createCampaignDraft',
  CREATE_POLICY_VERSION: 'createCampaignPolicyVersion',
  PUBLISH: 'publishCampaign',
  CLOSE_REGISTRATION: 'closeCampaignRegistration',
  COMPLETE: 'completeCampaign',
  CANCEL: 'cancelCampaign',
};

interface CampaignRow {
  readonly id: string;
  readonly public_code: string;
  readonly agency: Agency;
  readonly status: CampaignStatus;
  readonly target_categories: string;
  readonly target_districts: unknown;
  readonly examination_start_date: string;
  readonly examination_end_date: string;
  readonly current_policy_version_id: string | null;
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

interface CoverageHeadRow {
  readonly coverage_version: number;
  readonly coverage_hash: string;
}

interface SessionRow {
  readonly district: string;
  readonly province: string;
  readonly venue_name: string;
  readonly exam_date: string;
  readonly reporting_time_hour: number;
  readonly capacity_limit: number | null;
  readonly capacity_decision_code: string | null;
  readonly registered_count: number;
  readonly is_active: boolean;
}

interface PolicyVersionRow {
  readonly id: string;
  readonly version_number: number;
  readonly policy_document: unknown;
  readonly canonical_policy_json: string | null;
  readonly policy_hash: string;
  readonly hash_version: number;
  readonly legal_basis_code: string;
  readonly legal_basis_reference: string;
}

function isOfficer(actor: Principal): actor is Extract<Principal, { readonly kind: 'officer' }> {
  return actor.kind === 'officer';
}

function parseStringArray(value: unknown, field: string): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (cause) {
      throw new CampaignReadError(`Campaign ${field} is not valid JSON.`, { cause });
    }
  }
  if (!Array.isArray(parsed)) {
    throw new CampaignReadError(`Campaign ${field} is not a string array.`);
  }
  const strings: string[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== 'string') {
      throw new CampaignReadError(`Campaign ${field} is not a string array.`);
    }
    strings.push(entry);
  }
  return strings;
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new CampaignReadError('Database returned an invalid campaign timestamp.');
  return date;
}

function asIso(value: Date | string): string {
  return asDate(value).toISOString();
}

function actorFields(actor: Principal): { readonly actorId: string; readonly agency: Agency } {
  if (!isOfficer(actor)) {
    throw new CampaignCommandError(403, 'FORBIDDEN', 'Campaign commands require an officer principal.');
  }
  return { actorId: actor.subjectId, agency: actor.agency };
}

function commandError(code: string, message: string, status = 409): CampaignCommandError {
  return new CampaignCommandError(status, code, message);
}

function cancellableStatus(status: CampaignStatus): 'DRAFT' | 'REGISTRATION_OPEN' {
  if (status === 'DRAFT' || status === 'REGISTRATION_OPEN') return status;
  throw commandError('INVALID_STATE', 'Only draft or open campaigns can be cancelled.');
}

function validateHash(hash: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw commandError('INVALID_HASH', `${label} is not a lowercase SHA-256 digest.`, 500);
  }
}

function publicCodeFromBody(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).publicCode;
    if (typeof code === 'string') return code;
  }
  return fallback;
}

function responseObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CampaignReadError('Stored campaign command response is not a JSON object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function functionReply(value: unknown): FunctionReply {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CampaignReadError('Campaign command function returned an invalid result.');
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
    throw new CampaignReadError('Campaign command function returned an incomplete result.');
  }
  return reply as unknown as FunctionReply;
}

function rowToContext(row: CampaignRow): CampaignContext {
  return {
    campaignId: row.id,
    publicCode: row.public_code,
    agency: row.agency,
    status: row.status,
    targetCategories: parseStringArray(row.target_categories, 'target_categories') as ApplicationCategory[],
    targetDistricts: row.target_districts === null
      ? null
      : parseStringArray(row.target_districts, 'target_districts'),
    examinationStartDate: row.examination_start_date,
    examinationEndDate: row.examination_end_date,
    currentPolicyVersionId: row.current_policy_version_id,
  };
}

function replayCommit(
  reply: FunctionReply,
  command: CampaignControlCommand,
  actorId: string,
  agency: Agency,
): CampaignCommit {
  const responseBody = responseObject(reply.responseBody);
  return {
    operation: command.operation,
    commandId: reply.commandId,
    campaignId: reply.resourceId,
    publicCode: publicCodeFromBody(responseBody, command.operation === 'CREATE_DRAFT'
      ? command.draft.publicCode
      : command.operation === 'CREATE_POLICY_VERSION'
        ? command.policy.publicCode
        : command.publicCode),
    agency,
    actorId,
    responseStatus: reply.responseStatus,
    responseBody,
    replayed: true,
    occurredAt: asIso(reply.occurredAt),
    fact: null,
    auditAction: 'CAMPAIGN_COMMAND_REPLAYED',
    auditMetadata: {},
  };
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

function mapPersistenceError(error: unknown): Error {
  if (error instanceof CampaignCommandError || error instanceof CampaignReadError) return error;
  const pg = pgInfo(error);
  if (pg.code === '42501') {
    return commandError('FORBIDDEN', 'An active agency administrator is required for this command.', 403);
  }
  if (pg.code === 'P0001' && pg.message !== undefined) {
    const match = /^([A-Z][A-Z0-9_]+)/.exec(pg.message);
    const code = match?.[1];
    if (code !== undefined) {
      const status = code === 'CAMPAIGN_NOT_FOUND' ? 404
        : code === 'INVALID_SESSION_CONFIGURATION' ? 422
          : code === 'POLICY_CATEGORY_COVERAGE_MISMATCH' ? 422
            : 409;
      return commandError(code, pg.message, status);
    }
  }
  if (pg.code === '23505') {
    if (pg.constraint?.includes('public_code')) {
      return commandError('PUBLIC_CODE_ALREADY_EXISTS', 'A campaign with this publicCode already exists.');
    }
    if (pg.constraint?.includes('campaign_label')) {
      return commandError('CAMPAIGN_LABEL_ALREADY_EXISTS', 'A campaign with this label already exists.');
    }
    if (pg.constraint?.includes('policy')) {
      return commandError('POLICY_VERSION_CONFLICT', 'The policy version changed concurrently.');
    }
  }
  if (pg.code === '23514' || pg.code === '23503') {
    return commandError('CAMPAIGN_WRITE_CONFLICT', 'The campaign command conflicts with a stored invariant.');
  }
  return new CampaignPersistenceError('Campaign command transaction failed.', { cause: error });
}

function rowCoverage(row: SessionRow): {
  readonly district: string;
  readonly province: string;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  readonly capacityLimit: number | null;
  readonly isActive: boolean;
} {
  return {
    district: row.district,
    province: row.province,
    venueName: row.venue_name,
    examDate: row.exam_date,
    reportingTimeHour: row.reporting_time_hour,
    capacityLimit: row.capacity_limit,
    isActive: row.is_active,
  };
}

export class PgCampaignControlRepository implements CampaignControlRepository {
  async findCampaignContext(actor: Principal, publicCode: string): Promise<CampaignContext | null> {
    const { agency } = actorFields(actor);
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(dbRoleForPrincipal(actor))}`;
        const rows = await tx<CampaignRow[]>`
          SELECT id, public_code, agency, status, target_categories, target_districts,
                 examination_start_date, examination_end_date, current_policy_version_id
          FROM public_core.recruitment_campaigns
          WHERE public_code = ${publicCode} AND agency = ${agency}::public_core.agency
          LIMIT 1
        `;
        const row = rows[0];
        return row === undefined ? null : rowToContext(row);
      });
    } catch (cause) {
      if (cause instanceof CampaignReadError) throw cause;
      throw new CampaignReadError('Could not resolve campaign context.', { cause });
    }
  }

  async execute(command: CampaignControlCommand, stage: StageCampaignEvents): Promise<CampaignCommit> {
    const { actorId, agency } = actorFields(command.actor);
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(dbRoleForPrincipal(command.actor))}`;
        await tx`SELECT set_config('usrp.campaign_actor_id', ${actorId}, true)`;

        const operation = OPERATION_NAME[command.operation];
        const replay = await this.#readReplay(tx, command, actorId, agency, operation);
        if (replay !== null) return replayCommit(replay, command, actorId, agency);

        if (command.operation === 'CREATE_DRAFT') {
          return await this.#createDraft(tx, command, actorId, agency, stage);
        }

        const publicCode = command.operation === 'CREATE_POLICY_VERSION'
          ? command.policy.publicCode
          : command.publicCode;
        const campaign = await this.#lockCampaign(tx, actorId, agency, publicCode);
        if (campaign === null) {
          throw commandError('CAMPAIGN_NOT_FOUND', 'Campaign was not found.', 404);
        }

        // Re-read the durable key after waiting on the aggregate lock. A
        // duplicate that raced the first read must replay before state checks.
        const replayAfterLock = await this.#readReplay(tx, command, actorId, agency, operation);
        if (replayAfterLock !== null) return replayCommit(replayAfterLock, command, actorId, agency);

        switch (command.operation) {
          case 'CREATE_POLICY_VERSION':
            return await this.#createPolicyVersion(tx, command, campaign, actorId, agency, stage);
          case 'PUBLISH':
            return await this.#publish(tx, command, campaign, actorId, agency, stage);
          case 'CLOSE_REGISTRATION':
            return await this.#lifecycle(tx, command, campaign, actorId, agency, stage);
          case 'COMPLETE':
            return await this.#lifecycle(tx, command, campaign, actorId, agency, stage);
          case 'CANCEL':
            return await this.#lifecycle(tx, command, campaign, actorId, agency, stage);
          default: {
            const unreachable: never = command;
            throw new Error(`Unhandled campaign command ${JSON.stringify(unreachable)}`);
          }
        }
      });
    } catch (cause) {
      throw mapPersistenceError(cause);
    }
  }

  async #readReplay(
    tx: SqlTransaction,
    command: CampaignControlCommand,
    actorId: string,
    agency: Agency,
    operation: string,
  ): Promise<FunctionReply | null> {
    const rows = await tx<{ readonly replay: unknown }[]>`
      SELECT public_core.campaign_read_command_replay(
        ${actorId}::uuid,
        ${agency}::public_core.agency,
        ${operation},
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
      SELECT id, public_code, agency, status, target_categories, target_districts,
             examination_start_date, examination_end_date, current_policy_version_id
      FROM public_core.campaign_lock_for_command(
        ${actorId}::uuid,
        ${agency}::public_core.agency,
        ${publicCode}
      )
    `;
    const row = rows[0];
    if (row !== undefined && row.agency !== agency) {
      throw commandError('CAMPAIGN_NOT_FOUND', 'Campaign was not found.', 404);
    }
    return row ?? null;
  }

  async #coverageHead(
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

  async #sessions(tx: SqlTransaction, campaignId: string): Promise<SessionRow[]> {
    return await tx<SessionRow[]>`
      SELECT district, province, venue_name, exam_date, reporting_time_hour,
             capacity_limit, capacity_decision_code, registered_count, is_active
      FROM public_core.campaign_venue_assignments
      WHERE campaign_id = ${campaignId}::uuid
      ORDER BY district, exam_date, venue_name
    `;
  }

  async #transactionTime(tx: SqlTransaction): Promise<Date> {
    const rows = await tx<DbClock[]>`SELECT transaction_timestamp() AS occurred_at`;
    const row = rows[0];
    if (row === undefined) throw new CampaignPersistenceError('Database did not return transaction time.');
    return asDate(row.occurred_at);
  }

  async #callWriteFunction(
    tx: SqlTransaction,
    command: CampaignControlCommand,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<FunctionReply> {
    const json = tx.json(asJsonb(payload));
    let rows: { readonly result: unknown }[];
    switch (command.operation) {
      case 'CREATE_DRAFT':
        rows = await tx<{ readonly result: unknown }[]>`
          SELECT public_core.campaign_write_draft(${json}) AS result
        `;
        break;
      case 'CREATE_POLICY_VERSION':
        rows = await tx<{ readonly result: unknown }[]>`
          SELECT public_core.campaign_write_policy_version(${json}) AS result
        `;
        break;
      case 'PUBLISH':
        rows = await tx<{ readonly result: unknown }[]>`
          SELECT public_core.campaign_write_publication(${json}) AS result
        `;
        break;
      case 'CLOSE_REGISTRATION':
        rows = await tx<{ readonly result: unknown }[]>`
          SELECT public_core.campaign_close_registration(${json}) AS result
        `;
        break;
      case 'COMPLETE':
        rows = await tx<{ readonly result: unknown }[]>`
          SELECT public_core.campaign_complete(${json}) AS result
        `;
        break;
      case 'CANCEL':
        rows = await tx<{ readonly result: unknown }[]>`
          SELECT public_core.campaign_cancel(${json}) AS result
        `;
        break;
      default: {
        const unreachable: never = command;
        throw new Error(`Unhandled campaign command ${JSON.stringify(unreachable)}`);
      }
    }
    return functionReply(rows[0]?.result);
  }

  #verifyFunctionResult(
    reply: FunctionReply,
    commit: CampaignCommit,
    command: CampaignControlCommand,
  ): CampaignCommit {
    // Draft creation has no aggregate row to lock first. The database function
    // may therefore discover a concurrent duplicate only after acquiring the
    // advisory idempotency lock; return the exact stored response in that case.
    if (reply.replayed) return replayCommit(reply, command, commit.actorId, commit.agency);
    if (
      reply.commandId !== commit.commandId ||
      reply.resourceId !== commit.campaignId ||
      reply.responseStatus !== commit.responseStatus
    ) {
      throw new CampaignReadError('Campaign command function result does not match its staged command.');
    }
    return commit;
  }

  async #createDraft(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'CREATE_DRAFT' }>,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    const campaignId = randomUUID();
    const commandId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: 'DRAFT_CREATED',
      publicCode: command.draft.publicCode,
      campaignStatus: 'DRAFT',
    };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId,
      campaignId,
      publicCode: command.draft.publicCode,
      agency,
      actorId,
      responseStatus: 201,
      responseBody,
      replayed: false,
      occurredAt: occurredAt.toISOString(),
      fact: { kind: 'DRAFT_CREATED', occurredAt: occurredAt.toISOString() },
      auditAction: 'CAMPAIGN_DRAFT_CREATED',
      auditMetadata: {},
    };
    const events = stage(commit);
    const reply = await this.#callWriteFunction(tx, command, {
      actorId,
      agency,
      operation: OPERATION_NAME[command.operation],
      commandId,
      campaignId,
      publicCode: command.draft.publicCode,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      draft: command.draft,
      correlationId: command.context.correlationId,
      occurredAt: commit.occurredAt,
      responseStatus: commit.responseStatus,
      responseBody,
      events,
    });
    return this.#verifyFunctionResult(reply, commit, command);
  }

  async #createPolicyVersion(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'CREATE_POLICY_VERSION' }>,
    campaign: CampaignRow,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    if (campaign.status !== 'DRAFT') {
      throw commandError('INVALID_STATE', 'A policy version can be created only while the campaign is a draft.');
    }
    const categories = parseStringArray(campaign.target_categories, 'target_categories').sort();
    const policyCategories = Object.keys(command.policy.policyDocument).sort();
    if (categories.length !== policyCategories.length || categories.some((category, index) => category !== policyCategories[index])) {
      throw commandError('POLICY_CATEGORY_COVERAGE_MISMATCH', 'Policy document must cover every target category exactly once.', 422);
    }

    const current = await tx<{ readonly next_version: number }[]>`
      SELECT COALESCE(max(version_number), 0) + 1 AS next_version
      FROM public_core.campaign_policy_versions
      WHERE campaign_id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
    `;
    const versionNumber = current[0]?.next_version ?? 1;
    const policyVersionId = randomUUID();
    const commandId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const canonicalPolicyJson = canonicalCampaignPolicy(command.policy);
    const policyHash = hashCampaignPolicy(command.policy);
    validateHash(policyHash, 'policyHash');
    const responseBody = {
      status: 'POLICY_VERSION_CREATED',
      publicCode: campaign.public_code,
      policyVersion: versionNumber,
      policyHash,
    };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      agency,
      actorId,
      responseStatus: 201,
      responseBody,
      replayed: false,
      occurredAt: occurredAt.toISOString(),
      fact: {
        kind: 'POLICY_VERSION_CREATED',
        policyVersionId,
        policyVersionNumber: versionNumber,
        occurredAt: occurredAt.toISOString(),
      },
      auditAction: 'CAMPAIGN_POLICY_VERSION_CREATED',
      auditMetadata: { policyVersionNumber: versionNumber },
    };
    const events = stage(commit);
    const reply = await this.#callWriteFunction(tx, command, {
      actorId,
      agency,
      operation: OPERATION_NAME[command.operation],
      commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      policyVersionId,
      policyVersionNumber: versionNumber,
      policyHash,
      canonicalPolicyJson,
      policy: command.policy,
      correlationId: command.context.correlationId,
      occurredAt: commit.occurredAt,
      responseStatus: commit.responseStatus,
      responseBody,
      events,
    });
    return this.#verifyFunctionResult(reply, commit, command);
  }

  async #publish(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'PUBLISH' }>,
    campaign: CampaignRow,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    if (campaign.status !== 'DRAFT') {
      throw commandError('INVALID_STATE', 'Only a draft campaign can be published.');
    }
    if (campaign.current_policy_version_id === null) {
      throw commandError('POLICY_NOT_SET', 'A validated policy version is required before publication.');
    }

    const head = await this.#coverageHead(tx, actorId, agency, campaign.id);
    if (head === undefined) {
      throw commandError('INCOMPLETE_COVERAGE', 'Every target district needs an active configured session.');
    }
    const sessions = await this.#sessions(tx, campaign.id);
    const targetDistricts = campaign.target_districts === null
      ? []
      : parseStringArray(campaign.target_districts, 'target_districts');
    this.#assertCompleteCoverage(campaign, targetDistricts, sessions, head);
    const coverageValues = sessions.map(rowCoverage);
    const coverageHash = campaignCoverageHash(campaign.id, coverageValues);
    const coverageCanonicalJson = canonicalCampaignCoverageJson(campaign.id, coverageValues);

    const policyRows = await tx<PolicyVersionRow[]>`
      SELECT id, version_number, policy_document, canonical_policy_json, policy_hash,
             hash_version, legal_basis_code, legal_basis_reference
      FROM public_core.campaign_policy_versions
      WHERE id = ${campaign.current_policy_version_id}::uuid
        AND campaign_id = ${campaign.id}::uuid
        AND agency = ${agency}::public_core.agency
      LIMIT 1
    `;
    const policy = policyRows[0];
    if (policy === undefined || policy.hash_version !== CAMPAIGN_POLICY_HASH_VERSION) {
      throw commandError('POLICY_NOT_SET', 'The selected policy version is unavailable or unsupported.');
    }
    if (policy.policy_document === null || typeof policy.policy_document !== 'object' || Array.isArray(policy.policy_document)) {
      throw commandError('POLICY_HASH_MISMATCH', 'The stored policy document is invalid.');
    }
    const storedPolicy: CampaignPolicyInput = {
      publicCode: campaign.public_code,
      policyDocument: policy.policy_document as Readonly<Record<string, CampaignCategoryPolicy>>,
      legalBasisCode: policy.legal_basis_code,
      legalBasisReference: policy.legal_basis_reference,
    };
    const canonicalPolicyJson = canonicalCampaignPolicy(storedPolicy);
    const policyHash = hashCampaignPolicy(storedPolicy);
    if (policyHash !== policy.policy_hash || policy.canonical_policy_json !== canonicalPolicyJson) {
      throw commandError('POLICY_HASH_MISMATCH', 'The stored policy digest or canonical serialization does not match its immutable document.');
    }

    const publicationId = randomUUID();
    const publicationEventId = campaignFactUuid(
      CAMPAIGN_EVENT_NAMESPACE,
      `campaign-published:${publicationId}`,
    );
    const historyId = randomUUID();
    const commandId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: 'CAMPAIGN_PUBLISHED',
      publicCode: campaign.public_code,
      campaignStatus: 'REGISTRATION_OPEN',
      policyVersion: policy.version_number,
      coverageVersion: head.coverage_version,
      coverageHash,
    };
    const fact: CampaignFact = {
      kind: 'PUBLISHED',
      publicationId,
      publicationEventId,
      policyVersionId: policy.id,
      policyVersionNumber: policy.version_number,
      coverageVersion: head.coverage_version,
      coverageHash,
      occurredAt: occurredAt.toISOString(),
    };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      agency,
      actorId,
      responseStatus: 200,
      responseBody,
      replayed: false,
      occurredAt: occurredAt.toISOString(),
      fact,
      auditAction: 'CAMPAIGN_PUBLISHED',
      auditMetadata: {
        publicationId,
        policyVersionNumber: policy.version_number,
        coverageVersion: head.coverage_version,
      },
    };
    const events = stage(commit);
    const reply = await this.#callWriteFunction(tx, command, {
      actorId,
      agency,
      operation: OPERATION_NAME[command.operation],
      commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      publicationId,
      publicationEventId,
      historyId,
      coverageCanonicalJson,
      coverageVersion: head.coverage_version,
      coverageHash,
      correlationId: command.context.correlationId,
      occurredAt: commit.occurredAt,
      responseStatus: commit.responseStatus,
      responseBody,
      events,
    });
    return this.#verifyFunctionResult(reply, commit, command);
  }

  #assertCompleteCoverage(
    campaign: CampaignRow,
    targetDistricts: readonly string[],
    sessions: readonly SessionRow[],
    head: CoverageHeadRow,
  ): void {
    if (targetDistricts.length === 0) {
      throw commandError('INCOMPLETE_COVERAGE', 'Every target district needs an active configured session.');
    }
    const expected = new Set(targetDistricts);
    const actual = new Set(sessions.map((session) => session.district));
    if (
      expected.size !== targetDistricts.length ||
      actual.size !== sessions.length ||
      expected.size !== actual.size ||
      [...expected].some((district) => !actual.has(district)) ||
      sessions.some((session) => !expected.has(session.district))
    ) {
      throw commandError('INCOMPLETE_COVERAGE', 'Session coverage must contain exactly one row for every target district.');
    }
    if (sessions.some((session) => !session.is_active)) {
      throw commandError('INCOMPLETE_COVERAGE', 'Every target district session must be active at publication.');
    }
    for (const session of sessions) {
      if (session.capacity_limit === null && session.capacity_decision_code !== 'UNBOUNDED_CAPACITY') {
        throw commandError('CAPACITY_DECISION_REQUIRED', 'Every new unbounded session needs an explicit audited UNBOUNDED_CAPACITY decision.', 409);
      }
      if (session.capacity_limit !== null && (session.capacity_limit <= 0 || session.capacity_decision_code !== null)) {
        throw commandError('INVALID_CAPACITY', 'Session capacity must be positive and cannot carry an unbounded-capacity decision.');
      }
      if (session.registered_count !== 0) {
        throw commandError('SESSION_ALREADY_RESERVED', 'A campaign cannot publish with session seats already reserved.');
      }
      if (
        session.exam_date < campaign.examination_start_date ||
        session.exam_date > campaign.examination_end_date
      ) {
        throw commandError('INVALID_SESSION_DATE', 'Session date falls outside the campaign examination window.', 422);
      }
      const expectedProvince = DISTRICT_TO_PROVINCE[session.district as District];
      if (expectedProvince !== session.province) {
        throw commandError('DISTRICT_PROVINCE_MISMATCH', 'Stored session district and province do not match.', 422);
      }
      if (session.reporting_time_hour < 0 || session.reporting_time_hour > 23) {
        throw commandError('INVALID_REPORTING_HOUR', 'Session reporting hour must be between 0 and 23.', 422);
      }
    }
    const observedHash = campaignCoverageHash(
      campaign.id,
      sessions.map(rowCoverage),
    );
    validateHash(head.coverage_hash, 'coverageHash');
    if (head.coverage_version < 1 || observedHash !== head.coverage_hash) {
      throw commandError('STALE_COVERAGE', 'Coverage head does not match the current session set.');
    }
  }

  async #lifecycle(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'CLOSE_REGISTRATION' | 'COMPLETE' | 'CANCEL' }>,
    campaign: CampaignRow,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    const lifecycle = command.operation === 'CLOSE_REGISTRATION'
      ? {
          from: 'REGISTRATION_OPEN' as const,
          to: 'REGISTRATION_CLOSED' as const,
          responseStatus: 200,
          responseState: 'REGISTRATION_CLOSED',
          auditAction: 'CAMPAIGN_REGISTRATION_CLOSED',
          factKind: 'REGISTRATION_CLOSED' as const,
        }
      : command.operation === 'COMPLETE'
        ? {
            from: 'REGISTRATION_CLOSED' as const,
            to: 'COMPLETED' as const,
            responseStatus: 200,
            responseState: 'COMPLETED',
            auditAction: 'CAMPAIGN_COMPLETED',
            factKind: 'COMPLETED' as const,
          }
        : {
            from: null,
            to: 'CANCELLED' as const,
            responseStatus: 200,
            responseState: 'CANCELLED',
            auditAction: 'CAMPAIGN_CANCELLED',
            factKind: 'CANCELLED' as const,
          };
    if (command.operation === 'CANCEL') {
      if (campaign.status !== 'DRAFT' && campaign.status !== 'REGISTRATION_OPEN') {
        throw commandError('INVALID_STATE', 'Only draft or open campaigns can be cancelled.');
      }
    } else if (campaign.status !== lifecycle.from) {
      throw commandError('INVALID_STATE', command.operation === 'CLOSE_REGISTRATION'
        ? 'Only an open campaign can close registration.'
        : 'Only a registration-closed campaign can be completed.');
    }

    const fromStatus = campaign.status;
    const cancelFromStatus = command.operation === 'CANCEL'
      ? cancellableStatus(fromStatus)
      : null;
    const historyId = randomUUID();
    const commandId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: lifecycle.responseState,
      publicCode: campaign.public_code,
      campaignStatus: lifecycle.responseState,
    };
    const auditMetadata: Record<string, unknown> = { lifecycleHistoryId: historyId };
    if (command.operation === 'CANCEL') auditMetadata['fromStatus'] = cancelFromStatus;
    const fact: CampaignFact = lifecycle.factKind === 'REGISTRATION_CLOSED'
      ? { kind: 'REGISTRATION_CLOSED', lifecycleHistoryId: historyId, occurredAt: occurredAt.toISOString() }
      : lifecycle.factKind === 'COMPLETED'
        ? { kind: 'COMPLETED', lifecycleHistoryId: historyId, occurredAt: occurredAt.toISOString() }
        : {
            kind: 'CANCELLED',
            lifecycleHistoryId: historyId,
            fromStatus: cancelFromStatus ?? cancellableStatus(fromStatus),
            occurredAt: occurredAt.toISOString(),
          };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      agency,
      actorId,
      responseStatus: lifecycle.responseStatus,
      responseBody,
      replayed: false,
      occurredAt: occurredAt.toISOString(),
      fact,
      auditAction: lifecycle.auditAction,
      auditMetadata,
    };
    const events = stage(commit);
    const reply = await this.#callWriteFunction(tx, command, {
      actorId,
      agency,
      operation: OPERATION_NAME[command.operation],
      auditAction: lifecycle.auditAction,
      commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      historyId,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      correlationId: command.context.correlationId,
      occurredAt: commit.occurredAt,
      responseStatus: commit.responseStatus,
      responseBody,
      events,
    });
    return this.#verifyFunctionResult(reply, commit, command);
  }
}

// BUILD-001 PostgreSQL adapter for the application-service-owned campaign
// aggregate. Every mutation is one transaction with campaign-row serialization,
// immutable command/history rows, and transactional outbox staging.

import { randomUUID } from 'node:crypto';
import {
  asJsonb,
  sql,
  stageOutboxEvents,
  type SqlTransaction,
} from '@usrp/shared-database';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import {
  campaignCoverageHash,
  campaignFactUuid,
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
  hashCampaignPolicy,
} from '../domain/campaign-policy.js';
import {
  CampaignCommandError,
  CampaignPersistenceError,
  CampaignReadError,
} from '../domain/campaign-control.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';

const OUTBOX_PRODUCER = 'application-service';
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

interface CommandRequestRow {
  readonly command_id: string;
  readonly request_hash: string;
  readonly resource_id: string;
  readonly response_status: number;
  readonly response_body: unknown;
  readonly created_at: Date | string;
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
  readonly registered_count: number;
  readonly is_active: boolean;
}

interface PolicyVersionRow {
  readonly id: string;
  readonly version_number: number;
  readonly policy_document: unknown;
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
  row: CommandRequestRow,
  command: CampaignControlCommand,
  actorId: string,
  agency: Agency,
): CampaignCommit {
  const responseBody = responseObject(row.response_body);
  const publicCode = publicCodeFromBody(responseBody, '');
  return {
    operation: command.operation,
    commandId: row.command_id,
    campaignId: row.resource_id,
    publicCode,
    agency,
    actorId,
    responseStatus: row.response_status,
    responseBody,
    replayed: true,
    occurredAt: asIso(row.created_at),
    fact: null,
    auditAction: 'CAMPAIGN_COMMAND_REPLAYED',
    auditMetadata: {},
  };
}

function errorCode(error: unknown): { readonly code?: string; readonly constraint?: string } {
  if (error === null || typeof error !== 'object') return {};
  const value = error as { readonly code?: unknown; readonly constraint?: unknown };
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.constraint === 'string' ? { constraint: value.constraint } : {}),
  };
}

function mapPersistenceError(error: unknown): Error {
  if (error instanceof CampaignCommandError || error instanceof CampaignReadError) return error;
  const pg = errorCode(error);
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

        // This read is not a row lock. It lets a completed retry return its
        // original result without re-running state validation. Any new write
        // takes its campaign FOR UPDATE lock before its first mutating statement.
        const prior = await this.#findCommand(tx, command, actorId);
        if (prior !== null) return replayCommit(prior, command, actorId, agency);

        let commit: CampaignCommit;
        if (command.operation === 'CREATE_DRAFT') {
          commit = await this.#createDraft(tx, command, actorId, agency, stage);
        } else {
          const publicCode = command.operation === 'CREATE_POLICY_VERSION'
            ? command.policy.publicCode
            : command.publicCode;
          const campaign = await this.#lockCampaign(tx, agency, publicCode);
          if (campaign === null) {
            throw commandError('CAMPAIGN_NOT_FOUND', 'Campaign was not found.', 404);
          }
          // Another copy of the same command may have committed while this
          // transaction waited on the campaign row. Check again before state
          // validation so that concurrent duplicates replay, not conflict.
          const priorAfterLock = await this.#findCommand(tx, command, actorId);
          if (priorAfterLock !== null) {
            return replayCommit(priorAfterLock, command, actorId, agency);
          }
          switch (command.operation) {
            case 'CREATE_POLICY_VERSION':
              commit = await this.#createPolicyVersion(tx, command, campaign, actorId, agency, stage);
              break;
            case 'PUBLISH':
              commit = await this.#publish(tx, command, campaign, actorId, agency, stage);
              break;
            case 'CLOSE_REGISTRATION':
              commit = await this.#closeRegistration(tx, command, campaign, actorId, agency, stage);
              break;
            case 'COMPLETE':
              commit = await this.#complete(tx, command, campaign, actorId, agency, stage);
              break;
            case 'CANCEL':
              commit = await this.#cancel(tx, command, campaign, actorId, agency, stage);
              break;
            default: {
              const unreachable: never = command;
              throw new Error(`Unhandled campaign command ${JSON.stringify(unreachable)}`);
            }
          }
        }
        return commit;
      });
    } catch (cause) {
      throw mapPersistenceError(cause);
    }
  }

  async #findCommand(
    tx: SqlTransaction,
    command: CampaignControlCommand,
    actorId: string,
  ): Promise<CommandRequestRow | null> {
    const rows = await tx<CommandRequestRow[]>`
      SELECT command_id, request_hash, resource_id, response_status, response_body, created_at
      FROM public_core.campaign_command_requests
      WHERE actor_id = ${actorId}::uuid
        AND operation = ${OPERATION_NAME[command.operation]}
        AND idempotency_key = ${command.idempotencyKey}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.request_hash !== command.requestHash) {
      throw commandError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different campaign command.',
      );
    }
    return row;
  }

  async #claimCommand(
    tx: SqlTransaction,
    command: CampaignControlCommand,
    actorId: string,
    agency: Agency,
    resourceId: string,
    responseStatus: number,
    responseBody: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly commandId: string; readonly replay: CampaignCommit | null }> {
    const commandId = randomUUID();
    const operation = OPERATION_NAME[command.operation];
    const rows = await tx<{ command_id: string }[]>`
      INSERT INTO public_core.campaign_command_requests
        (command_id, actor_id, agency, operation, idempotency_key, request_hash,
         resource_id, response_status, response_body)
      VALUES (
        ${commandId}::uuid,
        ${actorId}::uuid,
        ${agency}::public_core.agency,
        ${operation},
        ${command.idempotencyKey}::uuid,
        ${command.requestHash},
        ${resourceId}::uuid,
        ${responseStatus},
        ${tx.json(asJsonb(responseBody))}
      )
      ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING
      RETURNING command_id
    `;
    if (rows[0] !== undefined) return { commandId, replay: null };

    const prior = await this.#findCommand(tx, command, actorId);
    if (prior === null) {
      throw commandError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key is unavailable for this campaign command.',
      );
    }
    return {
      commandId: prior.command_id,
      replay: replayCommit(prior, command, actorId, agency),
    };
  }

  async #lockCampaign(
    tx: SqlTransaction,
    agency: Agency,
    publicCode: string,
  ): Promise<CampaignRow | null> {
    const rows = await tx<CampaignRow[]>`
      SELECT id, public_code, agency, status, target_categories, target_districts,
             examination_start_date, examination_end_date, current_policy_version_id
      FROM public_core.recruitment_campaigns
      WHERE public_code = ${publicCode}
        AND agency = ${agency}::public_core.agency
      FOR UPDATE
    `;
    const row = rows[0];
    if (row !== undefined && row.agency !== agency) {
      throw commandError('CAMPAIGN_NOT_FOUND', 'Campaign was not found.', 404);
    }
    return row ?? null;
  }

  async #createDraft(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'CREATE_DRAFT' }>,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    const campaignId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: 'DRAFT_CREATED',
      publicCode: command.draft.publicCode,
      campaignStatus: 'DRAFT',
    };
    const claim = await this.#claimCommand(
      tx,
      command,
      actorId,
      agency,
      campaignId,
      201,
      responseBody,
    );
    if (claim.replay !== null) return claim.replay;

    const draft = command.draft;
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, campaign_label, agency, public_code, status, target_categories,
         target_districts, registration_opens_at, registration_closes_at,
         examination_start_date, examination_end_date, examination_reporting_hour,
         allows_walk_in, target_intake_count, contact_phone_numbers, contact_website,
         published_at, created_at, updated_at)
      VALUES (
        ${campaignId}::uuid,
        ${draft.campaignLabel},
        ${agency}::public_core.agency,
        ${draft.publicCode},
        'DRAFT',
        ${JSON.stringify(draft.targetCategories)},
        ${tx.json(asJsonb(draft.targetDistricts))},
        ${draft.registrationOpensAt}::timestamptz,
        ${draft.registrationClosesAt}::timestamptz,
        ${draft.examinationStartDate},
        ${draft.examinationEndDate},
        ${draft.examinationReportingHour},
        ${draft.allowsWalkIn},
        ${draft.targetIntakeCount ?? null},
        ${draft.contactPhoneNumbers === undefined ? null : JSON.stringify(draft.contactPhoneNumbers)},
        ${draft.contactWebsite ?? null},
        NULL,
        ${occurredAt}::timestamptz,
        ${occurredAt}::timestamptz
      )
    `;
    await this.#insertLifecycleHistory(tx, {
      id: randomUUID(),
      campaignId,
      agency,
      fromStatus: null,
      toStatus: 'DRAFT',
      actorId,
      correlationId: command.context.correlationId,
      occurredAt,
    });

    const commit: CampaignCommit = {
      operation: command.operation,
      commandId: claim.commandId,
      campaignId,
      publicCode: draft.publicCode,
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
    await stageOutboxEvents(tx, stage(commit), OUTBOX_PRODUCER);
    return commit;
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

    const current = await tx<{ next_version: number }[]>`
      SELECT COALESCE(max(version_number), 0) + 1 AS next_version
      FROM public_core.campaign_policy_versions
      WHERE campaign_id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
    `;
    const versionNumber = current[0]?.next_version ?? 1;
    const policyVersionId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const policyHash = hashCampaignPolicy(command.policy);
    validateHash(policyHash, 'policyHash');
    const responseBody = {
      status: 'POLICY_VERSION_CREATED',
      publicCode: campaign.public_code,
      policyVersion: versionNumber,
      policyHash,
    };
    const claim = await this.#claimCommand(
      tx,
      command,
      actorId,
      agency,
      campaign.id,
      201,
      responseBody,
    );
    if (claim.replay !== null) return claim.replay;

    await tx`
      INSERT INTO public_core.campaign_policy_versions
        (id, campaign_id, agency, version_number, policy_document,
         policy_hash, hash_version, legal_basis_code, legal_basis_reference,
         created_by, created_at)
      VALUES (
        ${policyVersionId}::uuid,
        ${campaign.id}::uuid,
        ${agency}::public_core.agency,
        ${versionNumber},
        ${tx.json(asJsonb(command.policy.policyDocument))},
        ${policyHash},
        ${CAMPAIGN_POLICY_HASH_VERSION},
        ${command.policy.legalBasisCode},
        ${command.policy.legalBasisReference},
        ${actorId}::uuid,
        ${occurredAt}::timestamptz
      )
    `;
    await tx`
      UPDATE public_core.recruitment_campaigns
      SET current_policy_version_id = ${policyVersionId}::uuid,
          updated_at = ${occurredAt}::timestamptz
      WHERE id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
    `;

    const commit: CampaignCommit = {
      operation: command.operation,
      commandId: claim.commandId,
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
    await stageOutboxEvents(tx, stage(commit), OUTBOX_PRODUCER);
    return commit;
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

    // Campaign row is already FOR UPDATE. Now lock the head and reread all
    // session rows in this transaction; the head hash is evidence only.
    const heads = await tx<CoverageHeadRow[]>`
      SELECT coverage_version, coverage_hash
      FROM public_core.campaign_coverage_heads
      WHERE campaign_id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
      FOR UPDATE
    `;
    const head = heads[0];
    const sessions = await tx<SessionRow[]>`
      SELECT district, province, venue_name, exam_date, reporting_time_hour,
             capacity_limit, registered_count, is_active
      FROM public_core.campaign_venue_assignments
      WHERE campaign_id = ${campaign.id}::uuid
      ORDER BY district, exam_date, venue_name
    `;
    const targetDistricts = campaign.target_districts === null
      ? []
      : parseStringArray(campaign.target_districts, 'target_districts');
    this.#assertCompleteCoverage(campaign, targetDistricts, sessions, head);

    const policyRows = await tx<PolicyVersionRow[]>`
      SELECT id, version_number, policy_document, policy_hash, hash_version,
             legal_basis_code, legal_basis_reference
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
    const policyHash = hashCampaignPolicy(storedPolicy);
    if (policyHash !== policy.policy_hash) {
      throw commandError('POLICY_HASH_MISMATCH', 'The stored policy hash does not match its immutable document.');
    }

    const publicationId = randomUUID();
    const publicationEventId = campaignFactUuid(
      CAMPAIGN_EVENT_NAMESPACE,
      `campaign-published:${publicationId}`,
    );
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: 'CAMPAIGN_PUBLISHED',
      publicCode: campaign.public_code,
      campaignStatus: 'REGISTRATION_OPEN',
      policyVersion: policy.version_number,
      coverageVersion: head.coverage_version,
      coverageHash: head.coverage_hash,
    };
    const claim = await this.#claimCommand(
      tx,
      command,
      actorId,
      agency,
      campaign.id,
      200,
      responseBody,
    );
    if (claim.replay !== null) return claim.replay;

    await tx`
      INSERT INTO public_core.campaign_publications
        (id, campaign_id, agency, public_code, policy_version_id,
         coverage_version, coverage_hash, publication_event_id, published_by, published_at)
      VALUES (
        ${publicationId}::uuid,
        ${campaign.id}::uuid,
        ${agency}::public_core.agency,
        ${campaign.public_code},
        ${policy.id}::uuid,
        ${head.coverage_version},
        ${head.coverage_hash},
        ${publicationEventId}::uuid,
        ${actorId}::uuid,
        ${occurredAt}::timestamptz
      )
    `;
    const historyId = randomUUID();
    await this.#insertLifecycleHistory(tx, {
      id: historyId,
      campaignId: campaign.id,
      agency,
      fromStatus: 'DRAFT',
      toStatus: 'REGISTRATION_OPEN',
      actorId,
      correlationId: command.context.correlationId,
      occurredAt,
    });
    await tx`
      UPDATE public_core.recruitment_campaigns
      SET status = 'REGISTRATION_OPEN',
          published_at = ${occurredAt}::timestamptz,
          updated_at = ${occurredAt}::timestamptz
      WHERE id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
    `;

    const fact: CampaignFact = {
      kind: 'PUBLISHED',
      publicationId,
      publicationEventId,
      policyVersionId: policy.id,
      policyVersionNumber: policy.version_number,
      coverageVersion: head.coverage_version,
      coverageHash: head.coverage_hash,
      occurredAt: occurredAt.toISOString(),
    };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId: claim.commandId,
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
    await stageOutboxEvents(tx, stage(commit), OUTBOX_PRODUCER);
    return commit;
  }

  #assertCompleteCoverage(
    campaign: CampaignRow,
    targetDistricts: readonly string[],
    sessions: readonly SessionRow[],
    head: CoverageHeadRow | undefined,
  ): asserts head is CoverageHeadRow {
    if (targetDistricts.length === 0 || head === undefined) {
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
      if (session.capacity_limit !== null && session.capacity_limit <= 0) {
        throw commandError('INVALID_CAPACITY', 'Session capacity must be positive or unbounded.', 422);
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
      sessions.map((session) => ({
        district: session.district,
        province: session.province,
        venueName: session.venue_name,
        examDate: session.exam_date,
        reportingTimeHour: session.reporting_time_hour,
        capacityLimit: session.capacity_limit,
        isActive: session.is_active,
      })),
    );
    validateHash(head.coverage_hash, 'coverageHash');
    if (head.coverage_version < 1 || observedHash !== head.coverage_hash) {
      throw commandError('STALE_COVERAGE', 'Coverage head does not match the current session set.');
    }
  }

  async #closeRegistration(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'CLOSE_REGISTRATION' }>,
    campaign: CampaignRow,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    if (campaign.status !== 'REGISTRATION_OPEN') {
      throw commandError('INVALID_STATE', 'Only an open campaign can close registration.');
    }
    const historyId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: 'REGISTRATION_CLOSED',
      publicCode: campaign.public_code,
      campaignStatus: 'REGISTRATION_CLOSED',
    };
    const claim = await this.#claimCommand(
      tx,
      command,
      actorId,
      agency,
      campaign.id,
      200,
      responseBody,
    );
    if (claim.replay !== null) return claim.replay;

    await this.#insertLifecycleHistory(tx, {
      id: historyId,
      campaignId: campaign.id,
      agency,
      fromStatus: 'REGISTRATION_OPEN',
      toStatus: 'REGISTRATION_CLOSED',
      actorId,
      correlationId: command.context.correlationId,
      occurredAt,
    });
    await tx`
      UPDATE public_core.recruitment_campaigns
      SET status = 'REGISTRATION_CLOSED',
          registration_closed_at = ${occurredAt}::timestamptz,
          updated_at = ${occurredAt}::timestamptz
      WHERE id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
    `;

    const fact: CampaignFact = {
      kind: 'REGISTRATION_CLOSED',
      lifecycleHistoryId: historyId,
      occurredAt: occurredAt.toISOString(),
    };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId: claim.commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      agency,
      actorId,
      responseStatus: 200,
      responseBody,
      replayed: false,
      occurredAt: occurredAt.toISOString(),
      fact,
      auditAction: 'CAMPAIGN_REGISTRATION_CLOSED',
      auditMetadata: { lifecycleHistoryId: historyId },
    };
    await stageOutboxEvents(tx, stage(commit), OUTBOX_PRODUCER);
    return commit;
  }

  async #complete(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'COMPLETE' }>,
    campaign: CampaignRow,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    if (campaign.status !== 'REGISTRATION_CLOSED') {
      throw commandError('INVALID_STATE', 'Only a campaign with closed registration can be completed.');
    }
    const historyId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: 'CAMPAIGN_COMPLETED',
      publicCode: campaign.public_code,
      campaignStatus: 'COMPLETED',
    };
    const claim = await this.#claimCommand(
      tx,
      command,
      actorId,
      agency,
      campaign.id,
      200,
      responseBody,
    );
    if (claim.replay !== null) return claim.replay;

    await this.#insertLifecycleHistory(tx, {
      id: historyId,
      campaignId: campaign.id,
      agency,
      fromStatus: 'REGISTRATION_CLOSED',
      toStatus: 'COMPLETED',
      actorId,
      correlationId: command.context.correlationId,
      occurredAt,
    });
    await tx`
      UPDATE public_core.recruitment_campaigns
      SET status = 'COMPLETED',
          updated_at = ${occurredAt}::timestamptz
      WHERE id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
    `;

    const fact: CampaignFact = {
      kind: 'COMPLETED',
      lifecycleHistoryId: historyId,
      occurredAt: occurredAt.toISOString(),
    };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId: claim.commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      agency,
      actorId,
      responseStatus: 200,
      responseBody,
      replayed: false,
      occurredAt: occurredAt.toISOString(),
      fact,
      auditAction: 'CAMPAIGN_COMPLETED',
      auditMetadata: { lifecycleHistoryId: historyId },
    };
    await stageOutboxEvents(tx, stage(commit), OUTBOX_PRODUCER);
    return commit;
  }

  async #cancel(
    tx: SqlTransaction,
    command: Extract<CampaignControlCommand, { readonly operation: 'CANCEL' }>,
    campaign: CampaignRow,
    actorId: string,
    agency: Agency,
    stage: StageCampaignEvents,
  ): Promise<CampaignCommit> {
    if (campaign.status !== 'DRAFT' && campaign.status !== 'REGISTRATION_OPEN') {
      throw commandError('INVALID_STATE', 'Only a draft or open campaign can be cancelled.');
    }
    if (campaign.status === 'REGISTRATION_OPEN') {
      const schema = schemaForAgency(agency);
      const rows = await tx<{ has_application: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM ${sql(schema)}.applications
          WHERE campaign_id = ${campaign.id}::uuid
        ) AS has_application
      `;
      if (rows[0]?.has_application === true) {
        throw commandError(
          'CANCELLATION_HAS_APPLICATIONS',
          'An open campaign with applications cannot be cancelled.',
        );
      }
    }

    const fromStatus = campaign.status;
    const historyId = randomUUID();
    const occurredAt = await this.#transactionTime(tx);
    const responseBody = {
      status: 'CAMPAIGN_CANCELLED',
      publicCode: campaign.public_code,
      campaignStatus: 'CANCELLED',
    };
    const claim = await this.#claimCommand(
      tx,
      command,
      actorId,
      agency,
      campaign.id,
      200,
      responseBody,
    );
    if (claim.replay !== null) return claim.replay;

    await this.#insertLifecycleHistory(tx, {
      id: historyId,
      campaignId: campaign.id,
      agency,
      fromStatus,
      toStatus: 'CANCELLED',
      actorId,
      correlationId: command.context.correlationId,
      occurredAt,
    });
    await tx`
      UPDATE public_core.recruitment_campaigns
      SET status = 'CANCELLED',
          cancelled_at = ${occurredAt}::timestamptz,
          updated_at = ${occurredAt}::timestamptz
      WHERE id = ${campaign.id}::uuid AND agency = ${agency}::public_core.agency
    `;

    const fact: CampaignFact = {
      kind: 'CANCELLED',
      lifecycleHistoryId: historyId,
      fromStatus,
      occurredAt: occurredAt.toISOString(),
    };
    const commit: CampaignCommit = {
      operation: command.operation,
      commandId: claim.commandId,
      campaignId: campaign.id,
      publicCode: campaign.public_code,
      agency,
      actorId,
      responseStatus: 200,
      responseBody,
      replayed: false,
      occurredAt: occurredAt.toISOString(),
      fact,
      auditAction: 'CAMPAIGN_CANCELLED',
      auditMetadata: { lifecycleHistoryId: historyId, fromStatus },
    };
    await stageOutboxEvents(tx, stage(commit), OUTBOX_PRODUCER);
    return commit;
  }

  async #transactionTime(tx: SqlTransaction): Promise<Date> {
    const rows = await tx<DbClock[]>`SELECT transaction_timestamp() AS occurred_at`;
    const row = rows[0];
    if (row === undefined) throw new CampaignPersistenceError('Database did not return transaction time.');
    return asDate(row.occurred_at);
  }

  async #insertLifecycleHistory(
    tx: SqlTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly agency: Agency;
      readonly fromStatus: CampaignStatus | null;
      readonly toStatus: CampaignStatus;
      readonly actorId: string;
      readonly correlationId: string;
      readonly occurredAt: Date;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO public_core.campaign_lifecycle_history
        (id, campaign_id, agency, from_status, to_status,
         actor_id, correlation_id, occurred_at)
      VALUES (
        ${input.id}::uuid,
        ${input.campaignId}::uuid,
        ${input.agency}::public_core.agency,
        ${input.fromStatus}::public_core.campaign_status,
        ${input.toStatus}::public_core.campaign_status,
        ${input.actorId}::uuid,
        ${input.correlationId},
        ${input.occurredAt}::timestamptz
      )
    `;
  }
}

// BUILD-001 application-service campaign aggregate.
// Permission checks, request normalization, canonical hashes, and stable
// lifecycle/audit event construction live here; persistence owns transaction and
// lock ordering.

import {
  hasCampaignPermission,
  type CampaignPermission,
  type Principal,
} from '@usrp/shared-auth';
import {
  campaignFactUuid,
  hashCampaignCanonicalJson,
} from '@usrp/shared-security';
import type {
  AuditEvent,
  CampaignCancelledEvent,
  CampaignCompletedEvent,
  CampaignDraftCreatedEvent,
  CampaignPolicyVersionCreatedEvent,
  CampaignPublishedEvent,
  CampaignRegistrationClosedEvent,
  USRPEvent,
} from '@usrp/shared-types';
import type {
  CampaignCommit,
  CampaignContext,
  CampaignControlCommand,
  CampaignControlRepository,
} from '../ports/campaign-control.repository.js';
import {
  CampaignCommandError,
} from '../domain/campaign-control.errors.js';
import {
  normalizeCampaignDraft,
  normalizeCampaignPolicy,
  normalizeCampaignPublicCodeCommand,
  normalizePublicCode,
} from '../domain/campaign-validation.js';

const IDEMPOTENCY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPAIGN_EVENT_NAMESPACE = 'c6c2ef80-2ef0-4eeb-b6a4-4f93d5a4ac11';
const AUDIT_EVENT_NAMESPACE = 'bb663e0e-fb15-4a7b-9eaf-2764a6f75cb4';

export interface CampaignWriteRequest {
  readonly actor: Principal;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
  readonly correlationId: string;
}

export interface CampaignControlDeps {
  readonly repository: CampaignControlRepository;
}

export class CampaignControlService {
  readonly #repository: CampaignControlRepository;

  constructor(deps: CampaignControlDeps) {
    this.#repository = deps.repository;
  }

  async createDraft(request: CampaignWriteRequest): Promise<CampaignCommit> {
    const actor = requirePermission(request.actor, 'campaign.create');
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const draft = normalizeCampaignDraft(request.body, actor.agency);
    const command: CampaignControlCommand = {
      operation: 'CREATE_DRAFT',
      actor,
      idempotencyKey,
      requestHash: hashCampaignCanonicalJson({ operation: 'CREATE_DRAFT', draft }),
      draft,
      context: { correlationId: request.correlationId },
    };
    return this.#execute(command);
  }

  async createPolicyVersion(request: CampaignWriteRequest): Promise<CampaignCommit> {
    const actor = requirePermission(request.actor, 'campaign.policy.create');
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const publicCode = bodyPublicCode(request.body);
    const campaign = await this.#campaignContext(actor, publicCode);
    const policy = normalizeCampaignPolicy(request.body, campaign.targetCategories);
    const command: CampaignControlCommand = {
      operation: 'CREATE_POLICY_VERSION',
      actor,
      idempotencyKey,
      requestHash: hashCampaignCanonicalJson({
        operation: 'CREATE_POLICY_VERSION',
        publicCode,
        policyDocument: policy.policyDocument,
        legalBasisCode: policy.legalBasisCode,
        legalBasisReference: policy.legalBasisReference,
      }),
      policy,
      context: { correlationId: request.correlationId },
    };
    return this.#execute(command);
  }

  async publish(request: CampaignWriteRequest): Promise<CampaignCommit> {
    const actor = requirePermission(request.actor, 'campaign.publish');
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const publicCode = normalizeCampaignPublicCodeCommand(request.body);
    const command: CampaignControlCommand = {
      operation: 'PUBLISH',
      actor,
      idempotencyKey,
      requestHash: simpleCommandHash('PUBLISH', publicCode),
      publicCode,
      context: { correlationId: request.correlationId },
    };
    return this.#execute(command);
  }

  async closeRegistration(request: CampaignWriteRequest): Promise<CampaignCommit> {
    const actor = requirePermission(request.actor, 'campaign.registration.close');
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const publicCode = normalizeCampaignPublicCodeCommand(request.body);
    const command: CampaignControlCommand = {
      operation: 'CLOSE_REGISTRATION',
      actor,
      idempotencyKey,
      requestHash: simpleCommandHash('CLOSE_REGISTRATION', publicCode),
      publicCode,
      context: { correlationId: request.correlationId },
    };
    return this.#execute(command);
  }

  async complete(request: CampaignWriteRequest): Promise<CampaignCommit> {
    const actor = requirePermission(request.actor, 'campaign.complete');
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const publicCode = normalizeCampaignPublicCodeCommand(request.body);
    const command: CampaignControlCommand = {
      operation: 'COMPLETE',
      actor,
      idempotencyKey,
      requestHash: simpleCommandHash('COMPLETE', publicCode),
      publicCode,
      context: { correlationId: request.correlationId },
    };
    return this.#execute(command);
  }

  async cancel(request: CampaignWriteRequest): Promise<CampaignCommit> {
    const actor = requirePermission(request.actor, 'campaign.cancel');
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const publicCode = normalizeCampaignPublicCodeCommand(request.body);
    const command: CampaignControlCommand = {
      operation: 'CANCEL',
      actor,
      idempotencyKey,
      requestHash: simpleCommandHash('CANCEL', publicCode),
      publicCode,
      context: { correlationId: request.correlationId },
    };
    return this.#execute(command);
  }

  async #campaignContext(
    actor: Extract<Principal, { readonly kind: 'officer' }>,
    publicCode: string,
  ): Promise<CampaignContext> {
    const campaign = await this.#repository.findCampaignContext(actor, publicCode);
    if (campaign === null || campaign.agency !== actor.agency) {
      throw new CampaignCommandError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
    }
    return campaign;
  }

  #execute(command: CampaignControlCommand): Promise<CampaignCommit> {
    return this.#repository.execute(command, (commit) =>
      commit.replayed ? [] : campaignEvents(commit, command.context.correlationId),
    );
  }
}

function requirePermission(
  actor: Principal,
  permission: CampaignPermission,
): Extract<Principal, { readonly kind: 'officer' }> {
  if (actor.kind !== 'officer' || !hasCampaignPermission(actor, permission)) {
    throw new CampaignCommandError(403, 'FORBIDDEN', 'The verified officer lacks this campaign permission.');
  }
  return actor;
}

function requireIdempotencyKey(value: string | undefined): string {
  if (value === undefined || !IDEMPOTENCY_UUID_RE.test(value.trim())) {
    throw new CampaignCommandError(400, 'INVALID_IDEMPOTENCY_KEY', 'A UUID Idempotency-Key header is required.');
  }
  return value.trim().toLowerCase();
}

function bodyPublicCode(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CampaignCommandError(400, 'INVALID_REQUEST', 'Request body must be an object.');
  }
  return normalizePublicCode((body as Record<string, unknown>).publicCode);
}

function simpleCommandHash(operation: string, publicCode: string): string {
  return hashCampaignCanonicalJson({ operation, publicCode });
}

function campaignEvents(commit: CampaignCommit, correlationId: string): readonly USRPEvent[] {
  const occurredAt = commit.occurredAt;
  const causationId = commit.commandId;
  const base = {
    eventVersion: '1.0' as const,
    schemaVersion: '1.0' as const,
    piiClassification: 'NONE' as const,
    occurredAt,
    correlationId,
    causationId,
    campaignId: commit.campaignId,
    publicCode: commit.publicCode,
    agency: commit.agency,
  };

  const events: USRPEvent[] = [];
  switch (commit.fact?.kind) {
    case 'DRAFT_CREATED': {
      const event: CampaignDraftCreatedEvent = {
        ...base,
        eventId: campaignFactUuid(CAMPAIGN_EVENT_NAMESPACE, `campaign-draft-created:${commit.campaignId}`),
        eventType: 'CAMPAIGN_DRAFT_CREATED',
        factId: commit.campaignId,
        createdAt: commit.fact.occurredAt,
      };
      events.push(event);
      break;
    }
    case 'POLICY_VERSION_CREATED': {
      const event: CampaignPolicyVersionCreatedEvent = {
        ...base,
        eventId: campaignFactUuid(
          CAMPAIGN_EVENT_NAMESPACE,
          `campaign-policy-version-created:${commit.fact.policyVersionId}`,
        ),
        eventType: 'CAMPAIGN_POLICY_VERSION_CREATED',
        factId: commit.fact.policyVersionId,
        policyVersionId: commit.fact.policyVersionId,
        policyVersionNumber: commit.fact.policyVersionNumber,
        createdAt: commit.fact.occurredAt,
      };
      events.push(event);
      break;
    }
    case 'PUBLISHED': {
      const event: CampaignPublishedEvent = {
        ...base,
        eventId: commit.fact.publicationEventId,
        eventType: 'CAMPAIGN_PUBLISHED',
        factId: commit.fact.publicationId,
        publicationId: commit.fact.publicationId,
        policyVersionId: commit.fact.policyVersionId,
        policyVersionNumber: commit.fact.policyVersionNumber,
        coverageVersion: commit.fact.coverageVersion,
        coverageHash: commit.fact.coverageHash,
        publishedAt: commit.fact.occurredAt,
      };
      events.push(event);
      break;
    }
    case 'REGISTRATION_CLOSED': {
      const event: CampaignRegistrationClosedEvent = {
        ...base,
        eventId: campaignFactUuid(
          CAMPAIGN_EVENT_NAMESPACE,
          `registration-closed:${commit.fact.lifecycleHistoryId}`,
        ),
        eventType: 'CAMPAIGN_REGISTRATION_CLOSED',
        factId: commit.fact.lifecycleHistoryId,
        lifecycleHistoryId: commit.fact.lifecycleHistoryId,
        closedAt: commit.fact.occurredAt,
      };
      events.push(event);
      break;
    }
    case 'COMPLETED': {
      const event: CampaignCompletedEvent = {
        ...base,
        eventId: campaignFactUuid(
          CAMPAIGN_EVENT_NAMESPACE,
          `completed:${commit.fact.lifecycleHistoryId}`,
        ),
        eventType: 'CAMPAIGN_COMPLETED',
        factId: commit.fact.lifecycleHistoryId,
        lifecycleHistoryId: commit.fact.lifecycleHistoryId,
        completedAt: commit.fact.occurredAt,
      };
      events.push(event);
      break;
    }
    case 'CANCELLED': {
      const event: CampaignCancelledEvent = {
        ...base,
        eventId: campaignFactUuid(
          CAMPAIGN_EVENT_NAMESPACE,
          `cancelled:${commit.fact.lifecycleHistoryId}`,
        ),
        eventType: 'CAMPAIGN_CANCELLED',
        factId: commit.fact.lifecycleHistoryId,
        lifecycleHistoryId: commit.fact.lifecycleHistoryId,
        cancelledAt: commit.fact.occurredAt,
      };
      events.push(event);
      break;
    }
    case undefined:
      break;
  }

  const audit: AuditEvent = {
    ...base,
    eventId: campaignFactUuid(AUDIT_EVENT_NAMESPACE, `campaign-command:${commit.commandId}`),
    eventType: 'AUDIT_ENTRY',
    entityType: 'CAMPAIGN',
    entityId: commit.campaignId,
    action: commit.auditAction,
    performedBy: commit.actorId,
    agency: commit.agency,
    metadata: {
      publicCode: commit.publicCode,
      operation: commit.operation,
      ...commit.auditMetadata,
    },
  };
  events.push(audit);
  return events;
}

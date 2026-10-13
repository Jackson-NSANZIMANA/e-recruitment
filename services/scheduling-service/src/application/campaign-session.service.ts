// BUILD-001 scheduling-owned campaign session/coverage command.
// This service authorizes and validates; the repository serializes all writes on
// the campaign row and stages the safe audit event in the same transaction.

import {
  hasCampaignPermission,
  type Principal,
} from '@usrp/shared-auth';
import type {
  AuditEvent,
  CampaignSessionConfiguredEvent,
  CampaignSessionInput,
  USRPEvent,
} from '@usrp/shared-types';
import { campaignFactUuid, hashCampaignCanonicalJson } from '@usrp/shared-security';
import type {
  CampaignSessionCommand,
  CampaignSessionCommit,
  CampaignSessionRepository,
} from '../ports/campaign-session.repository.js';
import { CampaignSessionInputError, normalizeCampaignSession } from '../domain/campaign-session-validation.js';

const IDEMPOTENCY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPAIGN_EVENT_NAMESPACE = 'c6c2ef80-2ef0-4eeb-b6a4-4f93d5a4ac11';
const AUDIT_EVENT_NAMESPACE = 'bb663e0e-fb15-4a7b-9eaf-2764a6f75cb4';

export class CampaignSessionCommandError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CampaignSessionCommandError';
    this.status = status;
    this.code = code;
  }
}

export interface CampaignSessionWriteRequest {
  readonly actor: Principal;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
  readonly correlationId: string;
}

export class CampaignSessionService {
  readonly #repository: CampaignSessionRepository;

  constructor(repository: CampaignSessionRepository) {
    this.#repository = repository;
  }

  async configure(request: CampaignSessionWriteRequest): Promise<CampaignSessionCommit> {
    if (
      request.actor.kind !== 'officer' ||
      !hasCampaignPermission(request.actor, 'campaign.session.configure')
    ) {
      throw new CampaignSessionCommandError(403, 'FORBIDDEN', 'The verified officer lacks session-configuration permission.');
    }
    const idempotencyKey = request.idempotencyKey?.trim();
    if (idempotencyKey === undefined || !IDEMPOTENCY_UUID_RE.test(idempotencyKey)) {
      throw new CampaignSessionCommandError(400, 'INVALID_IDEMPOTENCY_KEY', 'A UUID Idempotency-Key header is required.');
    }
    let session: CampaignSessionInput;
    try {
      session = normalizeCampaignSession(request.body);
    } catch (error) {
      if (error instanceof CampaignSessionInputError) throw error;
      throw new CampaignSessionInputError('INVALID_REQUEST', 'Session request is invalid.');
    }

    const command: CampaignSessionCommand = {
      actor: request.actor,
      idempotencyKey: idempotencyKey.toLowerCase(),
      requestHash: hashCampaignCanonicalJson({
        operation: 'CONFIGURE_SESSION',
        publicCode: session.publicCode,
        session,
      }),
      session,
      correlationId: request.correlationId,
    };
    return this.#repository.configure(command, (commit) =>
      commit.replayed ? [] : this.#events(commit, request.correlationId),
    );
  }

  #events(commit: CampaignSessionCommit, correlationId: string): readonly USRPEvent[] {
    const events: USRPEvent[] = [];
    if (commit.coverageChanged) events.push(this.#sessionEvent(commit, correlationId));
    events.push(this.#auditEvent(commit, correlationId));
    return events;
  }

  #sessionEvent(commit: CampaignSessionCommit, correlationId: string): CampaignSessionConfiguredEvent {
    const district = commit.responseBody['district'];
    const coverageHash = commit.responseBody['coverageHash'];
    if (typeof district !== 'string' || typeof coverageHash !== 'string') {
      throw new CampaignSessionCommandError(500, 'INVALID_COMMIT', 'Session commit is missing coverage evidence.');
    }
    const factId = `${commit.campaignId}:${String(commit.coverageVersion)}`;
    return {
      eventId: campaignFactUuid(CAMPAIGN_EVENT_NAMESPACE, `campaign-session-coverage:${factId}`),
      eventVersion: '1.0',
      schemaVersion: '1.0',
      piiClassification: 'NONE',
      occurredAt: commit.occurredAt,
      correlationId,
      causationId: commit.commandId,
      eventType: 'CAMPAIGN_SESSION_CONFIGURED',
      factId,
      campaignId: commit.campaignId,
      publicCode: commit.publicCode,
      agency: commit.agency,
      district,
      coverageVersion: commit.coverageVersion,
      coverageHash,
      configuredAt: commit.occurredAt,
    };
  }

  #auditEvent(commit: CampaignSessionCommit, correlationId: string): AuditEvent {
    return {
      eventId: campaignFactUuid(AUDIT_EVENT_NAMESPACE, `session-command:${commit.commandId}`),
      eventVersion: '1.0',
      schemaVersion: '1.0',
      piiClassification: 'NONE',
      occurredAt: commit.occurredAt,
      correlationId,
      causationId: commit.commandId,
      eventType: 'AUDIT_ENTRY',
      entityType: 'CAMPAIGN',
      entityId: commit.campaignId,
      action: 'CAMPAIGN_SESSION_CONFIGURED',
      performedBy: commit.actorId,
      agency: commit.agency,
      metadata: {
        publicCode: commit.publicCode,
        district: commit.responseBody['district'],
        sessionChanged: commit.changed,
        capacityDecisionCode: commit.responseBody['capacityDecisionCode'] ?? null,
        coverageVersion: commit.coverageVersion,
      },
    };
  }
}

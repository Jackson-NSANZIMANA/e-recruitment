// BUILD-001 application-service persistence port.
// Campaign aggregate writes are serialized and committed with their outbox
// records by the PostgreSQL adapter; this port exposes no transaction handle.

import type {
  Agency,
  ApplicationCategory,
  CampaignDraftInput,
  CampaignPolicyInput,
  CampaignStatus,
} from '@usrp/shared-types';
import type { Principal } from '@usrp/shared-auth';
import type { USRPEvent } from '@usrp/shared-types';

export interface CampaignWriteContext {
  readonly correlationId: string;
}

export interface CampaignContext {
  readonly campaignId: string;
  readonly publicCode: string;
  readonly agency: Agency;
  readonly status: CampaignStatus;
  readonly targetCategories: readonly ApplicationCategory[];
  readonly targetDistricts: readonly string[] | null;
  readonly examinationStartDate: string;
  readonly examinationEndDate: string;
  readonly currentPolicyVersionId: string | null;
}

interface CampaignCommandBase {
  readonly actor: Principal;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly context: CampaignWriteContext;
}

export type CampaignControlCommand =
  | (CampaignCommandBase & {
      readonly operation: 'CREATE_DRAFT';
      readonly draft: CampaignDraftInput;
    })
  | (CampaignCommandBase & {
      readonly operation: 'CREATE_POLICY_VERSION';
      readonly policy: CampaignPolicyInput;
    })
  | (CampaignCommandBase & {
      readonly operation: 'PUBLISH';
      readonly publicCode: string;
    })
  | (CampaignCommandBase & {
      readonly operation: 'CLOSE_REGISTRATION';
      readonly publicCode: string;
    })
  | (CampaignCommandBase & {
      readonly operation: 'COMPLETE';
      readonly publicCode: string;
    })
  | (CampaignCommandBase & {
      readonly operation: 'CANCEL';
      readonly publicCode: string;
    });

export type CampaignFact =
  | {
      readonly kind: 'DRAFT_CREATED';
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'POLICY_VERSION_CREATED';
      readonly policyVersionId: string;
      readonly policyVersionNumber: number;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'PUBLISHED';
      readonly publicationId: string;
      readonly publicationEventId: string;
      readonly policyVersionId: string;
      readonly policyVersionNumber: number;
      readonly coverageVersion: number;
      readonly coverageHash: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'REGISTRATION_CLOSED';
      readonly lifecycleHistoryId: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'COMPLETED';
      readonly lifecycleHistoryId: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'CANCELLED';
      readonly lifecycleHistoryId: string;
      readonly fromStatus: 'DRAFT' | 'REGISTRATION_OPEN';
      readonly occurredAt: string;
    }
  | null;

export interface CampaignCommit {
  readonly operation: CampaignControlCommand['operation'];
  readonly commandId: string;
  readonly campaignId: string;
  readonly publicCode: string;
  readonly agency: Agency;
  readonly actorId: string;
  readonly responseStatus: number;
  readonly responseBody: Readonly<Record<string, unknown>>;
  readonly replayed: boolean;
  readonly occurredAt: string;
  readonly fact: CampaignFact;
  readonly auditAction: string;
  readonly auditMetadata: Readonly<Record<string, unknown>>;
}

export type StageCampaignEvents = (commit: CampaignCommit) => readonly USRPEvent[];

export interface CampaignControlRepository {
  findCampaignContext(actor: Principal, publicCode: string): Promise<CampaignContext | null>;
  execute(command: CampaignControlCommand, stage: StageCampaignEvents): Promise<CampaignCommit>;
}

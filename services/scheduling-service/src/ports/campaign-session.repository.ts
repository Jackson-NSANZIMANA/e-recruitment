import type { Principal } from '@usrp/shared-auth';
import type { Agency, CampaignSessionInput, USRPEvent } from '@usrp/shared-types';

export interface CampaignSessionCommand {
  readonly actor: Principal;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly session: CampaignSessionInput;
  readonly correlationId: string;
}

export interface CampaignSessionCommit {
  readonly commandId: string;
  readonly campaignId: string;
  readonly publicCode: string;
  readonly agency: Agency;
  readonly actorId: string;
  readonly responseStatus: number;
  readonly responseBody: Readonly<Record<string, unknown>>;
  readonly replayed: boolean;
  readonly occurredAt: string;
  /** Any stored session field changed, including the non-hash capacity decision. */
  readonly changed: boolean;
  /** Whether immutable publication coverage changed and needs a domain fact. */
  readonly coverageChanged: boolean;
  readonly coverageVersion: number;
}

export type StageCampaignSessionEvents = (commit: CampaignSessionCommit) => readonly USRPEvent[];

export interface CampaignSessionRepository {
  configure(
    command: CampaignSessionCommand,
    stage: StageCampaignSessionEvents,
  ): Promise<CampaignSessionCommit>;
}

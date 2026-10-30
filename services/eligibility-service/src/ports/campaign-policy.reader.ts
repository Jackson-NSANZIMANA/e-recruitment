import type { ApplicationCategory } from '@usrp/shared-types';
import type { PinnedPolicy } from '../domain/policy-v2-gates.js';

/** Reads the policy version an application is pinned to (ADR-030). null: no v2 block, or no such application. */
export interface CampaignPolicyReader {
  findPinnedPolicy(applicationId: string, category: ApplicationCategory): Promise<PinnedPolicy | null>;
}

// Officer-only BUILD-001 campaign commands. The verified Principal, not the
// request body, supplies agency and actor identity. Every write requires one
// validated UUID Idempotency-Key and is intentionally non-retryable at the edge.

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier, type Principal } from '@usrp/shared-auth';
import type { CampaignControlService } from '../../application/campaign-control.service.js';
import type { CampaignCommit } from '../../ports/campaign-control.repository.js';
import {
  CampaignCommandError,
  CampaignPersistenceError,
} from '../../domain/campaign-control.errors.js';
import { CampaignInputError } from '../../domain/campaign-validation.js';

export const CREATE_CAMPAIGN_PATH = '/v1/campaigns';
export const CREATE_CAMPAIGN_POLICY_PATH = '/v1/campaigns/policy';
export const PUBLISH_CAMPAIGN_PATH = '/v1/campaigns/publish';
export const CLOSE_CAMPAIGN_REGISTRATION_PATH = '/v1/campaigns/registration-close';
export const COMPLETE_CAMPAIGN_PATH = '/v1/campaigns/complete';
export const CANCEL_CAMPAIGN_PATH = '/v1/campaigns/cancel';
const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

function oneIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function mapCampaignError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CampaignCommandError) {
    return new HttpError(error.status, error.code, error.message, { cause: error });
  }
  if (error instanceof CampaignInputError) {
    const status = new Set([
      'INVALID_POLICY',
      'POLICY_CATEGORY_COVERAGE_MISMATCH',
      'CATEGORY_AGENCY_MISMATCH',
      'INVALID_REGISTRATION_WINDOW',
      'INVALID_EXAMINATION_WINDOW',
      'DISTRICT_PROVINCE_MISMATCH',
    ]).has(error.code) ? 422 : 400;
    return new HttpError(status, error.code, error.message, { cause: error });
  }
  if (error instanceof CampaignPersistenceError) {
    return new HttpError(500, 'CAMPAIGN_PERSISTENCE_ERROR', 'Could not persist the campaign command.', { cause: error });
  }
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: error });
}

function writeRoute(
  path: string,
  run: (service: CampaignControlService, input: {
    readonly actor: Principal;
    readonly body: unknown;
    readonly idempotencyKey: string | undefined;
    readonly correlationId: string;
  }) => Promise<CampaignCommit>,
  service: CampaignControlService,
  verify: AuthVerifier,
): Route {
  return {
    method: 'POST',
    path,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, actor): Promise<HttpResult> => {
      let commit: CampaignCommit;
      try {
        commit = await run(service, {
          actor,
          body: await ctx.json(),
          idempotencyKey: oneIdempotencyKey(ctx.headers['idempotency-key']),
          correlationId: ctx.correlationId,
        });
      } catch (error) {
        throw mapCampaignError(error);
      }
      return {
        status: commit.responseStatus,
        body: commit.responseBody,
        ...(commit.replayed ? { headers: { [IDEMPOTENCY_REPLAYED_HEADER]: 'true' } } : {}),
      };
    }),
  };
}

export function campaignControlRoutes(
  service: CampaignControlService,
  verify: AuthVerifier,
): Route[] {
  return [
    writeRoute(CREATE_CAMPAIGN_PATH, (target, input) => target.createDraft(input), service, verify),
    writeRoute(CREATE_CAMPAIGN_POLICY_PATH, (target, input) => target.createPolicyVersion(input), service, verify),
    writeRoute(PUBLISH_CAMPAIGN_PATH, (target, input) => target.publish(input), service, verify),
    writeRoute(CLOSE_CAMPAIGN_REGISTRATION_PATH, (target, input) => target.closeRegistration(input), service, verify),
    writeRoute(COMPLETE_CAMPAIGN_PATH, (target, input) => target.complete(input), service, verify),
    writeRoute(CANCEL_CAMPAIGN_PATH, (target, input) => target.cancel(input), service, verify),
  ];
}

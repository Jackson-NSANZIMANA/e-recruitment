import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import {
  CampaignSessionCommandError,
  type CampaignSessionService,
} from '../application/campaign-session.service.js';
import { CampaignSessionInputError } from '../domain/campaign-session-validation.js';
import { SchedulingWriteError } from '../domain/scheduling.errors.js';

export const CONFIGURE_CAMPAIGN_SESSION_PATH = '/v1/campaigns/session';
const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

function oneIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CampaignSessionCommandError) {
    return new HttpError(error.status, error.code, error.message, { cause: error });
  }
  if (error instanceof CampaignSessionInputError) {
    const status = new Set(['DISTRICT_PROVINCE_MISMATCH']).has(error.code) ? 422 : 400;
    return new HttpError(status, error.code, error.message, { cause: error });
  }
  if (error instanceof SchedulingWriteError) {
    return new HttpError(500, 'CAMPAIGN_SESSION_PERSISTENCE_ERROR', 'Could not persist campaign session configuration.', { cause: error });
  }
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: error });
}

export function campaignSessionRoutes(
  service: CampaignSessionService,
  verify: AuthVerifier,
): Route[] {
  return [{
    method: 'POST',
    path: CONFIGURE_CAMPAIGN_SESSION_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, actor): Promise<HttpResult> => {
      try {
        const commit = await service.configure({
          actor,
          body: await ctx.json(),
          idempotencyKey: oneIdempotencyKey(ctx.headers['idempotency-key']),
          correlationId: ctx.correlationId,
        });
        return {
          status: commit.responseStatus,
          body: commit.responseBody,
          ...(commit.replayed ? { headers: { [IDEMPOTENCY_REPLAYED_HEADER]: 'true' } } : {}),
        };
      } catch (error) {
        throw mapError(error);
      }
    }),
  }];
}

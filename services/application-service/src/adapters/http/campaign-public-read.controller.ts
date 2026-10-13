// Anonymous public reads. The database role can select only the published,
// safe projection view; it cannot read internal campaign/policy/session rows.

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import type { CampaignPublicReadService } from '../../application/campaign-public-read.service.js';
import { CampaignReadError } from '../../domain/campaign-control.errors.js';
import { CampaignInputError, normalizePublicCode } from '../../domain/campaign-validation.js';

export const LIST_PUBLIC_CAMPAIGNS_PATH = '/v1/campaigns';
export const READ_PUBLIC_CAMPAIGN_PATH = '/v1/campaigns/detail';

function mapReadError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CampaignInputError) return new HttpError(400, error.code, error.message, { cause: error });
  if (error instanceof CampaignReadError) {
    return new HttpError(500, 'CAMPAIGN_READ_ERROR', 'Could not read published campaign data.', { cause: error });
  }
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: error });
}

export function campaignPublicReadRoutes(service: CampaignPublicReadService): Route[] {
  return [
    {
      method: 'GET',
      path: LIST_PUBLIC_CAMPAIGNS_PATH,
      handler: async (): Promise<HttpResult> => {
        try {
          return { status: 200, body: { campaigns: await service.listOpen() } };
        } catch (error) {
          throw mapReadError(error);
        }
      },
    },
    {
      method: 'GET',
      path: READ_PUBLIC_CAMPAIGN_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const values = ctx.query.getAll('publicCode');
        if (values.length !== 1 || values[0] === undefined) {
          throw new HttpError(400, 'INVALID_PUBLIC_CODE', 'Exactly one publicCode query parameter is required.');
        }
        let publicCode: string;
        try {
          publicCode = normalizePublicCode(values[0]);
        } catch (error) {
          throw mapReadError(error);
        }
        try {
          const campaign = await service.findPublishedByCode(publicCode);
          return campaign === null
            ? { status: 404, body: { error: 'CAMPAIGN_NOT_FOUND' } }
            : { status: 200, body: { campaign } };
        } catch (error) {
          throw mapReadError(error);
        }
      },
    },
  ];
}

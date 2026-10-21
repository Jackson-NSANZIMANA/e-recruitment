// ══════════════════════════════════════════════════════════════════
// application-service — Operational read routes (ADR-039), officer only
//
//   GET /v1/campaigns/admin            campaign.read.admin  all states, search, cursor, total
//   GET /v1/campaigns/admin/detail     campaign.read.admin  sessions, occupancy, policy hash
//   GET /v1/applications/search        application.read     filters, cursor, total (list v2)
//   GET /v1/venue-roster               admission.gate | field.score.sync   no names, no NIDs
//
// The agency is the verified principal's. There is no agency parameter.
// A missing campaign and a sibling agency's campaign are the same bare 404.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { principalHasPermission, requireOfficerPermission, withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { OperationalReadService } from '../../application/operational-read.service.js';
import { ApplicationReadError } from '../../domain/application.errors.js';
import {
  parseApplicationSearch,
  parseCampaignAdminDetail,
  parseCampaignAdminSearch,
  parseRosterQuery,
  ReadInputError,
} from '../../domain/operational-reads.js';

export const ADMIN_CAMPAIGN_LIST_PATH = '/v1/campaigns/admin';
export const ADMIN_CAMPAIGN_DETAIL_PATH = '/v1/campaigns/admin/detail';
export const SEARCH_APPLICATIONS_PATH = '/v1/applications/search';
export const VENUE_ROSTER_PATH = '/v1/venue-roster';

const NOT_FOUND: HttpResult = { status: 404, body: { error: 'NOT_FOUND' } };
const FORBIDDEN: HttpResult = { status: 403, body: { error: 'FORBIDDEN' } };

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReadInputError) throw new HttpError(400, error.code, error.message, { cause: error });
    if (error instanceof HttpError) throw error;
    if (error instanceof ApplicationReadError) {
      throw new HttpError(500, 'APPLICATION_READ_ERROR', 'Could not complete the read.', { cause: error });
    }
    throw new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: error });
  }
}

export function operationalReadRoutes(service: OperationalReadService, verify: AuthVerifier): Route[] {
  return [
    {
      method: 'GET',
      path: ADMIN_CAMPAIGN_LIST_PATH,
      handler: withAuth(verify, { kind: 'officer' }, (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'campaign.read.admin');
        return guarded(async () => {
          const outcome = await service.listCampaigns(principal, parseCampaignAdminSearch(ctx.query));
          if (outcome.kind !== 'OK') return FORBIDDEN;
          return {
            status: 200,
            body: { agency: outcome.agency, campaigns: outcome.items, total: outcome.total, nextCursor: outcome.nextCursor },
          };
        });
      }),
    },
    {
      method: 'GET',
      path: ADMIN_CAMPAIGN_DETAIL_PATH,
      handler: withAuth(verify, { kind: 'officer' }, (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'campaign.read.admin');
        return guarded(async () => {
          const outcome = await service.campaignDetail(principal, parseCampaignAdminDetail(ctx.query));
          if (outcome.kind === 'FORBIDDEN') return FORBIDDEN;
          if (outcome.kind === 'NOT_FOUND') return NOT_FOUND;
          const { summary, ...rest } = outcome.value;
          return { status: 200, body: { agency: outcome.agency, campaign: { ...summary, ...rest } } };
        });
      }),
    },
    {
      method: 'GET',
      path: SEARCH_APPLICATIONS_PATH,
      handler: withAuth(verify, { kind: 'officer' }, (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'application.read');
        return guarded(async () => {
          const outcome = await service.searchApplications(principal, parseApplicationSearch(ctx.query));
          if (outcome.kind !== 'OK') return FORBIDDEN;
          return {
            status: 200,
            body: { agency: outcome.agency, applications: outcome.items, total: outcome.total, nextCursor: outcome.nextCursor },
          };
        });
      }),
    },
    {
      method: 'GET',
      path: VENUE_ROSTER_PATH,
      handler: withAuth(verify, { kind: 'officer' }, (ctx, principal): Promise<HttpResult> => {
        if (!principalHasPermission(principal, 'admission.gate') && !principalHasPermission(principal, 'field.score.sync')) {
          throw new HttpError(403, 'PERMISSION_DENIED', 'Your role does not permit this operation.');
        }
        return guarded(async () => {
          const outcome = await service.venueRoster(principal, parseRosterQuery(ctx.query));
          if (outcome.kind === 'FORBIDDEN') return FORBIDDEN;
          if (outcome.kind === 'NOT_FOUND') return NOT_FOUND;
          const v = outcome.value;
          return {
            status: 200,
            body: {
              agency: outcome.agency,
              venue: {
                venueName: v.venueName,
                district: v.district,
                examDate: v.examDate,
                reportingTimeHour: v.reportingTimeHour,
                capacityLimit: v.capacityLimit,
                registeredCount: v.registeredCount,
              },
              // Allowlisted field by field: nothing else on a row can reach the wire.
              candidates: v.entries.map((e) => ({
                processingCode: e.processingCode,
                category: e.category,
                status: e.status,
                admission: e.admission,
                requiredPaperItems: e.requiredPaperItems,
              })),
              truncated: v.truncated,
            },
          };
        });
      }),
    },
  ];
}

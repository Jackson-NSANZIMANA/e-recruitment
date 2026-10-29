// identity-service — GET /v1/applicants/me/identity (ADR-049, ADR-FE-019).
// The subject is the SESSION; there is nothing to ask with. Only a VERIFIED identity is returned.
import { logError } from '@usrp/shared-logging';
import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import type { ApplicantAuthService } from '../../application/applicant-auth.service.js';
import type { OwnIdentityReader } from '../own-identity.pg-reader.js';
import { authHeader, authenticate } from './applicant-auth.controller.js';

export const ME_IDENTITY_PATH = '/v1/applicants/me/identity';

export function ownIdentityRoutes(service: ApplicantAuthService, reader: OwnIdentityReader): Route[] {
  return [
    {
      method: 'GET',
      path: ME_IDENTITY_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const applicantId = await authenticate(authHeader(ctx.headers['authorization']), service);
        let view;
        try {
          view = await reader.read(applicantId);
        } catch (error) {
          logError('own_identity_read_failed', { reason: error instanceof Error ? error.name : 'unknown' });
          throw new HttpError(503, 'IDENTITY_UNAVAILABLE', 'The identity record could not be read.');
        }
        if (view === null || view.identityStatus !== 'VERIFIED') return { status: 404, body: { status: 'NOT_FOUND' } };
        return {
          status: 200,
          body: { fullName: view.fullName, sex: view.sex, dateOfBirth: view.dateOfBirth, homeDistrict: view.homeDistrict, homeProvince: view.homeProvince },
        };
      },
    },
  ];
}

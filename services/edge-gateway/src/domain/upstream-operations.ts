// ══════════════════════════════════════════════════════════════════
// edge-gateway — The APPROVED UPSTREAM CATALOGUE
//
// Every upstream route this tier may reach, transcribed from the running
// controllers at backend commit 2b1814fd5ef1ea8d71625d2b58e9b75a16c3155e. Path
// constants are duplicated here ON PURPOSE rather than imported: importing
// application-service's constants would make the edge depend on that service's
// package, and the whole point of a catalogue is that adding a target is a
// reviewable edit to a named allowlist. The contract selfcheck asserts these
// strings still match the controllers.
//
// An edge operation may reach NOTHING that is not in this file.
// ══════════════════════════════════════════════════════════════════

/** The four upstream services the edge composes. There is no fifth. */
export type UpstreamService = 'iam' | 'identity' | 'application' | 'field-sync';

export interface UpstreamOperation {
  readonly id: string;
  readonly service: UpstreamService;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /**
   * What credential the upstream route demands.
   *
   *   none              public upstream (OTP request/verify)
   *   officer-jwt       Ed25519 bearer minted by iam-service
   *   applicant-opaque  the revocable 32-byte DB session token (ADR-018)
   *
   * The edge holds both human credentials and forwards exactly the one the
   * target requires. It holds NO client-credentials secret of its own: every
   * route below is reachable with a credential the human already presented,
   * which is why no EDGE_CLIENT_ID/SECRET exists anywhere in this service.
   */
  readonly credential: 'none' | 'officer-jwt' | 'applicant-opaque';
}

function op(
  id: string,
  service: UpstreamService,
  method: 'GET' | 'POST',
  path: string,
  credential: UpstreamOperation['credential'],
): UpstreamOperation {
  return Object.freeze({ id, service, method, path, credential });
}

export const UPSTREAM = Object.freeze({
  // iam-service — services/iam-service/src/adapters/http/officer-login.controller.ts
  officerLogin: op('officerLogin', 'iam', 'POST', '/v1/auth/officer/login', 'none'),

  // identity-service — applicant-auth.controller.ts
  otpRequest: op('otpRequest', 'identity', 'POST', '/v1/applicants/auth/otp/request', 'none'),
  otpVerify: op('otpVerify', 'identity', 'POST', '/v1/applicants/auth/otp/verify', 'none'),
  applicantLogout: op('applicantLogout', 'identity', 'POST', '/v1/applicants/auth/logout', 'applicant-opaque'),
  myApplications: op('myApplications', 'identity', 'GET', '/v1/applicants/me/applications', 'applicant-opaque'),
  myWithdraw: op('myWithdraw', 'identity', 'POST', '/v1/applicants/me/applications/withdraw', 'applicant-opaque'),

  // identity-service — erasure-request.controller.ts (session-authenticated half)
  myErasureRequestGet: op('myErasureRequestGet', 'identity', 'GET', '/v1/applicants/me/erasure-request', 'applicant-opaque'),
  myErasureRequestFile: op('myErasureRequestFile', 'identity', 'POST', '/v1/applicants/me/erasure-request', 'applicant-opaque'),

  // identity-service — verify-identity.controller.ts (service-internal, BROKERED per ADR-012 D1)
  verifyIdentity: op('verifyIdentity', 'identity', 'POST', '/v1/identities/verify', 'officer-jwt'),

  // application-service — list-applications.controller.ts
  listApplications: op('listApplications', 'application', 'GET', '/v1/applications', 'officer-jwt'),
  amberQueue: op('amberQueue', 'application', 'GET', '/v1/applications/amber-queue', 'officer-jwt'),
  applicationById: op('applicationById', 'application', 'GET', '/v1/applications/by-id', 'officer-jwt'),
  statusHistory: op('statusHistory', 'application', 'GET', '/v1/applications/status-history', 'officer-jwt'),

  // application-service — officer-transitions.controller.ts
  medicalReview: op('medicalReview', 'application', 'POST', '/v1/applications/medical-review', 'officer-jwt'),
  finalDecision: op('finalDecision', 'application', 'POST', '/v1/applications/final-decision', 'officer-jwt'),
  accept: op('accept', 'application', 'POST', '/v1/applications/accept', 'officer-jwt'),
  adjudicate: op('adjudicate', 'application', 'POST', '/v1/applications/adjudicate', 'officer-jwt'),

  // application-service — walk-in.controller.ts
  walkInRegister: op('walkInRegister', 'application', 'POST', '/v1/applications/walk-in/register', 'officer-jwt'),
  walkInVet: op('walkInVet', 'application', 'POST', '/v1/applications/walk-in/vet', 'officer-jwt'),

  // field-sync-service — enroll-device / sync-scores / resolve-conflict controllers
  enrollDevice: op('enrollDevice', 'field-sync', 'POST', '/v1/field-sync/devices', 'officer-jwt'),
  syncScores: op('syncScores', 'field-sync', 'POST', '/v1/field-sync/scores', 'officer-jwt'),
  resolveConflict: op('resolveConflict', 'field-sync', 'POST', '/v1/field-sync/conflicts/resolve', 'officer-jwt'),
} as const);

export type UpstreamOperationId = keyof typeof UPSTREAM;

/**
 * The upstream routes that are `service-internal` and are nevertheless brokered
 * to the browser. ONE entry, and it costs a reviewer's signature to add a
 * second — the same auditable-allowlist posture the frontend's BROKERED set has.
 */
export const BROKERED_SERVICE_INTERNAL: readonly UpstreamOperationId[] = Object.freeze([
  'verifyIdentity',
]);

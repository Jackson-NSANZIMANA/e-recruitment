// ══════════════════════════════════════════════════════════════════
// edge-gateway — The EDGE OPERATION REGISTRY
//
// The single declaration of the browser boundary: 26 operations, each naming its
// exact path, method, required session kind, CSRF obligation, body cap, retry
// disposition and the approved upstream operation(s) it fronts.
//
// DATA ONLY — no handlers, no imports from the adapter layer. That is what lets
// selfcheck/verify-edge-contract.ts assert the whole boundary without booting a
// process, opening a socket, or touching Postgres.
//
// Route composition in src/routes.ts is keyed by `Record<EdgeOperationId, …>`,
// so adding an operation here and forgetting its handler is a TYPE ERROR, not a
// 404 discovered in production.
//
// THREE THINGS ARE DELIBERATELY NOT EXPRESSIBLE HERE:
//
//   • An agency. No path segment, query parameter or body field in this file
//     carries one. It is read from the verified officer session, which makes
//     it server-authoritative by construction rather than by validation.
//   • A path parameter. shared-http matches paths EXACTLY (ADR-005); a client
//     that builds `/applications/{id}` type-checks and 404s for every input.
//   • PATCH or DELETE. Transitions are separate typed POSTs with separate
//     authority. A generic status write is a broken authorization model.
// ══════════════════════════════════════════════════════════════════

import { UPSTREAM, type UpstreamOperation, type UpstreamOperationId } from './upstream-operations.js';

/** Which session kind an operation admits. `anonymous` means "no session required". */
export type SessionRequirement = 'anonymous' | 'officer' | 'applicant';

export interface EdgeOperation {
  readonly operationId: string;
  readonly method: 'GET' | 'POST';
  /** Exact path. Always under /edge/v1/. */
  readonly path: string;
  readonly session: SessionRequirement;
  /** Whether `x-csrf-token` is validated. */
  readonly csrf: boolean;
  /** Per-route body cap. Raised only where a batch genuinely needs it. */
  readonly maxBodyBytes: number;
  /** Whether the FRONTEND may retry this operation on a 503. */
  readonly retryOnG2G: boolean;
  /** Reachable without a session by design. */
  readonly publicAllowlist: boolean;
  readonly idempotentWithoutSession?: boolean;
  /** The approved upstream operation(s). Session-local operations front none. */
  readonly upstream: readonly UpstreamOperation[];
  readonly composition: 'single' | 'composed' | 'local';
  readonly compositionReason?: string;
}

const KIB = 1_024;
const SMALL_BODY = 8 * KIB;
const FIELD_SYNC_BATCH_BODY = 512 * KIB;

export const EDGE_OPERATIONS = Object.freeze({
  readSession: { operationId: 'readSession', method: 'GET', path: '/edge/v1/session', session: 'anonymous', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [], composition: 'local' },
  refreshSession: { operationId: 'refreshSession', method: 'POST', path: '/edge/v1/session/refresh', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [], composition: 'local' },
  officerLogin: { operationId: 'officerLogin', method: 'POST', path: '/edge/v1/auth/officer/login', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [UPSTREAM.officerLogin], composition: 'single' },
  officerLogout: { operationId: 'officerLogout', method: 'POST', path: '/edge/v1/auth/officer/logout', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, idempotentWithoutSession: true, upstream: [], composition: 'local' },
  requestApplicantOtp: { operationId: 'requestApplicantOtp', method: 'POST', path: '/edge/v1/auth/applicant/otp/request', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: true, upstream: [UPSTREAM.otpRequest], composition: 'single' },
  verifyApplicantOtp: { operationId: 'verifyApplicantOtp', method: 'POST', path: '/edge/v1/auth/applicant/otp/verify', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [UPSTREAM.otpVerify], composition: 'single' },
  logoutApplicant: { operationId: 'logoutApplicant', method: 'POST', path: '/edge/v1/auth/applicant/logout', session: 'applicant', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, idempotentWithoutSession: true, upstream: [UPSTREAM.applicantLogout], composition: 'single' },
  listApplications: { operationId: 'listApplications', method: 'GET', path: '/edge/v1/applications', session: 'officer', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.listApplications], composition: 'single' },
  listAmberQueue: { operationId: 'listAmberQueue', method: 'GET', path: '/edge/v1/applications/amber-queue', session: 'officer', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.amberQueue], composition: 'single' },
  findApplicationById: { operationId: 'findApplicationById', method: 'GET', path: '/edge/v1/applications/by-id', session: 'officer', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.applicationById], composition: 'single' },
  getApplicationDetail: { operationId: 'getApplicationDetail', method: 'GET', path: '/edge/v1/applications/detail', session: 'officer', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.applicationById, UPSTREAM.statusHistory], composition: 'composed', compositionReason: 'The Procedural Justice view renders the record and the decision trail together.' },
  getApplicationStatusHistory: { operationId: 'getApplicationStatusHistory', method: 'GET', path: '/edge/v1/applications/status-history', session: 'officer', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.statusHistory], composition: 'single' },
  recordMedicalReview: { operationId: 'recordMedicalReview', method: 'POST', path: '/edge/v1/applications/medical-review', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.medicalReview], composition: 'single' },
  recordFinalDecision: { operationId: 'recordFinalDecision', method: 'POST', path: '/edge/v1/applications/final-decision', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.finalDecision], composition: 'single' },
  acceptApplication: { operationId: 'acceptApplication', method: 'POST', path: '/edge/v1/applications/accept', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.accept], composition: 'single' },
  adjudicateApplication: { operationId: 'adjudicateApplication', method: 'POST', path: '/edge/v1/applications/adjudicate', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.adjudicate], composition: 'single' },
  registerWalkIn: { operationId: 'registerWalkIn', method: 'POST', path: '/edge/v1/applications/walk-in/register', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.walkInRegister], composition: 'single' },
  vetWalkIn: { operationId: 'vetWalkIn', method: 'POST', path: '/edge/v1/applications/walk-in/vet', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.walkInVet], composition: 'single' },
  verifyIdentity: { operationId: 'verifyIdentity', method: 'POST', path: '/edge/v1/identities/verify', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.verifyIdentity], composition: 'single' },
  listMyApplications: { operationId: 'listMyApplications', method: 'GET', path: '/edge/v1/me/applications', session: 'applicant', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.myApplications], composition: 'single' },
  withdrawMyApplication: { operationId: 'withdrawMyApplication', method: 'POST', path: '/edge/v1/me/applications/withdraw', session: 'applicant', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.myWithdraw], composition: 'single' },
  getMyErasureRequest: { operationId: 'getMyErasureRequest', method: 'GET', path: '/edge/v1/me/erasure-request', session: 'applicant', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.myErasureRequestGet], composition: 'single' },
  fileMyErasureRequest: { operationId: 'fileMyErasureRequest', method: 'POST', path: '/edge/v1/me/erasure-request', session: 'applicant', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.myErasureRequestFile], composition: 'single' },
  enrollFieldDevice: { operationId: 'enrollFieldDevice', method: 'POST', path: '/edge/v1/field-sync/devices', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.enrollDevice], composition: 'single' },
  syncFieldScores: { operationId: 'syncFieldScores', method: 'POST', path: '/edge/v1/field-sync/scores', session: 'officer', csrf: true, maxBodyBytes: FIELD_SYNC_BATCH_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.syncScores], composition: 'single' },
  resolveFieldSyncConflict: { operationId: 'resolveFieldSyncConflict', method: 'POST', path: '/edge/v1/field-sync/conflicts/resolve', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.resolveConflict], composition: 'single' },
} as const satisfies Record<string, EdgeOperation>);

export type EdgeOperationId = keyof typeof EDGE_OPERATIONS;
export const EDGE_OPERATION_IDS: readonly EdgeOperationId[] = Object.freeze(Object.keys(EDGE_OPERATIONS) as EdgeOperationId[]);
export function edgeOperation(id: EdgeOperationId): EdgeOperation { return EDGE_OPERATIONS[id]; }
export const PUBLIC_ALLOWLIST: readonly EdgeOperationId[] = Object.freeze(EDGE_OPERATION_IDS.filter((id) => EDGE_OPERATIONS[id].publicAllowlist));
export const REACHABLE_UPSTREAM_IDS: readonly UpstreamOperationId[] = Object.freeze(EDGE_OPERATION_IDS.flatMap((id) => EDGE_OPERATIONS[id].upstream.map((u) => u.id as UpstreamOperationId)));

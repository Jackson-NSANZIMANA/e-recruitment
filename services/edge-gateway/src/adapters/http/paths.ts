// ══════════════════════════════════════════════════════════════════
// edge-gateway — The edge route table
//
// PROVENANCE: every path, method and session kind below is the server side of
// `EDGE_OPERATIONS` in the frontend's packages/api-client/src/paths.ts, which
// the frontend asserts against @usrp/contracts at module load. The frontend is
// authoritative for the CLIENT contract (path, method, session, retry); the
// upstream CONTROLLERS are authoritative for request and response bodies.
// Where the two disagree, docs/CONTRACT-DEVIATIONS.md records which won and why.
//
// EXACT PATHS, NO PARAMETERS. shared-http matches paths exactly and has no
// param syntax (ADR-005), so single-record reads take `?applicationId=`. The
// old frontend's `GET /applications/${id}` type-checked perfectly and 404'd in
// production for every input.
// ══════════════════════════════════════════════════════════════════

export const EDGE_PREFIX = '/edge/v1';

export const EDGE_PATHS = {
  session: `${EDGE_PREFIX}/session`,
  sessionRefresh: `${EDGE_PREFIX}/session/refresh`,
  officerLogin: `${EDGE_PREFIX}/auth/officer/login`,
  officerLogout: `${EDGE_PREFIX}/auth/officer/logout`,
  otpRequest: `${EDGE_PREFIX}/auth/applicant/otp/request`,
  otpVerify: `${EDGE_PREFIX}/auth/applicant/otp/verify`,
  applicantLogout: `${EDGE_PREFIX}/auth/applicant/logout`,
  applications: `${EDGE_PREFIX}/applications`,
  amberQueue: `${EDGE_PREFIX}/applications/amber-queue`,
  applicationById: `${EDGE_PREFIX}/applications/by-id`,
  applicationDetail: `${EDGE_PREFIX}/applications/detail`,
  statusHistory: `${EDGE_PREFIX}/applications/status-history`,
  medicalReview: `${EDGE_PREFIX}/applications/medical-review`,
  finalDecision: `${EDGE_PREFIX}/applications/final-decision`,
  accept: `${EDGE_PREFIX}/applications/accept`,
  adjudicate: `${EDGE_PREFIX}/applications/adjudicate`,
  walkInRegister: `${EDGE_PREFIX}/applications/walk-in/register`,
  walkInVet: `${EDGE_PREFIX}/applications/walk-in/vet`,
  verifyIdentity: `${EDGE_PREFIX}/identities/verify`,
  myApplications: `${EDGE_PREFIX}/me/applications`,
  withdrawMyApplication: `${EDGE_PREFIX}/me/applications/withdraw`,
  myErasureRequest: `${EDGE_PREFIX}/me/erasure-request`,
} as const;

/**
 * The PUBLIC, unauthenticated surface — an explicit four-operation allowlist.
 * A fifth entry costs a reviewer's signature, which is the point of writing it
 * as a list rather than as "routes that happen not to call the guard".
 */
export const PUBLIC_OPERATIONS: readonly string[] = [
  EDGE_PATHS.officerLogin,
  EDGE_PATHS.otpRequest,
  EDGE_PATHS.otpVerify,
  // Session introspection is anonymous BY DESIGN: the SPA must be able to tell
  // `checking` from `anonymous` on mount, or it flashes a login screen at an
  // authenticated user. It returns metadata for a session that already exists
  // and can create none.
  EDGE_PATHS.session,
];

/**
 * `verifyIdentity` is the ONE brokered service-internal upstream route
 * (ADR-012 D1 widened upstream's `withAuth` to accept officer principals on it).
 * Naming it in a one-line allowlist makes the exception an auditable line of
 * code instead of a permissive rule about what an edge may proxy.
 */
export const BROKERED_OPERATIONS: readonly string[] = [EDGE_PATHS.verifyIdentity];

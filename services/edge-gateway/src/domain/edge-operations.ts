// ══════════════════════════════════════════════════════════════════
// edge-gateway — The EDGE OPERATION REGISTRY (domain)
//
// The single declaration of the browser boundary: each operation names its
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
// THIS IS THE ONLY COPY. Until the edge homogenisation there were two
// byte-identical frozen registries (src/registry/ and src/domain/): routes.ts
// mounted one while guards.ts enforced CSRF/session rules from the other. They
// agreed only by coincidence of content, never by construction.
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

import type { Permission } from '@usrp/shared-auth';
import { UPSTREAM, type UpstreamOperation, type UpstreamOperationId } from './upstream-operations.js';

/** Which session kind an operation admits. `anonymous` means "no session required". */
export type SessionRequirement = 'anonymous' | 'officer' | 'applicant';

export interface EdgeOperation {
  readonly operationId: string;
  /**
   * The permission an OFFICER session must hold (BUILD-004 §D). Enforced here
   * before any upstream call AND again by the owning service, which is the
   * authority. Absent only for session-local operations (logout).
   */
  readonly permission?: Permission;
  /**
   * Further permissions that ALSO admit the operation (any-of with `permission`,
   * ADR-039). Used only where two posts legitimately share one read — the venue
   * roster serves the gate (`admission.gate`) and the field station
   * (`field.score.sync`). Absent means `permission` alone.
   */
  readonly alsoPermission?: readonly Permission[];
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
const CAMPAIGN_POLICY_BODY = 32 * KIB;
const FIELD_SYNC_BATCH_BODY = 512 * KIB;
/** FORENSICS_MAX_FILE_SIZE_MB (10) + multipart framing headroom. */
const DOCUMENT_UPLOAD_BODY = 10 * 1_024 * KIB + 8 * KIB;
/** ADR-037: a flat signed evidence record. Small on purpose — no image fits. */
const BIOMETRIC_EVIDENCE_BODY = 4 * KIB;

export const EDGE_OPERATIONS = Object.freeze({
  readSession: { operationId: 'readSession', method: 'GET', path: '/edge/v1/session', session: 'anonymous', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [], composition: 'local' },
  refreshSession: { operationId: 'refreshSession', method: 'POST', path: '/edge/v1/session/refresh', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [], composition: 'local' },
  officerLogin: { operationId: 'officerLogin', method: 'POST', path: '/edge/v1/auth/officer/login', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [UPSTREAM.officerLogin], composition: 'single' },
  officerLogout: { operationId: 'officerLogout', method: 'POST', path: '/edge/v1/auth/officer/logout', session: 'officer', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, idempotentWithoutSession: true, upstream: [], composition: 'local' },
  beginApplicantOnboarding: { operationId: 'beginApplicantOnboarding', method: 'POST', path: '/edge/v1/auth/applicant/identity', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [UPSTREAM.onboardingBegin], composition: 'single' },
  requestApplicantOtp: { operationId: 'requestApplicantOtp', method: 'POST', path: '/edge/v1/auth/applicant/otp/request', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: true, upstream: [UPSTREAM.otpRequest], composition: 'single' },
  verifyApplicantOtp: { operationId: 'verifyApplicantOtp', method: 'POST', path: '/edge/v1/auth/applicant/otp/verify', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [UPSTREAM.otpVerify], composition: 'single' },
  logoutApplicant: { operationId: 'logoutApplicant', method: 'POST', path: '/edge/v1/auth/applicant/logout', session: 'applicant', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, idempotentWithoutSession: true, upstream: [UPSTREAM.applicantLogout], composition: 'single' },
  createCampaign: { operationId: 'createCampaign', method: 'POST', path: '/edge/v1/campaigns', session: 'officer', permission: 'campaign.create', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.campaignCreate], composition: 'single' },
  createCampaignPolicy: { operationId: 'createCampaignPolicy', method: 'POST', path: '/edge/v1/campaigns/policy', session: 'officer', permission: 'campaign.policy.create', csrf: true, maxBodyBytes: CAMPAIGN_POLICY_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.campaignPolicy], composition: 'single' },
  configureCampaignSession: { operationId: 'configureCampaignSession', method: 'POST', path: '/edge/v1/campaigns/session', session: 'officer', permission: 'campaign.session.configure', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.campaignSession], composition: 'single' },
  publishCampaign: { operationId: 'publishCampaign', method: 'POST', path: '/edge/v1/campaigns/publish', session: 'officer', permission: 'campaign.publish', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.campaignPublish], composition: 'single' },
  closeCampaignRegistration: { operationId: 'closeCampaignRegistration', method: 'POST', path: '/edge/v1/campaigns/registration-close', session: 'officer', permission: 'campaign.registration.close', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.campaignRegistrationClose], composition: 'single' },
  completeCampaign: { operationId: 'completeCampaign', method: 'POST', path: '/edge/v1/campaigns/complete', session: 'officer', permission: 'campaign.complete', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.campaignComplete], composition: 'single' },
  cancelCampaign: { operationId: 'cancelCampaign', method: 'POST', path: '/edge/v1/campaigns/cancel', session: 'officer', permission: 'campaign.cancel', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.campaignCancel], composition: 'single' },
  listCampaigns: { operationId: 'listCampaigns', method: 'GET', path: '/edge/v1/campaigns', session: 'anonymous', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: true, upstream: [UPSTREAM.publicCampaignList], composition: 'single' },
  getCampaignDetail: { operationId: 'getCampaignDetail', method: 'GET', path: '/edge/v1/campaigns/detail', session: 'anonymous', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: true, upstream: [UPSTREAM.publicCampaignDetail], composition: 'single' },
  listApplications: { operationId: 'listApplications', method: 'GET', path: '/edge/v1/applications', session: 'officer', permission: 'application.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.listApplications], composition: 'single' },
  listAmberQueue: { operationId: 'listAmberQueue', method: 'GET', path: '/edge/v1/applications/amber-queue', session: 'officer', permission: 'adjudication.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.amberQueue], composition: 'single' },
  findApplicationById: { operationId: 'findApplicationById', method: 'GET', path: '/edge/v1/applications/by-id', session: 'officer', permission: 'application.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.applicationById], composition: 'single' },
  getApplicationDetail: { operationId: 'getApplicationDetail', method: 'GET', path: '/edge/v1/applications/detail', session: 'officer', permission: 'application.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.applicationById, UPSTREAM.statusHistory], composition: 'composed', compositionReason: 'The Procedural Justice view renders the record and the decision trail together.' },
  getApplicationStatusHistory: { operationId: 'getApplicationStatusHistory', method: 'GET', path: '/edge/v1/applications/status-history', session: 'officer', permission: 'application.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.statusHistory], composition: 'single' },
  recordMedicalReview: { operationId: 'recordMedicalReview', method: 'POST', path: '/edge/v1/applications/medical-review', session: 'officer', permission: 'medical.review', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.medicalReview], composition: 'single' },
  recordFinalDecision: { operationId: 'recordFinalDecision', method: 'POST', path: '/edge/v1/applications/final-decision', session: 'officer', permission: 'decision.final', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.finalDecision], composition: 'single' },
  acceptApplication: { operationId: 'acceptApplication', method: 'POST', path: '/edge/v1/applications/accept', session: 'officer', permission: 'application.accept', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.accept], composition: 'single' },
  adjudicateApplication: { operationId: 'adjudicateApplication', method: 'POST', path: '/edge/v1/applications/adjudicate', session: 'officer', permission: 'adjudication.decide', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.adjudicate], composition: 'single' },
  // ADR-032 advisory checklist + venue verification by the check-in post.
  getDocumentChecklist: { operationId: 'getDocumentChecklist', method: 'GET', path: '/edge/v1/applications/document-checklist', session: 'officer', permission: 'application.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.documentChecklist], composition: 'single' },
  verifyDocumentAtVenue: { operationId: 'verifyDocumentAtVenue', method: 'POST', path: '/edge/v1/applications/documents/verify-at-venue', session: 'officer', permission: 'document.verify.venue', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.verifyDocumentAtVenue], composition: 'single' },
  registerWalkIn: { operationId: 'registerWalkIn', method: 'POST', path: '/edge/v1/applications/walk-in/register', session: 'officer', permission: 'walkin.register', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.walkInRegister], composition: 'single' },
  vetWalkIn: { operationId: 'vetWalkIn', method: 'POST', path: '/edge/v1/applications/walk-in/vet', session: 'officer', permission: 'walkin.vet', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.walkInVet], composition: 'single' },
  admitAtGate: { operationId: 'admitAtGate', method: 'POST', path: '/edge/v1/gate/admissions', session: 'officer', permission: 'admission.gate', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.admitAtGate], composition: 'single' },
  verifyIdentity: { operationId: 'verifyIdentity', method: 'POST', path: '/edge/v1/identities/verify', session: 'officer', permission: 'identity.verify', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.verifyIdentity], composition: 'single' },
  listMyApplications: { operationId: 'listMyApplications', method: 'GET', path: '/edge/v1/me/applications', session: 'applicant', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.myApplications], composition: 'single' },
  // The browser's submit (ADR-027). Same collection path as the list, POST
  // instead of GET. NOT retryable at this tier: the edge never re-sends a
  // write; the citizen's own Idempotency-Key makes their retry safe, and
  // `retryOnG2G: false` is what keeps the retry THEIR decision.
  submitMyApplication: { operationId: 'submitMyApplication', method: 'POST', path: '/edge/v1/me/applications', session: 'applicant', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.mySubmit], composition: 'single' },
  // The citizen's document upload (BUILD-002). Multipart, composed server-side
  // before forwarding; NOT retryable (the edge never re-sends a write).
  // ADR-033: the downloadable exam QR. Retry-safe read; a credential, so no-store (shared-http default).
  getMyExamInvitation: { operationId: 'getMyExamInvitation', method: 'GET', path: '/edge/v1/me/applications/exam-invitation', session: 'applicant', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.myExamInvitation], composition: 'single' },
  getMyDocumentChecklist: { operationId: 'getMyDocumentChecklist', method: 'GET', path: '/edge/v1/me/applications/document-checklist', session: 'applicant', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.myDocumentChecklist], composition: 'single' },
  uploadMyDocument: { operationId: 'uploadMyDocument', method: 'POST', path: '/edge/v1/me/applications/documents', session: 'applicant', csrf: true, maxBodyBytes: DOCUMENT_UPLOAD_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.myDocumentUpload], composition: 'single' },
  withdrawMyApplication: { operationId: 'withdrawMyApplication', method: 'POST', path: '/edge/v1/me/applications/withdraw', session: 'applicant', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.myWithdraw], composition: 'single' },
  getMyErasureRequest: { operationId: 'getMyErasureRequest', method: 'GET', path: '/edge/v1/me/erasure-request', session: 'applicant', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.myErasureRequestGet], composition: 'single' },
  fileMyErasureRequest: { operationId: 'fileMyErasureRequest', method: 'POST', path: '/edge/v1/me/erasure-request', session: 'applicant', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.myErasureRequestFile], composition: 'single' },
  enrollFieldDevice: { operationId: 'enrollFieldDevice', method: 'POST', path: '/edge/v1/field-sync/devices', session: 'officer', permission: 'field.device.enroll', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.enrollDevice], composition: 'single' },
  syncFieldScores: { operationId: 'syncFieldScores', method: 'POST', path: '/edge/v1/field-sync/scores', session: 'officer', permission: 'field.score.sync', csrf: true, maxBodyBytes: FIELD_SYNC_BATCH_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.syncScores], composition: 'single' },
  resolveFieldSyncConflict: { operationId: 'resolveFieldSyncConflict', method: 'POST', path: '/edge/v1/field-sync/conflicts/resolve', session: 'officer', permission: 'field.conflict.resolve', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.resolveConflict], composition: 'single' },
  // S09 device fleet (ADR-036 addendum "S09 device management"): the supervisor's
  // and the agency administrator's view of the tablets. A revocation is never retried.
  listFieldDevices: { operationId: 'listFieldDevices', method: 'GET', path: '/edge/v1/field-sync/devices', session: 'officer', permission: 'field.device.manage', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.fleetList], composition: 'single' },
  assignDeviceToVenueDay: { operationId: 'assignDeviceToVenueDay', method: 'POST', path: '/edge/v1/field-sync/devices/assign', session: 'officer', permission: 'field.device.manage', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.fleetAssign], composition: 'single' },
  revokeFieldDevice: { operationId: 'revokeFieldDevice', method: 'POST', path: '/edge/v1/field-sync/devices/revoke', session: 'officer', permission: 'field.device.manage', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.fleetRevoke], composition: 'single' },
  getVenueLiveCounts: { operationId: 'getVenueLiveCounts', method: 'GET', path: '/edge/v1/gate/live-counts', session: 'officer', permission: 'field.score.sync', alsoPermission: ['field.device.manage'], csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.venueLiveCounts], composition: 'single' },
  // ADR-036 officer lifecycle: agency_admin over officers of the session's own
  // agency. No write is retryable (the one-time code is shown once, by releaseOfficerActivation, to a second administrator).
  listOfficers: { operationId: 'listOfficers', method: 'GET', path: '/edge/v1/officers', session: 'officer', permission: 'officer.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.officerList], composition: 'single' },
  createOfficer: { operationId: 'createOfficer', method: 'POST', path: '/edge/v1/officers', session: 'officer', permission: 'officer.create', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.officerCreate], composition: 'single' },
  reissueOfficerActivation: { operationId: 'reissueOfficerActivation', method: 'POST', path: '/edge/v1/officers/activation/reissue', session: 'officer', permission: 'officer.create', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.officerReissueActivation], composition: 'single' },
  releaseOfficerActivation: { operationId: 'releaseOfficerActivation', method: 'POST', path: '/edge/v1/officers/activation/release', session: 'officer', permission: 'officer.create', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.officerReleaseActivation], composition: 'single' },
  assignOfficerPosts: { operationId: 'assignOfficerPosts', method: 'POST', path: '/edge/v1/officers/posts', session: 'officer', permission: 'officer.posts.assign', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.officerAssignPosts], composition: 'single' },
  disableOfficer: { operationId: 'disableOfficer', method: 'POST', path: '/edge/v1/officers/disable', session: 'officer', permission: 'officer.disable', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.officerDisable], composition: 'single' },
  enableOfficer: { operationId: 'enableOfficer', method: 'POST', path: '/edge/v1/officers/enable', session: 'officer', permission: 'officer.disable', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.officerEnable], composition: 'single' },
  revokeOfficerSessions: { operationId: 'revokeOfficerSessions', method: 'POST', path: '/edge/v1/officers/sessions/revoke', session: 'officer', permission: 'officer.sessions.revoke', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.officerRevokeSessions], composition: 'single' },
  // ADR-039 operational read models. Agency-scoped officer reads; no write,
  // all retry-safe. `searchApplications` is the versioned successor of
  // `listApplications` (which keeps its v1 shape for compatibility).
  listAgencyCampaigns: { operationId: 'listAgencyCampaigns', method: 'GET', path: '/edge/v1/campaigns/admin', session: 'officer', permission: 'campaign.read.admin', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.adminCampaignList], composition: 'single' },
  getCampaignAdminDetail: { operationId: 'getCampaignAdminDetail', method: 'GET', path: '/edge/v1/campaigns/admin/detail', session: 'officer', permission: 'campaign.read.admin', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.adminCampaignDetail], composition: 'single' },
  searchApplications: { operationId: 'searchApplications', method: 'GET', path: '/edge/v1/applications/search', session: 'officer', permission: 'application.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.searchApplications], composition: 'single' },
  getVenueRoster: { operationId: 'getVenueRoster', method: 'GET', path: '/edge/v1/gate/roster', session: 'officer', permission: 'admission.gate', alsoPermission: ['field.score.sync'], csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.venueRoster], composition: 'single' },
  // ADR-039: the DPO's queue and decision. EXECUTE resolves the applicant from the
  // queue server-side, so the browser never holds an applicant id.
  listErasureRequests: { operationId: 'listErasureRequests', method: 'GET', path: '/edge/v1/erasure-requests', session: 'officer', permission: 'erasure.queue.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.erasureQueue], composition: 'single' },
  decideErasureRequest: { operationId: 'decideErasureRequest', method: 'POST', path: '/edge/v1/erasure-requests/decision', session: 'officer', permission: 'erasure.decide', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.erasureDecline, UPSTREAM.erasureQueue, UPSTREAM.erasureExecute], composition: 'composed', compositionReason: 'EXECUTE must name the applicant to the gated erasure road without ever showing the browser an applicant id.' },
  // The officer redeems the one-time code and sets their password. Anonymous
  // (no session yet), CSRF double-submit, rate-limited like login.
  activateOfficer: { operationId: 'activateOfficer', method: 'POST', path: '/edge/v1/auth/officer/activate', session: 'anonymous', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: true, upstream: [UPSTREAM.officerActivate], composition: 'single' },
  // ADR-037: biometric identity evidence — evidence, never a verdict.
  getBiometricPolicy: { operationId: 'getBiometricPolicy', method: 'GET', path: '/edge/v1/gate/biometric-policy', session: 'officer', permission: 'biometric.verify', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.biometricPolicy], composition: 'single' },
  recordBiometricEvidence: { operationId: 'recordBiometricEvidence', method: 'POST', path: '/edge/v1/gate/biometric-evidence', session: 'officer', permission: 'biometric.verify', csrf: true, maxBodyBytes: BIOMETRIC_EVIDENCE_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.biometricEvidenceRecord], composition: 'single' },
  getBiometricEvidence: { operationId: 'getBiometricEvidence', method: 'GET', path: '/edge/v1/applications/biometric-evidence', session: 'officer', permission: 'biometric.evidence.read', csrf: false, maxBodyBytes: SMALL_BODY, retryOnG2G: true, publicAllowlist: false, upstream: [UPSTREAM.biometricEvidenceRead], composition: 'single' },
  confirmManualIdentity: { operationId: 'confirmManualIdentity', method: 'POST', path: '/edge/v1/gate/manual-identity', session: 'officer', permission: 'identity.manual.confirm', csrf: true, maxBodyBytes: SMALL_BODY, retryOnG2G: false, publicAllowlist: false, upstream: [UPSTREAM.manualIdentityConfirm], composition: 'single' },
} as const satisfies Record<string, EdgeOperation>);

export type EdgeOperationId = keyof typeof EDGE_OPERATIONS;
export const EDGE_OPERATION_IDS: readonly EdgeOperationId[] = Object.freeze(Object.keys(EDGE_OPERATIONS) as EdgeOperationId[]);
export function edgeOperation(id: EdgeOperationId): EdgeOperation { return EDGE_OPERATIONS[id]; }
export const PUBLIC_ALLOWLIST: readonly EdgeOperationId[] = Object.freeze(EDGE_OPERATION_IDS.filter((id) => EDGE_OPERATIONS[id].publicAllowlist));
export const REACHABLE_UPSTREAM_IDS: readonly UpstreamOperationId[] = Object.freeze(EDGE_OPERATION_IDS.flatMap((id) => EDGE_OPERATIONS[id].upstream.map((u) => u.id as UpstreamOperationId)));

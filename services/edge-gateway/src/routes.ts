// ══════════════════════════════════════════════════════════════════
// edge-gateway — Route composition FROM THE REGISTRY
//
// The route table is GENERATED, never hand-listed. Method, path and body cap all
// come from the registry, so the three places they could disagree — the
// registry, the OpenAPI document and the running server — are reduced to one
// source plus two checks.
//
// `HANDLERS` is typed `Record<EdgeOperationId, RouteHandler>`. That single
// annotation is the whole guarantee: register an operation and forget its
// handler and the build fails, rather than a browser discovering a 404 that the
// OpenAPI promised would work.
//
// There is ONE registry (src/domain/edge-operations.ts). routes.ts and guards.ts
// read the same object, so "mounted" and "enforced" can no longer disagree.
// ══════════════════════════════════════════════════════════════════

import type { Route, RouteHandler } from '@usrp/shared-http';
import {
  EDGE_OPERATION_IDS,
  edgeOperation,
  type EdgeOperationId,
} from './domain/edge-operations.js';
import type { EdgeDeps } from './adapters/http/guards.js';
import { readSessionHandler, refreshSessionHandler } from './adapters/http/session.controller.js';
import {
  officerLoginHandler,
  officerLogoutHandler,
} from './adapters/http/officer-auth.controller.js';
import {
  beginApplicantOnboardingHandler,
  logoutApplicantHandler,
  requestApplicantOtpHandler,
  verifyApplicantOtpHandler,
} from './adapters/http/applicant-auth.controller.js';
import {
  findApplicationByIdHandler,
  getApplicationDetailHandler,
  getApplicationStatusHistoryHandler,
  listAmberQueueHandler,
  listApplicationsHandler,
} from './adapters/http/officer-reads.controller.js';
import {
  acceptApplicationHandler,
  adjudicateApplicationHandler,
  recordFinalDecisionHandler,
  recordMedicalReviewHandler,
} from './adapters/http/officer-transitions.controller.js';
import { registerWalkInHandler, vetWalkInHandler } from './adapters/http/walk-in.controller.js';
import {
  cancelCampaignHandler,
  closeCampaignRegistrationHandler,
  completeCampaignHandler,
  configureCampaignSessionHandler,
  createCampaignHandler,
  createCampaignPolicyHandler,
  listPublicCampaignsHandler,
  publicCampaignDetailHandler,
  publishCampaignHandler,
} from './adapters/http/campaigns.controller.js';
import { verifyIdentityHandler } from './adapters/http/identity.controller.js';
import { admitAtGateHandler } from './adapters/http/gate-admission.controller.js';
import { getMyExamInvitationHandler } from './adapters/http/exam-invitation.controller.js';
import {
  getDocumentChecklistHandler,
  getMyDocumentChecklistHandler,
  verifyDocumentAtVenueHandler,
} from './adapters/http/document-checklist.controller.js';
import {
  fileMyErasureRequestHandler,
  getMyErasureRequestHandler,
  listMyApplicationsHandler,
  submitMyApplicationHandler,
  uploadMyDocumentHandler,
  withdrawMyApplicationHandler,
} from './adapters/http/citizen.controller.js';
import {
  enrollFieldDeviceHandler,
  resolveFieldSyncConflictHandler,
  syncFieldScoresHandler,
} from './adapters/http/field-sync.controller.js';
import {
  assignDeviceToVenueDayHandler,
  getVenueLiveCountsHandler,
  listFieldDevicesHandler,
  revokeFieldDeviceHandler,
} from './adapters/http/fleet.controller.js';
import {
  decideErasureRequestHandler,
  getCampaignAdminDetailHandler,
  getVenueRosterHandler,
  listAgencyCampaignsHandler,
  listErasureRequestsHandler,
  searchApplicationsHandler,
} from './adapters/http/operational-reads.controller.js';
import {
  activateOfficerHandler,
  assignOfficerPostsHandler,
  createOfficerHandler,
  disableOfficerHandler,
  enableOfficerHandler,
  listOfficersHandler,
  reissueOfficerActivationHandler,
  revokeOfficerSessionsHandler,
} from './adapters/http/officer-admin.controller.js';
import {
  confirmManualIdentityHandler,
  getBiometricEvidenceHandler,
  getBiometricPolicyHandler,
  recordBiometricEvidenceHandler,
} from './adapters/http/biometric-evidence.controller.js';

/**
 * Every registered operation, bound to its handler.
 *
 * The explicit Record type is load-bearing: it is what turns "registered but
 * unimplemented" from a production 404 into a compile error.
 */
export function edgeHandlers(deps: EdgeDeps): Record<EdgeOperationId, RouteHandler> {
  return {
    readSession: readSessionHandler(deps),
    refreshSession: refreshSessionHandler(deps),

    officerLogin: officerLoginHandler(deps),
    officerLogout: officerLogoutHandler(deps),

    beginApplicantOnboarding: beginApplicantOnboardingHandler(deps),
    requestApplicantOtp: requestApplicantOtpHandler(deps),
    verifyApplicantOtp: verifyApplicantOtpHandler(deps),
    logoutApplicant: logoutApplicantHandler(deps),

    createCampaign: createCampaignHandler(deps),
    createCampaignPolicy: createCampaignPolicyHandler(deps),
    configureCampaignSession: configureCampaignSessionHandler(deps),
    publishCampaign: publishCampaignHandler(deps),
    closeCampaignRegistration: closeCampaignRegistrationHandler(deps),
    completeCampaign: completeCampaignHandler(deps),
    cancelCampaign: cancelCampaignHandler(deps),
    listCampaigns: listPublicCampaignsHandler(deps),
    getCampaignDetail: publicCampaignDetailHandler(deps),

    listApplications: listApplicationsHandler(deps),
    listAmberQueue: listAmberQueueHandler(deps),
    findApplicationById: findApplicationByIdHandler(deps),
    getApplicationDetail: getApplicationDetailHandler(deps),
    getApplicationStatusHistory: getApplicationStatusHistoryHandler(deps),

    recordMedicalReview: recordMedicalReviewHandler(deps),
    recordFinalDecision: recordFinalDecisionHandler(deps),
    acceptApplication: acceptApplicationHandler(deps),
    adjudicateApplication: adjudicateApplicationHandler(deps),

    getDocumentChecklist: getDocumentChecklistHandler(deps),
    verifyDocumentAtVenue: verifyDocumentAtVenueHandler(deps),
    admitAtGate: admitAtGateHandler(deps),
    registerWalkIn: registerWalkInHandler(deps),
    vetWalkIn: vetWalkInHandler(deps),

    verifyIdentity: verifyIdentityHandler(deps),

    listMyApplications: listMyApplicationsHandler(deps),
    submitMyApplication: submitMyApplicationHandler(deps),
    getMyExamInvitation: getMyExamInvitationHandler(deps),
    getMyDocumentChecklist: getMyDocumentChecklistHandler(deps),
    uploadMyDocument: uploadMyDocumentHandler(deps),
    withdrawMyApplication: withdrawMyApplicationHandler(deps),
    getMyErasureRequest: getMyErasureRequestHandler(deps),
    fileMyErasureRequest: fileMyErasureRequestHandler(deps),

    enrollFieldDevice: enrollFieldDeviceHandler(deps),
    syncFieldScores: syncFieldScoresHandler(deps),
    resolveFieldSyncConflict: resolveFieldSyncConflictHandler(deps),
    listFieldDevices: listFieldDevicesHandler(deps),
    assignDeviceToVenueDay: assignDeviceToVenueDayHandler(deps),
    revokeFieldDevice: revokeFieldDeviceHandler(deps),
    getVenueLiveCounts: getVenueLiveCountsHandler(deps),

    listOfficers: listOfficersHandler(deps),
    createOfficer: createOfficerHandler(deps),
    reissueOfficerActivation: reissueOfficerActivationHandler(deps),
    assignOfficerPosts: assignOfficerPostsHandler(deps),
    disableOfficer: disableOfficerHandler(deps),
    enableOfficer: enableOfficerHandler(deps),
    revokeOfficerSessions: revokeOfficerSessionsHandler(deps),
    activateOfficer: activateOfficerHandler(deps),

    listAgencyCampaigns: listAgencyCampaignsHandler(deps),
    getCampaignAdminDetail: getCampaignAdminDetailHandler(deps),
    searchApplications: searchApplicationsHandler(deps),
    getVenueRoster: getVenueRosterHandler(deps),
    listErasureRequests: listErasureRequestsHandler(deps),
    decideErasureRequest: decideErasureRequestHandler(deps),
    getBiometricPolicy: getBiometricPolicyHandler(deps),
    recordBiometricEvidence: recordBiometricEvidenceHandler(deps),
    getBiometricEvidence: getBiometricEvidenceHandler(deps),
    confirmManualIdentity: confirmManualIdentityHandler(deps),
  };
}

export function edgeRoutes(deps: EdgeDeps): readonly Route[] {
  const handlers = edgeHandlers(deps);
  return EDGE_OPERATION_IDS.map((id): Route => {
    const operation = edgeOperation(id);
    return {
      method: operation.method,
      path: operation.path,
      handler: handlers[id],
      maxBodyBytes: operation.maxBodyBytes,
    };
  });
}

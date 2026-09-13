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
// ══════════════════════════════════════════════════════════════════

import type { Route, RouteHandler } from '@usrp/shared-http';
import {
  EDGE_OPERATION_IDS,
  edgeOperation,
  type EdgeOperationId,
} from './registry/edge-operations.js';
import type { EdgeDeps } from './adapters/http/guards.js';
import { readSessionHandler, refreshSessionHandler } from './adapters/http/session.controller.js';
import {
  officerLoginHandler,
  officerLogoutHandler,
} from './adapters/http/officer-auth.controller.js';
import {
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
import { verifyIdentityHandler } from './adapters/http/identity.controller.js';
import {
  fileMyErasureRequestHandler,
  getMyErasureRequestHandler,
  listMyApplicationsHandler,
  withdrawMyApplicationHandler,
} from './adapters/http/citizen.controller.js';
import {
  enrollFieldDeviceHandler,
  resolveFieldSyncConflictHandler,
  syncFieldScoresHandler,
} from './adapters/http/field-sync.controller.js';

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

    requestApplicantOtp: requestApplicantOtpHandler(deps),
    verifyApplicantOtp: verifyApplicantOtpHandler(deps),
    logoutApplicant: logoutApplicantHandler(deps),

    listApplications: listApplicationsHandler(deps),
    listAmberQueue: listAmberQueueHandler(deps),
    findApplicationById: findApplicationByIdHandler(deps),
    getApplicationDetail: getApplicationDetailHandler(deps),
    getApplicationStatusHistory: getApplicationStatusHistoryHandler(deps),

    recordMedicalReview: recordMedicalReviewHandler(deps),
    recordFinalDecision: recordFinalDecisionHandler(deps),
    acceptApplication: acceptApplicationHandler(deps),
    adjudicateApplication: adjudicateApplicationHandler(deps),

    registerWalkIn: registerWalkInHandler(deps),
    vetWalkIn: vetWalkInHandler(deps),

    verifyIdentity: verifyIdentityHandler(deps),

    listMyApplications: listMyApplicationsHandler(deps),
    withdrawMyApplication: withdrawMyApplicationHandler(deps),
    getMyErasureRequest: getMyErasureRequestHandler(deps),
    fileMyErasureRequest: fileMyErasureRequestHandler(deps),

    enrollFieldDevice: enrollFieldDeviceHandler(deps),
    syncFieldScores: syncFieldScoresHandler(deps),
    resolveFieldSyncConflict: resolveFieldSyncConflictHandler(deps),
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

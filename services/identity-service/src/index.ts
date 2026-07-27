// ══════════════════════════════════════════════════════════════════
// @usrp/identity-service — Public API & composition root
//
// Wires the hexagonal core to its infrastructure adapters. The HTTP/
// message transport is intentionally NOT wired here yet — the next slice
// decides the framework (see docs/architecture/identity-service-slice.md).
// Callers provide the EventBus so tests can inject InMemoryEventBus and
// production can inject KafkaEventBus.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { NidaHttpGateway } from './adapters/nida.http-gateway.js';
import { PgIdentityRepository } from './adapters/identity.pg-repository.js';
import { PgErasureRepository } from './adapters/erasure.pg-repository.js';
import { PgApplicantAuthRepository } from './adapters/applicant-auth.pg-repository.js';
import { PgErasureRequestRepository } from './adapters/erasure-request.pg-repository.js';
import { ErasureRequestService } from './application/erasure-request.service.js';
import { VerifyIdentityService } from './application/verify-identity.service.js';
import { EraseIdentityService } from './application/erase-identity.service.js';
import { ProjectBiometricResultService } from './application/project-biometric-result.service.js';
import { ApplicantAuthService } from './application/applicant-auth.service.js';
import type { SmsChannel } from '@usrp/shared-sms';
import {
  APPLICANT_SESSION_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  type IdentityServiceConfig,
} from './config.js';

/** Assemble the identity use-case from config + a chosen event transport. */
export function createIdentityService(
  config: IdentityServiceConfig,
  eventBus: EventBus,
): VerifyIdentityService {
  const nida = new NidaHttpGateway({
    baseUrl: config.nida.baseUrl,
    hmacSecret: config.nida.hmacSecret,
    timeoutMs: config.nida.timeoutMs,
  });
  const repository = new PgIdentityRepository(config.security.encryptionKey);

  return new VerifyIdentityService({
    nida,
    repository,
    eventBus,
    nationalIdHmacKey: config.security.nationalIdHmacKey,
  });
}

/**
 * Assemble the biometric-result projector. identity-service owns
 * applicant_identities, so it records the biometric_* columns off the
 * biometric.result event. Separate factory to keep createIdentityService's
 * return shape (the verify use case) unchanged.
 */
export function createBiometricResultProjector(
  config: IdentityServiceConfig,
  _eventBus: EventBus,
): ProjectBiometricResultService {
  return new ProjectBiometricResultService({
    repository: new PgIdentityRepository(config.security.encryptionKey),
  });
}

/**
 * Assemble the applicant-auth use case (ADR-018): OTP to the NIDA-registered
 * phone → opaque DB session. The SmsChannel is caller-supplied so dev/proofs
 * inject LogSmsChannel and production a real telecom adapter.
 */
export function createApplicantAuthService(
  config: IdentityServiceConfig,
  eventBus: EventBus,
  sms: SmsChannel,
): ApplicantAuthService {
  return new ApplicantAuthService({
    repository: new PgApplicantAuthRepository(),
    nida: new NidaHttpGateway({
      baseUrl: config.nida.baseUrl,
      hmacSecret: config.nida.hmacSecret,
      timeoutMs: config.nida.timeoutMs,
    }),
    sms,
    eventBus,
    nationalIdHmacKey: config.security.nationalIdHmacKey,
    config: {
      otpTtlSeconds: OTP_TTL_SECONDS,
      otpMaxAttempts: OTP_MAX_ATTEMPTS,
      sessionTtlSeconds: APPLICANT_SESSION_TTL_SECONDS,
    },
  });
}

/**
 * Assemble the right-to-erasure use case (ADR-015). identity-service owns
 * applicant_identities, so it executes erasure; the repository gate (all
 * applications terminal, not accept-locked) decides lawfulness.
 */
export function createEraseIdentityService(
  _config: IdentityServiceConfig,
  eventBus: EventBus,
): EraseIdentityService {
  return new EraseIdentityService({
    repository: new PgErasureRepository(),
    eventBus,
    // ADR-020: an executed erasure stamps the citizen's pending intake row.
    requests: new PgErasureRequestRepository(),
  });
}

/**
 * Assemble the erasure request intake use case (ADR-020, owner D10): the
 * citizen files, the DPO queue answers; execution stays on the ADR-015 road.
 */
export function createErasureRequestService(
  _config: IdentityServiceConfig,
  eventBus: EventBus,
): ErasureRequestService {
  return new ErasureRequestService({
    repository: new PgErasureRequestRepository(),
    eventBus,
  });
}

// ── Re-exports ────────────────────────────────────────────────────
export {
  VERIFY_IDENTITY_PATH,
  verifyIdentityRoute,
} from './adapters/http/verify-identity.controller.js';
export { ERASURE_PATH, erasureRoute } from './adapters/http/erasure.controller.js';
export {
  ME_ERASURE_REQUEST_PATH,
  ERASURE_REQUESTS_QUEUE_PATH,
  ERASURE_REQUEST_DECLINE_PATH,
  erasureRequestRoutes,
} from './adapters/http/erasure-request.controller.js';
export { ErasureRequestService } from './application/erasure-request.service.js';
export type {
  FileErasureRequestCommand,
  DeclineErasureRequestCommand,
  ErasureRequestDeps,
} from './application/erasure-request.service.js';
export { PgErasureRequestRepository } from './adapters/erasure-request.pg-repository.js';
export type {
  ErasureRequestRepository,
  ErasureRequestRecord,
  FileRequestOutcome,
  DeclineRequestOutcome,
  DeclineRequestInput,
} from './ports/erasure-request.repository.js';
export {
  OTP_REQUEST_PATH,
  OTP_VERIFY_PATH,
  ME_APPLICATIONS_PATH,
  LOGOUT_PATH,
  applicantAuthRoutes,
} from './adapters/http/applicant-auth.controller.js';
export { ApplicantAuthService } from './application/applicant-auth.service.js';
export type {
  ApplicantAuthConfig,
  ApplicantAuthDeps,
  RequestOtpCommand,
  RequestOtpOutcome,
  VerifyOtpCommand,
  VerifyOtpOutcome,
} from './application/applicant-auth.service.js';
export { PgApplicantAuthRepository } from './adapters/applicant-auth.pg-repository.js';
export type {
  ApplicantAuthRepository,
  CreateChallengeInput,
  CreateSessionInput,
  OtpChallengeRecord,
} from './ports/applicant-auth.repository.js';
export { LogSmsChannel } from '@usrp/shared-sms';
export type { OutboundSms, SmsChannel, SmsDeliveryOutcome } from '@usrp/shared-sms';
export { HttpApplicationsGateway } from './adapters/applications.http-gateway.js';
export type { HttpApplicationsGatewayOptions } from './adapters/applications.http-gateway.js';
export type {
  ApplicantApplication,
  ApplicationsGateway,
  WithdrawApplicationResult,
} from './ports/applications-gateway.js';
export { RetentionSweepService } from './application/retention-sweep.service.js';
export type {
  RetentionPolicy,
  RetentionSweepDeps,
  SweepReport,
  SweepResult,
} from './application/retention-sweep.service.js';
export { PgRetentionRepository } from './adapters/retention.pg-repository.js';
export type { RetentionRepository } from './ports/retention-repository.js';
export { VerifyIdentityService } from './application/verify-identity.service.js';
export type {
  VerifyIdentityCommand,
  VerifyIdentityDeps,
  VerifyIdentityOutcome,
} from './application/verify-identity.service.js';
export { NidaHttpGateway } from './adapters/nida.http-gateway.js';
export type { NidaHttpGatewayOptions } from './adapters/nida.http-gateway.js';
export { PgIdentityRepository } from './adapters/identity.pg-repository.js';
export { PgErasureRepository } from './adapters/erasure.pg-repository.js';
export { EraseIdentityService } from './application/erase-identity.service.js';
export type { EraseIdentityCommand, EraseIdentityDeps } from './application/erase-identity.service.js';
export type { EraseIdentityOutcome, ErasureRepository } from './ports/erasure-repository.js';
export { ProjectBiometricResultService } from './application/project-biometric-result.service.js';
export type {
  ProjectBiometricResultCommand,
  ProjectBiometricResultDeps,
} from './application/project-biometric-result.service.js';
export {
  IDENTITY_BIOMETRIC_GROUP,
  startBiometricResultConsumer,
} from './adapters/events/biometric-result.consumer.js';
export {
  loadIdentityConfig,
  loadNidaConfig,
  loadApplicantPortalConfig,
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  APPLICANT_SESSION_TTL_SECONDS,
  RETENTION_NEVER_APPLIED_MONTHS,
  RETENTION_NEGATIVE_TERMINAL_MONTHS,
  RETENTION_PURGE_GRACE_DAYS,
} from './config.js';
export type { IdentityServiceConfig, ApplicantPortalConfig } from './config.js';
export type { NidaGateway } from './ports/nida.gateway.js';
export type {
  CreateVerifiedIdentityInput,
  CreateVerifiedIdentityResult,
  IdentityRepository,
  RecordBiometricResultInput,
} from './ports/identity.repository.js';
export {
  IdentityPersistenceError,
  InvalidNationalIdError,
  NidaUnavailableError,
} from './domain/identity.errors.js';
export type { NidaCitizen, NidaLookupResult } from './domain/nida.types.js';

// ══════════════════════════════════════════════════════════════════
// @usrp/background-vetting-service — Public API & composition root
//
// Wires the criminal-clearance use case (RibGateway port → RIB HTTP adapter)
// to the caller-provided event bus. Tests inject an InMemoryEventBus + a fake
// gateway; production injects a KafkaEventBus + the RIB HTTP gateway (see
// main.ts). The service exposes no HTTP business surface — its whole behaviour
// is "consume APPLICANT_SUBMITTED → vet → emit" — so the root just assembles
// the use case object the consumer drives.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { RibHttpGateway } from './adapters/rib.http-gateway.js';
import { VerifyCriminalClearanceService } from './application/verify-criminal-clearance.service.js';
import type { BackgroundVettingServiceConfig, ClearanceCertificateConfig } from './config.js';
import { PgApplicantIdentityReader } from './adapters/applicant-identity.pg-reader.js';
import { PgClearanceVerificationRepository } from './adapters/clearance-verification.pg-repository.js';
import { IremboCertificateGateway } from './adapters/irembo-certificate.gateway.js';
import { HttpIremboCertificateTransport } from './adapters/irembo-certificate.transport.js';
import { VerifyClearanceCertificateService } from './application/verify-clearance-certificate.service.js';

export interface BackgroundVettingService {
  readonly criminalClearance: VerifyCriminalClearanceService;
}

/** Assemble the criminal-clearance use case from config + event transport. */
export function createBackgroundVettingService(
  config: BackgroundVettingServiceConfig,
  eventBus: EventBus,
): BackgroundVettingService {
  const ribGateway = new RibHttpGateway({
    baseUrl: config.rib.baseUrl,
    hmacSecret: config.rib.hmacSecret,
    timeoutMs: config.rib.timeoutMs,
  });
  const criminalClearance = new VerifyCriminalClearanceService({ ribGateway, eventBus });
  return { criminalClearance };
}

/**
 * Assemble the Irembo certificate use case (ADR-048 §2.3). Separate from the
 * RIB path so the RIB_HASH mode stays database-free.
 */
export function createClearanceCertificateService(
  config: ClearanceCertificateConfig,
  eventBus: EventBus,
): VerifyClearanceCertificateService {
  return new VerifyClearanceCertificateService({
    gateway: new IremboCertificateGateway({
      transport: new HttpIremboCertificateTransport({ baseUrl: config.baseUrl, clientToken: config.clientToken, timeoutMs: config.timeoutMs }),
    }),
    identityReader: new PgApplicantIdentityReader(config.encryptionKey),
    repository: new PgClearanceVerificationRepository(),
    eventBus,
    policy: { allowedTypes: config.allowedTypes, noRecordTypes: config.noRecordTypes, validityDays: config.validityDays },
    referenceHmacKey: config.referenceHmacKey,
  });
}

// ── Re-exports ────────────────────────────────────────────────────
export { RibHttpGateway } from './adapters/rib.http-gateway.js';
export { VerifyCriminalClearanceService } from './application/verify-criminal-clearance.service.js';
export {
  BACKGROUND_VETTING_CONSUMER_GROUP,
  startApplicantSubmittedConsumer,
} from './adapters/events/applicant-submitted.consumer.js';
export { evaluateCriminalClearance } from './domain/criminal-rules.js';
export type { CriminalClearanceDecision } from './domain/criminal-rules.js';
export { RibUnavailableError } from './domain/rib.types.js';
export type { RibCheckResult } from './domain/rib.types.js';
export type { RibGateway } from './ports/rib.gateway.js';
export { loadBackgroundVettingConfig, loadClearanceCertificateConfig, loadClearanceMode, loadRibConfig, DEFAULT_CLEARANCE_VALIDITY_DAYS } from './config.js';
export type { BackgroundVettingServiceConfig, ClearanceCertificateConfig, ClearanceMode } from './config.js';
export { VerifyClearanceCertificateService } from './application/verify-clearance-certificate.service.js';
export type {
  VerifyClearanceCertificateCommand,
  VerifyClearanceCertificateDeps,
  VerifyClearanceCertificateOutcome,
} from './application/verify-clearance-certificate.service.js';
export { CLEARANCE_CONSUMER_GROUP, startClearanceCertificateConsumer } from './adapters/events/clearance-certificate-submitted.consumer.js';
export { decideClearance, daysBetween } from './domain/clearance-rules.js';
export type { ClearanceDecision } from './domain/clearance-rules.js';
export { CLEARANCE_NUMBER_PATTERN, normaliseClearanceNumber, parseClearanceNumber } from './domain/clearance-number.js';
export { CLEARANCE_FAILURE_CODES, ClearanceRegistryUnavailableError } from './domain/clearance.types.js';
export type { ClearanceCertificate, ClearanceFailureCode, ClearanceLookup, ClearancePolicy, ClearanceReviewReason } from './domain/clearance.types.js';
export type { ClearanceCertificateGateway } from './ports/clearance-certificate.gateway.js';
export type { ApplicantBindingSubject, ApplicantIdentityReader } from './ports/applicant-identity.reader.js';
export type { ClearanceVerificationRecord, ClearanceVerificationRepository, RecordVerificationResult, VerificationOutcome } from './ports/clearance-verification.repository.js';
export { IremboCertificateGateway } from './adapters/irembo-certificate.gateway.js';
export { HttpIremboCertificateTransport, IREMBO_CERTIFICATE_PATH } from './adapters/irembo-certificate.transport.js';
export type { IremboCertificateTransport } from './adapters/irembo-certificate.transport.js';
export { mapIremboCertificate, isoFromDdMmYyyy, IREMBO_NOT_FOUND_CODE } from './adapters/irembo-certificate.mapping.js';
export { PgApplicantIdentityReader } from './adapters/applicant-identity.pg-reader.js';
export { PgClearanceVerificationRepository } from './adapters/clearance-verification.pg-repository.js';
export type {
  VerifyCriminalClearanceCommand,
  VerifyCriminalClearanceOutcome,
} from './application/verify-criminal-clearance.service.js';

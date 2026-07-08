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
import type { BackgroundVettingServiceConfig } from './config.js';

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
export { loadBackgroundVettingConfig, loadRibConfig } from './config.js';
export type { BackgroundVettingServiceConfig } from './config.js';
export type {
  VerifyCriminalClearanceCommand,
  VerifyCriminalClearanceOutcome,
} from './application/verify-criminal-clearance.service.js';

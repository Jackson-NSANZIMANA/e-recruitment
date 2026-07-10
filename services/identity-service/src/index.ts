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
import { VerifyIdentityService } from './application/verify-identity.service.js';
import { ProjectBiometricResultService } from './application/project-biometric-result.service.js';
import type { IdentityServiceConfig } from './config.js';

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

// ── Re-exports ────────────────────────────────────────────────────
export {
  VERIFY_IDENTITY_PATH,
  verifyIdentityRoute,
} from './adapters/http/verify-identity.controller.js';
export { VerifyIdentityService } from './application/verify-identity.service.js';
export type {
  VerifyIdentityCommand,
  VerifyIdentityDeps,
  VerifyIdentityOutcome,
} from './application/verify-identity.service.js';
export { NidaHttpGateway } from './adapters/nida.http-gateway.js';
export type { NidaHttpGatewayOptions } from './adapters/nida.http-gateway.js';
export { PgIdentityRepository } from './adapters/identity.pg-repository.js';
export { ProjectBiometricResultService } from './application/project-biometric-result.service.js';
export type {
  ProjectBiometricResultCommand,
  ProjectBiometricResultDeps,
} from './application/project-biometric-result.service.js';
export {
  IDENTITY_BIOMETRIC_GROUP,
  startBiometricResultConsumer,
} from './adapters/events/biometric-result.consumer.js';
export { loadIdentityConfig, loadNidaConfig } from './config.js';
export type { IdentityServiceConfig } from './config.js';
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

// ══════════════════════════════════════════════════════════════════
// @usrp/eligibility-service — Public API & composition root
//
// Wires the hexagonal core to its adapters. Callers provide the EventBus
// so tests inject InMemoryEventBus and production injects KafkaEventBus,
// exactly as in the identity-service template.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { PgIdentityReader } from './adapters/identity.pg-reader.js';
import { EvaluateAgeEligibilityService } from './application/evaluate-age-eligibility.service.js';
import type { EligibilityServiceConfig } from './config.js';

/** Assemble the age-eligibility use case from config + a chosen event transport. */
export function createEligibilityService(
  config: EligibilityServiceConfig,
  eventBus: EventBus,
): EvaluateAgeEligibilityService {
  const identityReader = new PgIdentityReader(config.security.encryptionKey);
  return new EvaluateAgeEligibilityService({ identityReader, eventBus });
}

// ── Re-exports ────────────────────────────────────────────────────
export { AGE_CHECK_PATH, ageEligibilityRoute } from './adapters/http/eligibility.controller.js';
export {
  ELIGIBILITY_CONSUMER_GROUP,
  startApplicantSubmittedConsumer,
} from './adapters/events/applicant-submitted.consumer.js';
export { EvaluateAgeEligibilityService } from './application/evaluate-age-eligibility.service.js';
export type {
  EvaluateAgeEligibilityCommand,
  EvaluateAgeEligibilityDeps,
  EvaluateAgeEligibilityOutcome,
} from './application/evaluate-age-eligibility.service.js';
export { PgIdentityReader } from './adapters/identity.pg-reader.js';
export { ageInYears, evaluateAgeEligibility } from './domain/age-rules.js';
export { ALL_CATEGORIES, CATEGORY_TO_AGENCY, agencyForCategory } from './domain/category-agency.js';
export { EligibilityReadError, InvalidDateOfBirthError } from './domain/eligibility.errors.js';
export type { ApplicantIdentityRecord, IdentityReader } from './ports/identity-reader.js';
export { loadEligibilityConfig } from './config.js';
export type { EligibilityServiceConfig, EligibilitySecurityConfig } from './config.js';

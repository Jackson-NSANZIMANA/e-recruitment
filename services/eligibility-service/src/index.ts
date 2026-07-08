// ══════════════════════════════════════════════════════════════════
// @usrp/eligibility-service — Public API & composition root
//
// Wires the hexagonal core to its adapters. Callers provide the EventBus
// so tests inject InMemoryEventBus and production injects KafkaEventBus,
// exactly as in the identity-service template. The service now hosts two
// use cases — the age gate and the NESA education gate — sharing one
// identity reader and one event bus.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { PgIdentityReader } from './adapters/identity.pg-reader.js';
import { NesaHttpGateway } from './adapters/nesa.http-gateway.js';
import { HecHttpGateway } from './adapters/hec.http-gateway.js';
import { EvaluateAgeEligibilityService } from './application/evaluate-age-eligibility.service.js';
import { VerifyNesaEducationService } from './application/verify-nesa-education.service.js';
import { VerifyHecEducationService } from './application/verify-hec-education.service.js';
import type { EligibilityServiceConfig } from './config.js';

/** The assembled use cases this service exposes. */
export interface EligibilityServices {
  readonly age: EvaluateAgeEligibilityService;
  readonly education: VerifyNesaEducationService;
  readonly degree: VerifyHecEducationService;
}

/** Assemble the eligibility use cases from config + a chosen event transport. */
export function createEligibilityService(
  config: EligibilityServiceConfig,
  eventBus: EventBus,
): EligibilityServices {
  const identityReader = new PgIdentityReader(config.security.encryptionKey);
  const nesaGateway = new NesaHttpGateway({
    baseUrl: config.nesa.baseUrl,
    hmacSecret: config.nesa.hmacSecret,
    timeoutMs: config.nesa.timeoutMs,
  });
  const hecGateway = new HecHttpGateway({
    baseUrl: config.hec.baseUrl,
    hmacSecret: config.hec.hmacSecret,
    timeoutMs: config.hec.timeoutMs,
  });
  return {
    age: new EvaluateAgeEligibilityService({ identityReader, eventBus }),
    education: new VerifyNesaEducationService({ identityReader, nesaGateway, eventBus }),
    degree: new VerifyHecEducationService({ identityReader, hecGateway, eventBus }),
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export { AGE_CHECK_PATH, ageEligibilityRoute } from './adapters/http/eligibility.controller.js';
export { EDUCATION_CHECK_PATH, educationCheckRoute } from './adapters/http/education.controller.js';
export { DEGREE_CHECK_PATH, degreeCheckRoute } from './adapters/http/degree.controller.js';
export {
  ELIGIBILITY_CONSUMER_GROUP,
  startApplicantSubmittedConsumer,
} from './adapters/events/applicant-submitted.consumer.js';
export {
  ACADEMIC_CONSUMER_GROUP,
  startAcademicVettingConsumer,
} from './adapters/events/academic-vetting.consumer.js';
export type { AcademicVettingServices } from './adapters/events/academic-vetting.consumer.js';
export { EvaluateAgeEligibilityService } from './application/evaluate-age-eligibility.service.js';
export type {
  EvaluateAgeEligibilityCommand,
  EvaluateAgeEligibilityDeps,
  EvaluateAgeEligibilityOutcome,
} from './application/evaluate-age-eligibility.service.js';
export { VerifyNesaEducationService } from './application/verify-nesa-education.service.js';
export type {
  VerifyNesaEducationCommand,
  VerifyNesaEducationDeps,
  VerifyNesaEducationOutcome,
} from './application/verify-nesa-education.service.js';
export { VerifyHecEducationService } from './application/verify-hec-education.service.js';
export type {
  VerifyHecEducationCommand,
  VerifyHecEducationDeps,
  VerifyHecEducationOutcome,
} from './application/verify-hec-education.service.js';
export { PgIdentityReader } from './adapters/identity.pg-reader.js';
export { NesaHttpGateway } from './adapters/nesa.http-gateway.js';
export type { NesaHttpGatewayOptions } from './adapters/nesa.http-gateway.js';
export { HecHttpGateway } from './adapters/hec.http-gateway.js';
export type { HecHttpGatewayOptions } from './adapters/hec.http-gateway.js';
export { ageInYears, evaluateAgeEligibility } from './domain/age-rules.js';
export {
  evaluateNesaEducation,
  NESA_QUALIFICATION_TO_EDUCATION_LEVEL,
} from './domain/education-rules.js';
export type { EducationEligibilityResult } from './domain/education-rules.js';
export { evaluateHecEducation } from './domain/education-rules-hec.js';
export type { HecEducationEligibilityResult } from './domain/education-rules-hec.js';
export { ALL_CATEGORIES, CATEGORY_TO_AGENCY, agencyForCategory } from './domain/category-agency.js';
export { EligibilityReadError, InvalidDateOfBirthError } from './domain/eligibility.errors.js';
export { NesaUnavailableError } from './domain/nesa.types.js';
export type { NesaLookupResult } from './domain/nesa.types.js';
export { HecUnavailableError } from './domain/hec.types.js';
export type { HecLookupResult } from './domain/hec.types.js';
export type { NesaGateway } from './ports/nesa.gateway.js';
export type { HecGateway } from './ports/hec.gateway.js';
export type {
  ApplicantG2GSubjectRecord,
  ApplicantIdentityRecord,
  IdentityReader,
} from './ports/identity-reader.js';
export { loadEligibilityConfig, loadNesaConfig, loadHecConfig } from './config.js';
export type { EligibilityServiceConfig, EligibilitySecurityConfig } from './config.js';

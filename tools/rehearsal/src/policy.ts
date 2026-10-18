// ══════════════════════════════════════════════════════════════════
// rehearsal — the synthetic policy
//
// The control plane deliberately supplies no government thresholds: an
// authorised policy owner must. A rehearsal still needs a complete policy
// to publish, so it states — under the legal basis SYNTHETIC-REHEARSAL —
// exactly the rules the eligibility engine already applies (the constants in
// @usrp/shared-types). A rehearsal campaign therefore never advertises a rule
// the pipeline does not enforce, and is never mistakable for official policy.
// ══════════════════════════════════════════════════════════════════

import {
  AGE_CRITERIA,
  CRIMINAL_THRESHOLD_BY_CATEGORY,
  EDUCATION_REQUIREMENTS,
  REQUIRED_DOCUMENTS,
  type Agency,
  type ApplicationCategory,
  type DocumentType,
} from '@usrp/shared-types';

export const SYNTHETIC_LEGAL_BASIS_CODE = 'SYNTHETIC-REHEARSAL';

/**
 * ADR-013: RDF runs an in-house medical board; RNP and RCS verify a
 * government-physician certificate. Mirrors application-service's
 * officer-transitions, which is where the mode is enforced.
 */
export const MEDICAL_MODE_BY_AGENCY: Readonly<Record<Agency, 'BOARD' | 'CERTIFICATE'>> = {
  RDF: 'BOARD',
  RNP: 'CERTIFICATE',
  RCS: 'CERTIFICATE',
};

export interface CategoryPolicy {
  readonly age: { readonly minimumAge: number; readonly maximumAge: number; readonly referenceDate: string };
  readonly education: { readonly mode: 'NESA_RESULTS' | 'HEC_DEGREE'; readonly threshold: string };
  readonly criminalThreshold: string;
  readonly requiredDocumentTypes: readonly DocumentType[];
  readonly medicalMode: 'BOARD' | 'CERTIFICATE';
  readonly legalBasis: { readonly code: string; readonly reference: string };
}

export interface PolicyCommand {
  readonly publicCode: string;
  readonly policyDocument: Readonly<Record<string, CategoryPolicy>>;
  readonly legalBasisCode: string;
  readonly legalBasisReference: string;
}

/** PURE. The policy a rehearsal campaign publishes, read off the engine's constants. */
export function syntheticPolicy(input: {
  readonly publicCode: string;
  readonly agency: Agency;
  readonly categories: readonly ApplicationCategory[];
  readonly referenceDate: string;
  readonly scenarioId: string;
  readonly scenarioVersion: number;
}): PolicyCommand {
  const reference = `USRP rehearsal scenario ${input.scenarioId} v${String(input.scenarioVersion)}: synthetic values copied from the eligibility engine; not a Government of Rwanda policy.`;
  const policyDocument: Record<string, CategoryPolicy> = {};
  for (const category of input.categories) {
    const age = AGE_CRITERIA[category];
    const education = EDUCATION_REQUIREMENTS[category];
    policyDocument[category] = {
      age: { minimumAge: age.minAge, maximumAge: age.maxAge, referenceDate: input.referenceDate },
      education: {
        mode: education.hecVerificationRequired ? 'HEC_DEGREE' : 'NESA_RESULTS',
        threshold: education.minLevel,
      },
      criminalThreshold: CRIMINAL_THRESHOLD_BY_CATEGORY[category],
      requiredDocumentTypes: REQUIRED_DOCUMENTS[category],
      medicalMode: MEDICAL_MODE_BY_AGENCY[input.agency],
      legalBasis: { code: SYNTHETIC_LEGAL_BASIS_CODE, reference },
    };
  }
  return {
    publicCode: input.publicCode,
    policyDocument,
    legalBasisCode: SYNTHETIC_LEGAL_BASIS_CODE,
    legalBasisReference: reference,
  };
}

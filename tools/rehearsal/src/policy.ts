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

import { normalizePolicyV2, v1CriminalThreshold, type ConvictionRule, type PolicyV2, type QualificationLevel, type SatisfactionMode } from '@usrp/shared-campaign-policy';
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
  /** ADR-049: the additive v2 block (absent for a synthetic v1 policy). */
  readonly v2?: PolicyV2;
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


// ── Policy v2 from the announcement as printed (ADR-049) ──────────────────────

/** The announcement facts a category's policy is derived from (a slice of scenario.Announcement). */
export interface AnnouncementCategoryFacts {
  readonly category: string;
  readonly educationAnyOf: readonly string[];
  readonly ageCaps: readonly { readonly qualification: string; readonly minAge?: number; readonly maxAge: number }[];
  readonly convictionRule: string;
  readonly underProsecutionBars?: boolean;
}

const CONVICTION_RULE_BY_PRINTED: Readonly<Record<string, ConvictionRule>> = {
  NEVER_CONVICTED: 'NEVER_CONVICTED',
  NEVER_SENTENCED_TO_6_MONTHS_OR_MORE: 'NO_SENTENCE_6M_OR_MORE',
  NEVER_SENTENCED_TO_MORE_THAN_6_MONTHS: 'NO_SENTENCE_OVER_6M',
};

/**
 * How each document is satisfied (ADR-032). Registry-verified: NIDA, NESA, HEC and the Irembo
 * clearance number. Everything the citizen holds on paper is an upload.
 */
const SATISFACTION: Readonly<Record<string, SatisfactionMode>> = {
  NATIONAL_ID: 'REGISTRY_VERIFIED',
  OLEVEL_CERTIFICATE: 'REGISTRY_VERIFIED',
  ALEVEL_CERTIFICATE: 'REGISTRY_VERIFIED',
  DEGREE_DIPLOMA_COPY: 'REGISTRY_VERIFIED',
  DEGREE_DIPLOMA_NOTARIZED: 'REGISTRY_VERIFIED',
  NON_CONVICTION_CERTIFICATE: 'REGISTRY_VERIFIED',
  GOOD_CONDUCT_CERTIFICATE: 'UPLOAD',
  CELIBACY_CERTIFICATE: 'UPLOAD',
  BIRTH_CERTIFICATE: 'UPLOAD',
  APPLICATION_FORM_WITH_PHOTO: 'UPLOAD',
  MEDICAL_CERTIFICATE_GOVT: 'UPLOAD',
};

/** RCS announcements: the academic certificate is notarised (recruitment-announcements §4, §5). */
const NOTARISED_TYPES: ReadonlySet<string> = new Set(['ALEVEL_CERTIFICATE', 'DEGREE_DIPLOMA_NOTARIZED']);

/** §5: four-year track, "at least 70% in secondary science subjects" (weightedPercent; default taken, owner to confirm). */
const SCIENCE_BAR: Readonly<Record<string, number>> = { OFFICER_FOUR_YEAR_UR: 70 };

/** Placeholder Irembo criminal-record codes (ADR-048 §2.5): the real codes are for RIB/Irembo to give. */
export const SANDBOX_CLEARANCE_CODES = {
  noRecord: 'SANDBOX_PLACEHOLDER_CRIMINAL_NO_RECORD',
  extract: 'SANDBOX_PLACEHOLDER_CRIMINAL_RECORD_EXTRACT',
} as const;

/** PURE. The v2 block of one category, derived from the printed facts. Throws only on a fact the model cannot express. */
export function policyV2FromAnnouncement(agency: Agency, facts: AnnouncementCategoryFacts): PolicyV2 {
  const category = facts.category as ApplicationCategory;
  const rule = CONVICTION_RULE_BY_PRINTED[facts.convictionRule];
  if (rule === undefined) throw new Error(`Unknown printed conviction rule ${facts.convictionRule}.`);
  const levels = facts.educationAnyOf as readonly QualificationLevel[];
  const documents = REQUIRED_DOCUMENTS[category].map((type) => ({
    type,
    satisfaction: SATISFACTION[type] ?? 'UPLOAD',
    notarised: agency === 'RCS' && NOTARISED_TYPES.has(type),
  }));
  const needsClearance = documents.some((d) => d.type === 'NON_CONVICTION_CERTIFICATE');
  return normalizePolicyV2({
    schemaVersion: 2,
    // Each printed cap is one band; its qualifications are the levels the category accepts
    // (a category with several printed caps would name them; none of the six campaigns needs that).
    ageBands: facts.ageCaps.map((cap) => ({ qualifications: levels, minimumAge: cap.minAge ?? 18, maximumAge: cap.maxAge })),
    educationAlternatives: levels.map((level) => ({ level })),
    minimumSciencePercent: SCIENCE_BAR[category] ?? null,
    conviction: { rule, notUnderProsecution: facts.underProsecutionBars === true },
    documents,
    clearance: needsClearance
      ? { allowedCertificateCodes: [SANDBOX_CLEARANCE_CODES.noRecord, SANDBOX_CLEARANCE_CODES.extract], noRecordCertificateCodes: [SANDBOX_CLEARANCE_CODES.noRecord], validityDays: 90 }
      : null,
  });
}

/**
 * PURE. The policy a rehearsal campaign publishes when its scenario carries an announcement: the
 * synthetic envelope, then each category's v1 age/threshold/documents REPLACED by the printed
 * facts through the v2 block, so v1 and v2 readers agree (the control plane enforces that).
 */
export function policyFromAnnouncement(
  base: PolicyCommand,
  agency: Agency,
  categories: readonly AnnouncementCategoryFacts[],
): PolicyCommand {
  const policyDocument: Record<string, CategoryPolicy> = {};
  for (const [category, v1] of Object.entries(base.policyDocument)) {
    const printed = categories.find((c) => c.category === category);
    if (printed === undefined) continue;
    const v2 = policyV2FromAnnouncement(agency, printed);
    const widest = { min: Math.min(...v2.ageBands.map((b) => b.minimumAge)), max: Math.max(...v2.ageBands.map((b) => b.maximumAge)) };
    policyDocument[category] = {
      ...v1,
      age: { minimumAge: widest.min, maximumAge: widest.max, referenceDate: v1.age.referenceDate },
      criminalThreshold: v1CriminalThreshold(v2.conviction.rule),
      requiredDocumentTypes: v2.documents.map((d) => d.type) as unknown as CategoryPolicy['requiredDocumentTypes'],
      v2,
    };
  }
  return { ...base, policyDocument: { ...base.policyDocument, ...policyDocument } };
}

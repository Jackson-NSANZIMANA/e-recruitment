// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — Eligibility Rules
// Ground truth from official recruitment announcements
// ══════════════════════════════════════════════════════════════════

import type {
  Agency,
  RDFApplicationCategory,
  RNPApplicationCategory,
  RCSApplicationCategory,
  RDFSpecialistField,
  RCSSpecialistField,
  RCSFourYearURProgram,
} from './agency.types';

// ── Education Levels (Rwanda system) ─────────────────────────────

export const EDUCATION_LEVELS = [
  'O_LEVEL_S3',        // Grade 9 / Ordinary Level (3 years)
  'O_LEVEL_S6_EQUIV',  // Some O-Level completions
  'A_LEVEL_A2',        // Full A-Level (6 years secondary)
  'A1_IPRC',           // Advanced Diploma (IPRC — 2 years post A-Level)
  'BACHELOR_A0',       // University Bachelor's Degree
  'MASTERS',           // Postgraduate
  'PHD'                // Doctorate
] as const;
export type EducationLevel = typeof EDUCATION_LEVELS[number];

// ── Rwanda A-Level Grade System ───────────────────────────────────
// A = highest (rank 6), F = lowest (rank 1)

export const RWANDAN_ALEVEL_GRADES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type RwandanALevelGrade = typeof RWANDAN_ALEVEL_GRADES[number];

export const GRADE_RANK: Readonly<Record<RwandanALevelGrade, number>> = {
  'A': 6, 'B': 5, 'C': 4, 'D': 3, 'E': 2, 'F': 1
} as const;

export const QUALIFICATION_LEVELS = ['A2', 'A1', 'O_LEVEL'] as const;
export type QualificationLevel = typeof QUALIFICATION_LEVELS[number];

// ── Age Eligibility Rules (per category) ─────────────────────────

export interface AgeCriteria {
  readonly minAge: number;
  readonly maxAge: number;
  // maxAge can differ by education level or specialist field
  readonly maxAgeExceptions?: readonly {
    readonly educationLevels: readonly EducationLevel[];
    readonly specialistFields?: readonly string[];
    readonly maxAge: number;
    readonly reason: string;
  }[];
}

// Canonical age rules from announcements
export const AGE_CRITERIA: Readonly<
  Record<
    RDFApplicationCategory | RNPApplicationCategory | RCSApplicationCategory,
    AgeCriteria
  >
> = {
  // ── RDF ────────────────────────────────────────────────────────
  GENERAL_ENLISTMENT: {
    minAge: 18,
    maxAge: 25,
  },
  RESERVE_FORCE_ALEVEL: {
    minAge: 18,
    maxAge: 25,
  },
  RESERVE_FORCE_UNIVERSITY: {
    minAge: 18,
    maxAge: 26,            // University/IPRC graduates get +1 year
  },
  RESERVE_FORCE_SPECIALIST: {
    minAge: 18,
    maxAge: 27,            // Medicine/Engineering/Law specialists
  },

  // ── RNP ────────────────────────────────────────────────────────
  CADET_OFFICER: {
    minAge: 18,
    maxAge: 25,
  },
  BASIC_POLICE_COURSE: {
    minAge: 18,
    maxAge: 25,
  },

  // ── RCS ────────────────────────────────────────────────────────
  GENERAL_ENLISTEE: {
    minAge: 18,
    maxAge: 25,
  },
  OFFICER_ONE_YEAR: {
    minAge: 18,
    maxAge: 25,
  },
  OFFICER_ONE_YEAR_SPECIALIST: {
    minAge: 18,
    maxAge: 27,            // Medicine/Eng/Nursing/Law/Edu/Vet/ClinPsych
  },
  OFFICER_FOUR_YEAR_UR: {
    minAge: 18,
    maxAge: 21,            // Strictest cap — university intake track
  },
} as const;

// ── Criminal Conviction Thresholds ───────────────────────────────
// CRITICAL: Different rules per agency — confirmed from announcements

export type CriminalConvictionThreshold =
  | 'ANY_CONVICTION'          // RDF, RCS: any court conviction = disqualified
  | 'IMPRISONMENT_GT_6MO'     // RNP Cadet: >6 months imprisonment
  | 'IMPRISONMENT_GTE_6MO';   // RNP Basic: ≥6 months imprisonment

export const CRIMINAL_THRESHOLD_BY_CATEGORY: Readonly<
  Record<
    RDFApplicationCategory | RNPApplicationCategory | RCSApplicationCategory,
    CriminalConvictionThreshold
  >
> = {
  // RDF: Any conviction disqualifies
  GENERAL_ENLISTMENT:         'ANY_CONVICTION',
  RESERVE_FORCE_ALEVEL:       'ANY_CONVICTION',
  RESERVE_FORCE_UNIVERSITY:   'ANY_CONVICTION',
  RESERVE_FORCE_SPECIALIST:   'ANY_CONVICTION',

  // RNP Cadet: >6 months (strictly greater than)
  CADET_OFFICER:              'IMPRISONMENT_GT_6MO',
  // RNP Basic: ≥6 months (greater than OR equal to)
  BASIC_POLICE_COURSE:        'IMPRISONMENT_GTE_6MO',

  // RCS: Any conviction disqualifies
  // RCS also: "under criminal prosecution" disqualifies
  GENERAL_ENLISTEE:           'ANY_CONVICTION',
  OFFICER_ONE_YEAR:           'ANY_CONVICTION',
  OFFICER_ONE_YEAR_SPECIALIST:'ANY_CONVICTION',
  OFFICER_FOUR_YEAR_UR:       'ANY_CONVICTION',
} as const;

// ── Additional RCS-Only Disqualifiers ─────────────────────────────
// Not present in RDF or RNP announcements

export interface RCSAdditionalChecks {
  readonly underCriminalProsecution: boolean;  // Active prosecution = disqualified
  readonly celibacyCertRequired: boolean;       // Certificate of single status
  readonly governmentMedicalCertRequired: boolean; // Cert from authorized govt physician
  readonly notarizedDocumentsRequired: boolean; // Notarized (not just photocopied)
}

export const RCS_ADDITIONAL_CHECKS: Readonly<RCSAdditionalChecks> = {
  underCriminalProsecution: true,
  celibacyCertRequired: true,
  governmentMedicalCertRequired: true,
  notarizedDocumentsRequired: true,
} as const;

// ── Education Requirements Per Category ──────────────────────────

export interface EducationRequirement {
  readonly minLevel: EducationLevel;
  readonly acceptedLevels: readonly EducationLevel[];
  readonly nesaVerificationRequired: boolean;   // NESA API lookup needed
  readonly hecVerificationRequired: boolean;    // HEC (for degrees) lookup needed
  readonly minScienceGradePercent?: number;     // RCS 4-year: ≥70% science
  readonly urProgramRequired?: readonly RCSFourYearURProgram[];
}

export const EDUCATION_REQUIREMENTS: Readonly<
  Record<
    RDFApplicationCategory | RNPApplicationCategory | RCSApplicationCategory,
    EducationRequirement
  >
> = {
  // RDF General Enlistment: S3 minimum (O-Level / Grade 9)
  GENERAL_ENLISTMENT: {
    minLevel: 'O_LEVEL_S3',
    acceptedLevels: [
      'O_LEVEL_S3', 'O_LEVEL_S6_EQUIV', 'A_LEVEL_A2',
      'A1_IPRC', 'BACHELOR_A0', 'MASTERS', 'PHD'
    ],
    nesaVerificationRequired: true,
    hecVerificationRequired: false,
  },

  // RDF Reserve A-Level: A2 minimum
  RESERVE_FORCE_ALEVEL: {
    minLevel: 'A_LEVEL_A2',
    acceptedLevels: ['A_LEVEL_A2', 'A1_IPRC', 'BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: true,
    hecVerificationRequired: false,
  },

  // RDF Reserve University: Bachelor or IPRC minimum
  RESERVE_FORCE_UNIVERSITY: {
    minLevel: 'A1_IPRC',
    acceptedLevels: ['A1_IPRC', 'BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: false,
    hecVerificationRequired: true,
  },

  // RDF Reserve Specialist: Degree in Medicine/Eng/Law
  RESERVE_FORCE_SPECIALIST: {
    minLevel: 'BACHELOR_A0',
    acceptedLevels: ['BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: false,
    hecVerificationRequired: true,
  },

  // RNP Cadet Officer: Bachelor or A1 IPRC
  CADET_OFFICER: {
    minLevel: 'A1_IPRC',
    acceptedLevels: ['A1_IPRC', 'BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: false,
    hecVerificationRequired: true,
  },

  // RNP Basic Police: Full A-Level (A2)
  BASIC_POLICE_COURSE: {
    minLevel: 'A_LEVEL_A2',
    acceptedLevels: ['A_LEVEL_A2', 'A1_IPRC', 'BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: true,
    hecVerificationRequired: false,
  },

  // RCS General Enlistee: Full A-Level (A2)
  GENERAL_ENLISTEE: {
    minLevel: 'A_LEVEL_A2',
    acceptedLevels: ['A_LEVEL_A2', 'A1_IPRC', 'BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: true,
    hecVerificationRequired: false,
  },

  // RCS Officer 1-Year: Bachelor or A1 IPRC
  OFFICER_ONE_YEAR: {
    minLevel: 'A1_IPRC',
    acceptedLevels: ['A1_IPRC', 'BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: false,
    hecVerificationRequired: true,
  },

  // RCS Officer 1-Year Specialist: Degree in specialist field
  OFFICER_ONE_YEAR_SPECIALIST: {
    minLevel: 'BACHELOR_A0',
    acceptedLevels: ['BACHELOR_A0', 'MASTERS', 'PHD'],
    nesaVerificationRequired: false,
    hecVerificationRequired: true,
  },

  // RCS Officer 4-Year UR: A2 + ≥70% science + UR admission grades
  OFFICER_FOUR_YEAR_UR: {
    minLevel: 'A_LEVEL_A2',
    acceptedLevels: ['A_LEVEL_A2'],   // Only A2 — degree holders don't need 4-year program
    nesaVerificationRequired: true,
    hecVerificationRequired: false,
    minScienceGradePercent: 70,
    urProgramRequired: [
      'GENERAL_MEDICINE',
      'GENERAL_NURSING',
      'COMPUTER_ENGINEERING',
      'DENTAL_SURGERY'
    ],
  },
} as const;

// ── Required Documents Per Category ──────────────────────────────
// Ground truth from announcements — each agency differs

export type DocumentType =
  | 'NATIONAL_ID'
  | 'APPLICATION_FORM_WITH_PHOTO'
  | 'ALEVEL_CERTIFICATE'
  | 'OLEVEL_CERTIFICATE'
  | 'DEGREE_DIPLOMA_COPY'
  | 'DEGREE_DIPLOMA_NOTARIZED'
  | 'GOOD_CONDUCT_CERTIFICATE'
  | 'NON_CONVICTION_CERTIFICATE'
  | 'CELIBACY_CERTIFICATE'
  | 'MEDICAL_CERTIFICATE_GOVT'
  | 'BIRTH_CERTIFICATE';

export const REQUIRED_DOCUMENTS: Readonly<
  Record<
    RDFApplicationCategory | RNPApplicationCategory | RCSApplicationCategory,
    readonly DocumentType[]
  >
> = {
  // RDF: NID + A-Level Cert + Good Conduct + Non-Conviction
  // (O-Level cert for General Enlistment)
  GENERAL_ENLISTMENT: [
    'NATIONAL_ID',
    'OLEVEL_CERTIFICATE',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
  ],
  RESERVE_FORCE_ALEVEL: [
    'NATIONAL_ID',
    'ALEVEL_CERTIFICATE',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
  ],
  RESERVE_FORCE_UNIVERSITY: [
    'NATIONAL_ID',
    'DEGREE_DIPLOMA_COPY',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
  ],
  RESERVE_FORCE_SPECIALIST: [
    'NATIONAL_ID',
    'DEGREE_DIPLOMA_COPY',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
  ],

  // RNP Cadet: Form + Photo + NID copy + Degree/Diploma + Good Conduct
  CADET_OFFICER: [
    'APPLICATION_FORM_WITH_PHOTO',
    'NATIONAL_ID',
    'DEGREE_DIPLOMA_COPY',
    'GOOD_CONDUCT_CERTIFICATE',
  ],

  // RNP Basic: Form + Photo + NID copy + Diploma copy + Good Conduct
  BASIC_POLICE_COURSE: [
    'APPLICATION_FORM_WITH_PHOTO',
    'NATIONAL_ID',
    'ALEVEL_CERTIFICATE',
    'GOOD_CONDUCT_CERTIFICATE',
  ],

  // RCS General Enlistee: NID + Notarized cert + Good Conduct +
  // Non-Conviction + Celibacy + Medical (govt physician)
  GENERAL_ENLISTEE: [
    'NATIONAL_ID',
    'DEGREE_DIPLOMA_NOTARIZED',     // Notarized — not just copy
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
    'CELIBACY_CERTIFICATE',
    'MEDICAL_CERTIFICATE_GOVT',
  ],

  // RCS Officer 1-Year: Same as General Enlistee + Birth Cert
  OFFICER_ONE_YEAR: [
    'BIRTH_CERTIFICATE',
    'NATIONAL_ID',
    'DEGREE_DIPLOMA_NOTARIZED',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
    'CELIBACY_CERTIFICATE',
    'MEDICAL_CERTIFICATE_GOVT',
  ],

  // RCS Officer 1-Year Specialist: Same as Officer 1-Year
  OFFICER_ONE_YEAR_SPECIALIST: [
    'BIRTH_CERTIFICATE',
    'NATIONAL_ID',
    'DEGREE_DIPLOMA_NOTARIZED',
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
    'CELIBACY_CERTIFICATE',
    'MEDICAL_CERTIFICATE_GOVT',
  ],

  // RCS Officer 4-Year UR: Same document set as Officer
  OFFICER_FOUR_YEAR_UR: [
    'BIRTH_CERTIFICATE',
    'NATIONAL_ID',
    'ALEVEL_CERTIFICATE',           // A-Level cert (not degree — they don't have one yet)
    'GOOD_CONDUCT_CERTIFICATE',
    'NON_CONVICTION_CERTIFICATE',
    'CELIBACY_CERTIFICATE',
    'MEDICAL_CERTIFICATE_GOVT',
  ],
} as const;

// ── NESA Subject Result (for academic vetting) ────────────────────

export interface NESASubjectResult {
  readonly subjectCode: string;
  readonly subjectName: string;
  readonly grade: RwandanALevelGrade;
  readonly points: number;
}

export interface NESAVerifiedPayload {
  readonly indexNumber: string;
  readonly qualificationLevel: QualificationLevel;
  readonly yearOfExamination: number;
  readonly schoolName: string;
  readonly subjects: readonly NESASubjectResult[];
  readonly overallPoints: number;
  readonly percentageScore?: number;      // For RCS 4-year ≥70% check
  readonly verificationToken: string;
  readonly verifiedAt: string;
}

// ── HEC Verified Degree/Diploma (for degree-path academic vetting) ─
// The verified credential a degree/diploma category is evaluated against.
// HEC binds the credential to its holder by the G2G subject hash, so a
// successful lookup already asserts the degree belongs to this applicant.

export interface HECVerifiedPayload {
  readonly registrationNumber: string;
  readonly institutionName: string;
  readonly degreeTitle: string;
  readonly educationLevel: EducationLevel;   // BACHELOR_A0 | A1_IPRC | MASTERS | PHD
  /** e.g. 'ENGINEERING','NURSING' — drives the specialist match + age exception. */
  readonly specialistField: string | null;
  readonly graduationYear: number;
  readonly verifiedAt: string;
}

// ── Eligibility Result ────────────────────────────────────────────

export type AcademicEligibilityStatus = 'PENDING' | 'ELIGIBLE' | 'INELIGIBLE';
/** Age gate verdict as projected onto the application row — mirrors the academic enum. */
export type AgeEligibilityStatus = 'PENDING' | 'ELIGIBLE' | 'INELIGIBLE';
export type CriminalClearanceStatus =
  | 'PENDING'
  | 'CLEARED'
  | 'FLAGGED_CONVICTION'
  | 'FLAGGED_PROSECUTION'    // RCS-specific: under active prosecution
  | 'FLAGGED_DISMISSED'      // Dismissed from public service
  | 'UNDER_REVIEW';
export type DocumentLane = 'GREEN' | 'AMBER' | 'RED';

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly reason: string;
  readonly failureCode?: string;
  readonly evaluatedAt: string;
  readonly details: {
    readonly citizenshipCheck: boolean | null;
    readonly ageCheck: boolean | null;
    readonly educationCheck: boolean | null;
    readonly criminalCheck: boolean | null;
    readonly prosecutionCheck: boolean | null;   // RCS only
    readonly dismissalCheck: boolean | null;
    readonly moralCharacterCheck: boolean | null;
    readonly healthCheck: boolean | null;        // Physical — done at exam
  };
}

export interface AgeEligibilityResult {
  readonly eligible: boolean;
  readonly ageAtEvaluation: number;
  readonly dateOfBirth: string;
  readonly evaluationDate: string;
  readonly reason: string;
  readonly appliedMaxAge: number;
}

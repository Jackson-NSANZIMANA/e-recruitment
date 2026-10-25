// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the synthetic population's model (ADR-047 §3.4)
// ══════════════════════════════════════════════════════════════════

import type { SyntheticAddress } from './geography.js';

export type Sex = 'MALE' | 'FEMALE';

/** Authorities the sandbox simulates; each has a behaviour profile and a token bucket. */
export const AUTHORITIES = ['nida', 'nesa', 'irembo-certificates', 'sms'] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** Behaviours a persona or a request may select (ADR-047 §3.3). */
export const BEHAVIOURS = ['normal', 'slow', 'rate-limited', 'maintenance', 'timeout', 'truncated', 'status-false'] as const;
export type BehaviourName = (typeof BEHAVIOURS)[number];

/**
 * SDMS combinationLevelType. `TVET` is OBSERVED; `GENERAL`, `TTC` and
 * `O_LEVEL` are sandbox assumptions until a live capture shows the real
 * spellings (contracts/README.md).
 */
export type CombinationLevelType = 'GENERAL' | 'TVET' | 'TTC' | 'O_LEVEL';

export interface RawMark {
  readonly markPercent: number;
  readonly letterGrade: string;
  readonly subject: {
    readonly code: null;
    readonly subjectName: string;
    readonly numberOfPeriods: number;
    readonly subsidiary: null;
  };
}

/** One SDMS results record, field for field as the public endpoint answers. */
export interface SdmsResultsRecord {
  readonly studentNames: string;
  readonly studentIndexNumber: string;
  readonly studentCode: string;
  readonly gender: Sex;
  readonly resultsAggregate: number | null;
  readonly division: string;
  readonly placedSchoolName: null;
  readonly placedCombinationName: null;
  readonly placedSchoolContact: null;
  readonly placedSchoolProvince: null;
  readonly placedSchoolDistrict: null;
  readonly placedSchoolSector: null;
  readonly combinationLevelType: CombinationLevelType;
  readonly academicYear: string;
  readonly published: boolean;
  readonly malpractice: boolean;
  readonly attendedSchool: string;
  readonly combination: string;
  readonly weightedPercent: number;
  readonly studentNationalIdHint: string;
  readonly rawMark: readonly RawMark[];
}

export interface SyntheticCitizen {
  /** Persona id (catalogue) or `GEN-<n>` (generated). */
  readonly key: string;
  readonly personaId: string | null;
  readonly nid: string;
  readonly surname: string;
  readonly forename: string;
  readonly sex: Sex;
  /** ISO YYYY-MM-DD. */
  readonly dateOfBirth: string;
  readonly fatherName: string;
  readonly motherName: string;
  readonly civilStatus: 'SINGLE' | 'MARRIED';
  readonly address: SyntheticAddress;
  readonly placeOfBirth: string;
  /** ISO dates of the ID card. */
  readonly dateOfIssue: string;
  readonly dateOfExpiry: string;
  readonly issueNumber: number;
  /** Observed: NORMAL. Anything else is a quirk persona. */
  readonly citizenStatus: string;
  /** ISO 3166 alpha-2, observed RW. */
  readonly nationality: string;
  /** Synthetic local mobile number in the documented sandbox range (07880 0xxxx). */
  readonly phone: string;
  readonly behaviour: Partial<Readonly<Record<Authority, BehaviourName>>>;
  readonly nesa: SdmsResultsRecord | null;
}

/** The synthetic mobile range: 0788000000–0788009999 (E.164 +25078800xxxx). */
export const SYNTHETIC_PHONE_PATTERN = /^(?:\+?250|0)7880{2}\d{4}$/;

export function syntheticPhone(serial: number): string {
  return `078800${String(serial % 10000).padStart(4, '0')}`;
}

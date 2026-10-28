// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — building identities and their linked NESA records
//
// Index numbers follow the observed shape: a 6-digit centre code, the
// combination code in letters, a 3-digit candidate serial and the exam year
// (e.g. 990301PCM0012024). SANDBOX CENTRE BLOCK: synthetic centre codes start
// with 99; studentCode (12 digits) likewise starts with 99.
// ══════════════════════════════════════════════════════════════════

import { DISTRICTS, type District } from '@usrp/shared-types';
import { createHash } from 'node:crypto';
import type { Rng } from '../prng.js';
import { districtLabel, syntheticAddress } from './geography.js';
import { FORENAMES_FEMALE, FORENAMES_MALE, SURNAMES } from './names.js';
import { maskedHint, syntheticNid } from './nid.js';
import {
  syntheticPhone,
  type Authority,
  type BehaviourName,
  type CombinationLevelType,
  CERTIFICATE_APPLICATION_CODES,
  type CertificateKind,
  type RawMark,
  type SandboxCertificate,
  type SdmsResultsRecord,
  type Sex,
  type SyntheticCitizen,
} from './model.js';

interface Combination {
  readonly code: string;
  readonly name: string;
  readonly level: CombinationLevelType;
  readonly subjects: readonly { readonly name: string; readonly periods: number }[];
}

export const COMBINATIONS: Readonly<Record<string, Combination>> = {
  PCM: { code: 'PCM', name: 'Physics Chemistry Mathematics', level: 'GENERAL', subjects: [{ name: 'Physics', periods: 7 }, { name: 'Chemistry', periods: 7 }, { name: 'Mathematics', periods: 7 }, { name: 'General Paper', periods: 3 }, { name: 'Entrepreneurship', periods: 3 }] },
  PCB: { code: 'PCB', name: 'Physics Chemistry Biology', level: 'GENERAL', subjects: [{ name: 'Physics', periods: 7 }, { name: 'Chemistry', periods: 7 }, { name: 'Biology', periods: 7 }, { name: 'General Paper', periods: 3 }, { name: 'Subsidiary Mathematics', periods: 3 }] },
  MCB: { code: 'MCB', name: 'Mathematics Chemistry Biology', level: 'GENERAL', subjects: [{ name: 'Mathematics', periods: 7 }, { name: 'Chemistry', periods: 7 }, { name: 'Biology', periods: 7 }, { name: 'General Paper', periods: 3 }, { name: 'Entrepreneurship', periods: 3 }] },
  HEG: { code: 'HEG', name: 'History Economics Geography', level: 'GENERAL', subjects: [{ name: 'History', periods: 7 }, { name: 'Economics', periods: 7 }, { name: 'Geography', periods: 7 }, { name: 'General Paper', periods: 3 }, { name: 'Subsidiary Mathematics', periods: 3 }] },
  MEG: { code: 'MEG', name: 'Mathematics Economics Geography', level: 'GENERAL', subjects: [{ name: 'Mathematics', periods: 7 }, { name: 'Economics', periods: 7 }, { name: 'Geography', periods: 7 }, { name: 'General Paper', periods: 3 }, { name: 'Entrepreneurship', periods: 3 }] },
  SOD: { code: 'SOD', name: 'Software Development', level: 'TVET', subjects: [{ name: 'Web Application Development', periods: 8 }, { name: 'Database Development', periods: 6 }, { name: 'Programming Fundamentals', periods: 6 }, { name: 'Applied Mathematics', periods: 4 }, { name: 'Communication Skills', periods: 3 }] },
  ELT: { code: 'ELT', name: 'Electrical Technology', level: 'TVET', subjects: [{ name: 'Electrical Installation', periods: 8 }, { name: 'Electrical Machines', periods: 6 }, { name: 'Technical Drawing', periods: 4 }, { name: 'Applied Physics', periods: 4 }, { name: 'Communication Skills', periods: 3 }] },
  OLV: { code: 'OLV', name: 'Ordinary Level', level: 'O_LEVEL', subjects: [{ name: 'Mathematics', periods: 6 }, { name: 'English', periods: 5 }, { name: 'Kinyarwanda', periods: 4 }, { name: 'Biology', periods: 4 }, { name: 'History', periods: 3 }] },
};

const SCIENCE_COMBINATIONS = ['PCM', 'PCB', 'MCB'];

export function letterGrade(mark: number): string {
  if (mark >= 80) return 'A';
  if (mark >= 70) return 'B';
  if (mark >= 60) return 'C';
  if (mark >= 50) return 'D';
  if (mark >= 40) return 'E';
  if (mark >= 30) return 'S';
  return 'F';
}

export interface NesaSpec {
  readonly combination?: string;
  /** Target weighted percentage (the marks are spread around it). */
  readonly weightedPercent?: number;
  readonly examYear?: number;
  readonly published?: boolean;
  readonly malpractice?: boolean;
  readonly division?: string;
  readonly resultsAggregate?: number | null;
  /** Name printed on the record, if it must differ from the identity's (mismatch personas). */
  readonly studentNames?: string;
  /** Replace the NID hint (hint-mismatch persona). */
  readonly nidHintOverride?: string;
  /** Candidate serial within the centre (3 digits). */
  readonly serial?: number;
  /** Fix the index number (legacy fixtures keep a documented value). */
  readonly indexNumber?: string;
}

export function buildNesaRecord(rng: Rng, citizen: Pick<SyntheticCitizen, 'surname' | 'forename' | 'sex' | 'nid' | 'address'>, spec: NesaSpec): SdmsResultsRecord {
  const combo = COMBINATIONS[spec.combination ?? rng.pick(['PCM', 'PCB', 'HEG', 'MEG', 'MCB'])] ?? COMBINATIONS['PCM'];
  if (combo === undefined) throw new Error('unknown combination');
  const target = spec.weightedPercent ?? rng.int(52, 86);
  const examYear = spec.examYear ?? 2025;
  const marks = combo.subjects.map((subject, i): RawMark => {
    const jitter = i < 3 ? rng.int(-4, 4) : rng.int(-10, 6);
    const markPercent = Math.max(0, Math.min(100, target + jitter));
    return { markPercent, letterGrade: letterGrade(markPercent), subject: { code: null, subjectName: subject.name, numberOfPeriods: subject.periods, subsidiary: null } };
  });
  // Weighted by periods across the three principal subjects; pinned to the
  // target when one is given, so a "69%" persona is exactly 69.
  const principal = marks.slice(0, 3);
  const periods = principal.reduce((sum, m) => sum + m.subject.numberOfPeriods, 0);
  const computed = Math.round((principal.reduce((sum, m) => sum + m.markPercent * m.subject.numberOfPeriods, 0) / periods) * 100) / 100;
  const districtIndex = DISTRICTS.indexOf(citizen.address.district) + 1;
  const serial = spec.serial ?? rng.int(1, 999);
  const centre = `99${String(districtIndex).padStart(2, '0')}${String(rng.int(1, 40)).padStart(2, '0')}`;
  return {
    studentNames: spec.studentNames ?? `${citizen.surname} ${citizen.forename}`,
    studentIndexNumber: spec.indexNumber ?? `${centre}${combo.code}${String(serial).padStart(3, '0')}${String(examYear)}`,
    studentCode: `99${String(rng.int(0, 9_999_999_999)).padStart(10, '0')}`,
    gender: citizen.sex,
    resultsAggregate: spec.resultsAggregate ?? null,
    division: spec.division ?? 'PASS',
    placedSchoolName: null,
    placedCombinationName: null,
    placedSchoolContact: null,
    placedSchoolProvince: null,
    placedSchoolDistrict: null,
    placedSchoolSector: null,
    combinationLevelType: combo.level,
    academicYear: `${String(examYear - 1)}/${String(examYear)}`,
    published: spec.published ?? true,
    malpractice: spec.malpractice ?? false,
    attendedSchool: `Synthetic School ${String(rng.int(1, 60))} ${districtLabel(citizen.address.district)}`,
    combination: combo.name,
    weightedPercent: spec.weightedPercent ?? computed,
    studentNationalIdHint: spec.nidHintOverride ?? maskedHint(citizen.nid),
    rawMark: marks,
  };
}

export interface IdentitySpec {
  readonly surname?: string;
  readonly forename?: string;
  readonly sex?: Sex;
  /** ISO date, or an age relative to the reference date. */
  readonly dateOfBirth?: string | { readonly years: number; readonly days?: number };
  readonly district?: District;
  readonly citizenStatus?: string;
  readonly nationality?: string;
  /** Days relative to the reference date; negative = expired. */
  readonly expiresInDays?: number;
}

export interface CertificateSpec {
  readonly kind: CertificateKind;
  /** Days before the reference date the certificate was issued. */
  readonly issuedDaysAgo: number;
  /** Printed name, when it must differ from the identity's. */
  readonly printedName?: string;
  /** Printed date of birth (ISO), when it must differ. */
  readonly printedDateOfBirth?: string;
  /** STATUS flag; default true. */
  readonly status?: boolean;
}

/** SANDBOX-ONLY application number in the observed shape: `S` + `99` block + 10 digits + 4 letters. */
export function syntheticCertificateNumber(key: string, serial: number): string {
  const h = createHash('sha256').update(`irembo-cert:${key}:${String(serial)}`).digest();
  let digits = '';
  for (let i = 0; i < 10; i += 1) digits += String((h[i] ?? 0) % 10);
  let letters = '';
  for (let i = 10; i < 14; i += 1) letters += String.fromCharCode(65 + ((h[i] ?? 0) % 26));
  return `S99${digits}${letters}`;
}

function addDays(reference: Date, days: number): string {
  const d = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildCertificates(key: string, citizen: Pick<SyntheticCitizen, 'surname' | 'forename' | 'dateOfBirth'>, specs: readonly CertificateSpec[], reference: Date): SandboxCertificate[] {
  return specs.map((spec, serial): SandboxCertificate => {
    const applicationNumber = syntheticCertificateNumber(key, serial);
    return {
      applicationNumber,
      kind: spec.kind,
      applicationCode: CERTIFICATE_APPLICATION_CODES[spec.kind],
      issuedOn: addDays(reference, -spec.issuedDaysAgo),
      status: spec.status ?? true,
      signedBy: 'SANDBOX SYNTHETIC REGISTRAR',
      name: spec.printedName ?? `${citizen.surname} ${citizen.forename}`,
      dateOfBirth: spec.printedDateOfBirth ?? citizen.dateOfBirth,
    };
  });
}

export interface CitizenSpec {
  readonly key: string;
  readonly personaId: string | null;
  readonly nidSerial: number;
  readonly phoneSerial: number;
  readonly identity: IdentitySpec;
  readonly nesa: NesaSpec | null;
  readonly certificates?: readonly CertificateSpec[];
  readonly behaviour?: Partial<Readonly<Record<Authority, BehaviourName>>>;
}

/** ISO date `years` years (and `days` days) before `reference`, in UTC. */
export function dateYearsBefore(reference: Date, years: number, days = 0): string {
  const d = new Date(Date.UTC(reference.getUTCFullYear() - years, reference.getUTCMonth(), reference.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function plusDays(reference: Date, days: number): string {
  const d = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildCitizen(rng: Rng, spec: CitizenSpec, reference: Date): SyntheticCitizen {
  const id = spec.identity;
  const sex = id.sex ?? (rng.chance(0.5) ? 'MALE' : 'FEMALE');
  const forename = id.forename ?? rng.pick(sex === 'MALE' ? FORENAMES_MALE : FORENAMES_FEMALE);
  const surname = id.surname ?? rng.pick(SURNAMES);
  const dob = typeof id.dateOfBirth === 'string'
    ? id.dateOfBirth
    : id.dateOfBirth !== undefined
      ? dateYearsBefore(reference, id.dateOfBirth.years, id.dateOfBirth.days ?? 0)
      : dateYearsBefore(reference, rng.int(18, 30), rng.int(0, 364));
  const address = syntheticAddress(rng, id.district);
  const nid = syntheticNid(Number(dob.slice(0, 4)), sex, spec.nidSerial);
  const expiry = plusDays(reference, id.expiresInDays ?? rng.int(400, 3600));
  const issue = new Date(`${expiry}T00:00:00Z`);
  issue.setUTCFullYear(issue.getUTCFullYear() - 10);
  const base = { surname, forename, sex, nid, address };
  return {
    key: spec.key,
    personaId: spec.personaId,
    nid,
    surname,
    forename,
    sex,
    dateOfBirth: dob,
    fatherName: rng.pick(SURNAMES),
    motherName: rng.pick(SURNAMES),
    civilStatus: rng.chance(0.85) ? 'SINGLE' : 'MARRIED',
    address,
    placeOfBirth: districtLabel(address.district),
    dateOfIssue: issue.toISOString().slice(0, 10),
    dateOfExpiry: expiry,
    issueNumber: 1,
    citizenStatus: id.citizenStatus ?? 'NORMAL',
    nationality: id.nationality ?? 'RW',
    phone: syntheticPhone(spec.phoneSerial),
    behaviour: spec.behaviour ?? {},
    nesa: spec.nesa === null ? null : buildNesaRecord(rng, base, spec.nesa),
    certificates: buildCertificates(spec.key, { surname, forename, dateOfBirth: dob }, spec.certificates ?? [], reference),
  };
}

export { SCIENCE_COMBINATIONS };

// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the SCENARIO PERSONA CATALOGUE (ADR-047 §3.4)
//
// Named personas with STABLE IDs, one per path the platform must handle.
// Their NIDs are deterministic (synthetic block, serial = nidSerial) and their
// ages are relative to the sandbox's reference date, so "over-age by one day"
// stays over-age by one day whenever the sandbox runs.
//
// Families:
//   L-*   legacy fixtures: the seven citizens the retired hash-keyed NIDA mock
//         held, renumbered into the synthetic block. Existing proofs use them.
//   P-*   path personas: eligibility, age, education, binding, registry faults.
//   A-*   personas aligned to the real announcements
//         (docs/product/recruitment-announcements-2025-2026.md).
//
// Clearance personas (P-CLEARANCE-*) are identities only here; S12b gives them
// their Irembo certificates.
// ══════════════════════════════════════════════════════════════════

import type { CitizenSpec } from './records.js';

export interface PersonaEntry extends CitizenSpec {
  readonly personaId: string;
  /** What this persona rehearses, for people. */
  readonly covers: string;
}

const persona = (entry: Omit<PersonaEntry, 'key'>): PersonaEntry => ({ ...entry, key: entry.personaId });

/** What each legacy fixture stood for in the retired mock, so the migration is auditable. */
export const LEGACY_FIXTURE_NOTES: Readonly<Record<string, string>> = {
  'L-01': 'old persona A of national-pilot-day; NESA RW2024/1001 → 990301PCM0012024',
  'L-02': 'RIB mock: HAS_RECORDS',
  'L-03': 'old persona B (over-age); HEC degree holder',
  'L-04': 'age 30+ fixture',
  'L-05': 'young fixture',
  'L-06': 'RIB mock: UNDER_INVESTIGATION',
  'L-07': 'HEC degree holder; NESA RW2024/1002 → 990601HEG0022024',
};

export const PERSONAS: readonly PersonaEntry[] = [
  // ── Legacy fixtures (fixed dates: existing proofs assert them) ──────
  persona({ personaId: 'L-01', nidSerial: 1, phoneSerial: 1, covers: 'eligible A2 citizen (legacy persona A)', identity: { surname: 'UWIMANA', forename: 'Jean Pierre', sex: 'MALE', dateOfBirth: '2003-03-15', district: 'GASABO' }, nesa: { combination: 'PCM', examYear: 2024, weightedPercent: 72, indexNumber: '990301PCM0012024' } }),
  persona({ personaId: 'L-02', nidSerial: 2, phoneSerial: 2, covers: 'criminal record on the RIB mock', identity: { surname: 'UWAMARIYA', forename: 'Divine', sex: 'FEMALE', dateOfBirth: '2002-09-30', district: 'RUBAVU' }, nesa: { combination: 'HEG', examYear: 2024 } }),
  persona({ personaId: 'L-03', nidSerial: 3, phoneSerial: 3, covers: 'over-age for 18–25 bands (legacy persona B)', identity: { surname: 'HABIMANA', forename: 'Eric', sex: 'MALE', dateOfBirth: '1999-11-08', district: 'HUYE' }, nesa: { combination: 'MEG', examYear: 2018 } }),
  persona({ personaId: 'L-04', nidSerial: 4, phoneSerial: 4, covers: 'age 30+', identity: { surname: 'NZEYIMANA', forename: 'Paul', sex: 'MALE', dateOfBirth: '1990-01-15', district: 'NYARUGENGE' }, nesa: null }),
  persona({ personaId: 'L-05', nidSerial: 5, phoneSerial: 5, covers: 'young applicant', identity: { surname: 'NSHIMIYIMANA', forename: 'Patrick', sex: 'MALE', dateOfBirth: '2005-06-01', district: 'NYAGATARE' }, nesa: null }),
  persona({ personaId: 'L-06', nidSerial: 6, phoneSerial: 6, covers: 'under investigation on the RIB mock', identity: { surname: 'NKURUNZIZA', forename: 'Eric', sex: 'MALE', dateOfBirth: '2004-04-12', district: 'KAYONZA' }, nesa: null }),
  persona({ personaId: 'L-07', nidSerial: 7, phoneSerial: 7, covers: 'A2 humanities, HEC degree holder', identity: { surname: 'MUKAMANA', forename: 'Aline', sex: 'FEMALE', dateOfBirth: '2001-07-22', district: 'MUSANZE' }, nesa: { combination: 'HEG', examYear: 2024, weightedPercent: 75, indexNumber: '990601HEG0022024' } }),

  // ── Eligibility, per published level ───────────────────────────────
  persona({ personaId: 'P-ELIG-A2', nidSerial: 100, phoneSerial: 100, covers: 'eligible for every A2 category (RDF Reserve A-level, RNP Basic, RCS junior)', identity: { surname: 'KAMANZI', forename: 'Olivier', sex: 'MALE', dateOfBirth: { years: 21, days: 40 }, district: 'GASABO' }, nesa: { combination: 'PCM', weightedPercent: 71 } }),
  persona({ personaId: 'P-ELIG-A2-F', nidSerial: 101, phoneSerial: 101, covers: 'eligible A2, female, Southern Province', identity: { surname: 'UWINEZA', forename: 'Grace', sex: 'FEMALE', dateOfBirth: { years: 22, days: 10 }, district: 'HUYE' }, nesa: { combination: 'HEG', weightedPercent: 66 } }),
  persona({ personaId: 'P-ELIG-UR-SCI70', nidSerial: 102, phoneSerial: 102, covers: 'RCS officer 4-year: A2 science at 74%, age 20', identity: { surname: 'IRADUKUNDA', forename: 'Samuel', sex: 'MALE', dateOfBirth: { years: 20, days: 100 }, district: 'MUSANZE' }, nesa: { combination: 'PCB', weightedPercent: 74 } }),
  persona({ personaId: 'P-UR-SCI-69', nidSerial: 103, phoneSerial: 103, covers: 'RCS officer 4-year: science at 69%, below the 70% bar', identity: { surname: 'ISHIMWE', forename: 'Clarisse', sex: 'FEMALE', dateOfBirth: { years: 20, days: 30 }, district: 'RUBAVU' }, nesa: { combination: 'MCB', weightedPercent: 69 } }),
  persona({ personaId: 'P-UR-AGE-22', nidSerial: 104, phoneSerial: 104, covers: 'RCS officer 4-year: strong science, aged 22 (cap 21)', identity: { surname: 'MUHIRE', forename: 'Yves', sex: 'MALE', dateOfBirth: { years: 22, days: 5 }, district: 'KICUKIRO' }, nesa: { combination: 'PCM', weightedPercent: 84 } }),

  // ── Age ─────────────────────────────────────────────────────────────
  persona({ personaId: 'P-OVER-AGE-1D', nidSerial: 110, phoneSerial: 110, covers: 'over-age by one day for an 18–25 band (26th birthday was yesterday)', identity: { surname: 'BIZIMANA', forename: 'Thierry', sex: 'MALE', dateOfBirth: { years: 26, days: 1 }, district: 'HUYE' }, nesa: { combination: 'PCM', weightedPercent: 70 } }),
  persona({ personaId: 'P-AT-CAP-25', nidSerial: 111, phoneSerial: 111, covers: 'exactly at the cap: 25, turns 26 tomorrow', identity: { surname: 'UMUTONI', forename: 'Diane', sex: 'FEMALE', dateOfBirth: { years: 26, days: -1 }, district: 'GICUMBI' }, nesa: { combination: 'HEG', weightedPercent: 64 } }),
  persona({ personaId: 'P-UNDER-AGE', nidSerial: 112, phoneSerial: 112, covers: 'under-age: turns 18 tomorrow', identity: { surname: 'NIYIGENA', forename: 'Ange', sex: 'FEMALE', dateOfBirth: { years: 18, days: -1 }, district: 'KAYONZA' }, nesa: { combination: 'MEG', weightedPercent: 62 } }),

  // ── Education level ─────────────────────────────────────────────────
  persona({ personaId: 'P-S3-ONLY', nidSerial: 120, phoneSerial: 120, covers: 'S3 only: eligible for RDF regular, not for A2 categories', identity: { surname: 'NSENGIYUMVA', forename: 'Gilbert', sex: 'MALE', dateOfBirth: { years: 20, days: 60 }, district: 'NYAGATARE' }, nesa: { combination: 'OLV', weightedPercent: 58 } }),
  persona({ personaId: 'P-TVET-A2', nidSerial: 121, phoneSerial: 121, covers: 'TVET at A2 (counts as A2: default, owner to confirm)', identity: { surname: 'TWAGIRAYEZU', forename: 'Fabrice', sex: 'MALE', dateOfBirth: { years: 22, days: 15 }, district: 'RWAMAGANA' }, nesa: { combination: 'SOD', weightedPercent: 68 } }),
  persona({ personaId: 'P-A0-GRADUATE', nidSerial: 122, phoneSerial: 122, covers: 'A0 graduate (degree path is HEC; identity and A2 record here)', identity: { surname: 'UWAMAHORO', forename: 'Solange', sex: 'FEMALE', dateOfBirth: { years: 24, days: 80 }, district: 'NYARUGENGE' }, nesa: { combination: 'MEG', weightedPercent: 73, examYear: 2020 } }),

  // ── Binding (ADR-048 §2.2) ──────────────────────────────────────────
  persona({ personaId: 'P-NESA-NAME-MISMATCH', nidSerial: 130, phoneSerial: 130, covers: 'NESA record names another person → NOT_BOUND, correctable', identity: { surname: 'MANIRAGUHA', forename: 'Didier', sex: 'MALE', dateOfBirth: { years: 21, days: 20 }, district: 'GASABO' }, nesa: { combination: 'PCM', weightedPercent: 75, studentNames: 'NIYONSABA Chantal' } }),
  persona({ personaId: 'P-NESA-HINT-MISMATCH', nidSerial: 131, phoneSerial: 131, covers: 'NESA NID hint contradicts the identity → NOT_BOUND', identity: { surname: 'GASANA', forename: 'Félix', sex: 'MALE', dateOfBirth: { years: 22, days: 20 }, district: 'MUHANGA' }, nesa: { combination: 'PCB', weightedPercent: 70, nidHintOverride: '1199********9990' } }),
  persona({ personaId: 'P-NESA-NAME-PARTIAL', nidSerial: 132, phoneSerial: 132, covers: 'NESA record omits a given name → REVIEW (amber)', identity: { surname: 'MUNYANEZA', forename: 'Jean Claude', sex: 'MALE', dateOfBirth: { years: 23, days: 2 }, district: 'NGOMA' }, nesa: { combination: 'MEG', weightedPercent: 67, studentNames: 'MUNYANEZA Jean' } }),
  persona({ personaId: 'P-NESA-DIACRITICS', nidSerial: 133, phoneSerial: 133, covers: 'diacritics, order and case differ → still BOUND', identity: { surname: 'MUKESHIMANA', forename: 'Béata', sex: 'FEMALE', dateOfBirth: { years: 21, days: 200 }, district: 'NYANZA' }, nesa: { combination: 'HEG', weightedPercent: 69, studentNames: 'BEATA mukeshimana' } }),
  persona({ personaId: 'P-NESA-UNPUBLISHED', nidSerial: 134, phoneSerial: 134, covers: 'results not yet published → PENDING, never ineligible', identity: { surname: 'NIYONZIMA', forename: 'Emmanuel', sex: 'MALE', dateOfBirth: { years: 19, days: 90 }, district: 'BUGESERA' }, nesa: { combination: 'PCM', weightedPercent: 70, published: false } }),
  persona({ personaId: 'P-NESA-MALPRACTICE', nidSerial: 135, phoneSerial: 135, covers: 'malpractice flagged → REVIEW, never automatic', identity: { surname: 'HAKIZIMANA', forename: 'Josiane', sex: 'FEMALE', dateOfBirth: { years: 21, days: 75 }, district: 'KARONGI' }, nesa: { combination: 'MCB', weightedPercent: 77, malpractice: true } }),

  // ── Identity quirks ─────────────────────────────────────────────────
  persona({ personaId: 'P-ID-EXPIRED', nidSerial: 140, phoneSerial: 140, covers: 'ID card expired (dateOfExpiry in the past); the identity itself is valid', identity: { surname: 'NDAYISHIMIYE', forename: 'Innocent', sex: 'MALE', dateOfBirth: { years: 23, days: 33 }, district: 'RUSIZI', expiresInDays: -30 }, nesa: { combination: 'HEG', weightedPercent: 65 } }),
  persona({ personaId: 'P-CITIZEN-STATUS-OTHER', nidSerial: 141, phoneSerial: 141, covers: 'citizenStatus other than NORMAL → not confirmed at onboarding', identity: { surname: 'IRAKOZE', forename: 'Vestine', sex: 'FEMALE', dateOfBirth: { years: 22, days: 44 }, district: 'NYAMASHEKE', citizenStatus: 'SUSPENDED' }, nesa: null }),
  persona({ personaId: 'P-NON-CITIZEN', nidSerial: 142, phoneSerial: 142, covers: 'nationality other than RW → not a citizen', identity: { surname: 'NIYITEGEKA', forename: 'Pacifique', sex: 'MALE', dateOfBirth: { years: 24, days: 1 }, district: 'RUBAVU', nationality: 'CD' }, nesa: null }),

  // ── Registry behaviour during submission ────────────────────────────
  persona({ personaId: 'P-NIDA-429', nidSerial: 150, phoneSerial: 150, covers: 'NIDA answers 429 + Retry-After → retryable, never a verdict', identity: { district: 'GASABO', dateOfBirth: { years: 22, days: 3 } }, nesa: { combination: 'PCM' }, behaviour: { nida: 'rate-limited' } }),
  persona({ personaId: 'P-NIDA-503', nidSerial: 151, phoneSerial: 151, covers: 'NIDA in a maintenance window (503)', identity: { district: 'HUYE', dateOfBirth: { years: 22, days: 4 } }, nesa: { combination: 'HEG' }, behaviour: { nida: 'maintenance' } }),
  persona({ personaId: 'P-NIDA-STATUS-FALSE', nidSerial: 152, phoneSerial: 152, covers: 'Irembo-style status:false with HTTP 200', identity: { district: 'MUSANZE', dateOfBirth: { years: 22, days: 5 } }, nesa: { combination: 'MEG' }, behaviour: { nida: 'status-false' } }),
  persona({ personaId: 'P-NESA-429', nidSerial: 153, phoneSerial: 153, covers: 'SDMS answers 429 during academic vetting', identity: { district: 'GASABO', dateOfBirth: { years: 21, days: 6 } }, nesa: { combination: 'PCM' }, behaviour: { nesa: 'rate-limited' } }),
  persona({ personaId: 'P-NESA-503', nidSerial: 154, phoneSerial: 154, covers: 'SDMS maintenance (503) during academic vetting', identity: { district: 'HUYE', dateOfBirth: { years: 21, days: 7 } }, nesa: { combination: 'PCB' }, behaviour: { nesa: 'maintenance' } }),
  persona({ personaId: 'P-NESA-TRUNCATED', nidSerial: 155, phoneSerial: 155, covers: 'SDMS truncated body', identity: { district: 'KICUKIRO', dateOfBirth: { years: 21, days: 8 } }, nesa: { combination: 'HEG' }, behaviour: { nesa: 'truncated' } }),
  persona({ personaId: 'P-NESA-TIMEOUT', nidSerial: 156, phoneSerial: 156, covers: 'SDMS never answers in time', identity: { district: 'KICUKIRO', dateOfBirth: { years: 21, days: 9 } }, nesa: { combination: 'MEG' }, behaviour: { nesa: 'timeout' } }),

  // ── Clearance (identities now; Irembo certificates in S12b) ─────────
  persona({ personaId: 'P-CLEARANCE-VALID', nidSerial: 160, phoneSerial: 160, covers: 'S12b: valid criminal-record certificate', identity: { district: 'GASABO', dateOfBirth: { years: 22, days: 11 } }, nesa: { combination: 'PCM', weightedPercent: 70 } }),
  persona({ personaId: 'P-CLEARANCE-WRONG-TYPE', nidSerial: 161, phoneSerial: 161, covers: 'S12b: an equivalence certificate offered as clearance', identity: { district: 'HUYE', dateOfBirth: { years: 22, days: 12 } }, nesa: { combination: 'HEG', weightedPercent: 66 } }),
  persona({ personaId: 'P-CLEARANCE-EXPIRED', nidSerial: 162, phoneSerial: 162, covers: 'S12b: clearance issued outside the validity window', identity: { district: 'MUSANZE', dateOfBirth: { years: 22, days: 13 } }, nesa: { combination: 'MEG', weightedPercent: 66 } }),
  persona({ personaId: 'P-CLEARANCE-CONVICTION', nidSerial: 163, phoneSerial: 163, covers: 'S12b: certificate type that can carry a conviction → officer review', identity: { district: 'RUBAVU', dateOfBirth: { years: 22, days: 14 } }, nesa: { combination: 'PCM', weightedPercent: 70 } }),
  persona({ personaId: 'P-CLEARANCE-NAME-MISMATCH', nidSerial: 164, phoneSerial: 164, covers: 'S12b: certificate names another person', identity: { district: 'NYAGATARE', dateOfBirth: { years: 22, days: 15 } }, nesa: { combination: 'PCB', weightedPercent: 70 } }),
  persona({ personaId: 'P-CLEARANCE-DOB-MISMATCH', nidSerial: 165, phoneSerial: 165, covers: 'S12b: certificate DOB contradicts the identity', identity: { district: 'KAYONZA', dateOfBirth: { years: 22, days: 16 } }, nesa: { combination: 'MCB', weightedPercent: 70 } }),

  // ── Aligned to the real announcements (docs/product/recruitment-announcements-2025-2026.md) ──
  persona({ personaId: 'A-RDF-REGULAR-S3-ELIGIBLE', nidSerial: 200, phoneSerial: 200, covers: 'RDF regular 2026 §1: S3, age 19 → eligible', identity: { district: 'GASABO', dateOfBirth: { years: 19, days: 50 } }, nesa: { combination: 'OLV', weightedPercent: 55 } }),
  persona({ personaId: 'A-RDF-RESERVE-ALEVEL-ELIGIBLE', nidSerial: 201, phoneSerial: 201, covers: 'RDF Reserve 2026 §1: A-Level, age 24 → eligible', identity: { district: 'HUYE', dateOfBirth: { years: 24, days: 50 } }, nesa: { combination: 'HEG', weightedPercent: 63 } }),
  persona({ personaId: 'A-RDF-RESERVE-A0-AGE26', nidSerial: 202, phoneSerial: 202, covers: 'RDF Reserve 2026 §1: A0/IPRC, age 26 (cap "not over 26") → eligible on age (degree via HEC)', identity: { district: 'KICUKIRO', dateOfBirth: { years: 26, days: 120 } }, nesa: { combination: 'MEG', weightedPercent: 70, examYear: 2018 } }),
  persona({ personaId: 'A-RDF-RESERVE-SPECIALIST-AGE27', nidSerial: 203, phoneSerial: 203, covers: 'RDF Reserve 2026 §1: Medicine/Engineering/Law, age 27 (cap "not over 27")', identity: { district: 'NYARUGENGE', dateOfBirth: { years: 27, days: 120 } }, nesa: { combination: 'PCB', weightedPercent: 81, examYear: 2017 } }),
  persona({ personaId: 'A-RNP-BASIC-ELIGIBLE', nidSerial: 210, phoneSerial: 210, covers: 'RNP Basic 2025 §2: A2, age 22 → eligible, full journey', identity: { surname: 'NIYONSABA', forename: 'Eric', sex: 'MALE', district: 'GASABO', dateOfBirth: { years: 22, days: 70 } }, nesa: { combination: 'PCM', weightedPercent: 68 } }),
  persona({ personaId: 'A-RNP-CADET-A1-AGE25', nidSerial: 211, phoneSerial: 211, covers: 'RNP Cadet 2025 §3: A1 IPRC, age 25 (degree via HEC)', identity: { district: 'HUYE', dateOfBirth: { years: 25, days: 100 } }, nesa: { combination: 'ELT', weightedPercent: 66, examYear: 2019 } }),
  persona({ personaId: 'A-RCS-JUNIOR-ELIGIBLE', nidSerial: 220, phoneSerial: 220, covers: 'RCS junior 2025 §4: A2, age 23 → eligible', identity: { district: 'MUSANZE', dateOfBirth: { years: 23, days: 40 } }, nesa: { combination: 'HEG', weightedPercent: 61 } }),
  persona({ personaId: 'A-RCS-OFFICER-1Y-SPECIALIST-AGE27', nidSerial: 221, phoneSerial: 221, covers: 'RCS officer 2026 §5, 1-year track: specialist, age 27 (cap "not over 27")', identity: { district: 'KAYONZA', dateOfBirth: { years: 27, days: 30 } }, nesa: { combination: 'PCB', weightedPercent: 78, examYear: 2017 } }),
  persona({ personaId: 'A-RCS-OFFICER-4Y-ELIGIBLE', nidSerial: 222, phoneSerial: 222, covers: 'RCS officer 2026 §5, 4-year track: A2 science ≥ 70%, age 20', identity: { district: 'HUYE', dateOfBirth: { years: 20, days: 20 } }, nesa: { combination: 'PCB', weightedPercent: 76 } }),
];

export const PERSONA_IDS: readonly string[] = PERSONAS.map((p) => p.personaId);

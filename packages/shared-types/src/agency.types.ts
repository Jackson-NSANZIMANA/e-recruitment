// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — Agency & Category Definitions
// Ground truth: Official recruitment announcements
//   RDF:  May 2026 announcement (General Enlistment + Reserve)
//   RNP:  May 2025 (Cadet Officer) + Oct 2025 (Basic Police)
//   RCS:  Aug 2025 (General Enlistee) + Jun 2026 (Officer)
// ══════════════════════════════════════════════════════════════════

export const AGENCIES = ['RDF', 'RNP', 'RCS'] as const;
export type Agency = typeof AGENCIES[number];

export const APPLICATION_CHANNELS = [
  'WEB',
  'USSD',
  'IREMBO_KIOSK',
  'WALK_IN'           // RDF allows walk-in on exam day
] as const;
export type ApplicationChannel = typeof APPLICATION_CHANNELS[number];

// ── Rwanda Administrative Geography ───────────────────────────────
// Based on actual exam venue data from announcements

export const PROVINCES = [
  'KIGALI_CITY',
  'NORTHERN_PROVINCE',
  'SOUTHERN_PROVINCE',
  'EASTERN_PROVINCE',
  'WESTERN_PROVINCE'
] as const;
export type Province = typeof PROVINCES[number];

export const DISTRICTS = [
  // Kigali City
  'NYARUGENGE', 'KICUKIRO', 'GASABO',
  // Northern Province
  'GICUMBI', 'BURERA', 'MUSANZE', 'GAKENKE', 'RULINDO',
  // Southern Province
  'NYAMAGABE', 'NYARUGURU', 'GISAGARA', 'HUYE', 'NYANZA',
  'RUHANGO', 'MUHANGA', 'KAMONYI',
  // Eastern Province
  'KIREHE', 'NGOMA', 'NYAGATARE', 'GATSIBO',
  'KAYONZA', 'RWAMAGANA', 'BUGESERA',
  // Western Province
  'RUSIZI', 'NYAMASHEKE', 'KARONGI', 'RUTSIRO',
  'RUBAVU', 'NYABIHU', 'NGORORERO'
] as const;
export type District = typeof DISTRICTS[number];

export const DISTRICT_TO_PROVINCE: Readonly<Record<District, Province>> = {
  NYARUGENGE: 'KIGALI_CITY',
  KICUKIRO: 'KIGALI_CITY',
  GASABO: 'KIGALI_CITY',
  GICUMBI: 'NORTHERN_PROVINCE',
  BURERA: 'NORTHERN_PROVINCE',
  MUSANZE: 'NORTHERN_PROVINCE',
  GAKENKE: 'NORTHERN_PROVINCE',
  RULINDO: 'NORTHERN_PROVINCE',
  NYAMAGABE: 'SOUTHERN_PROVINCE',
  NYARUGURU: 'SOUTHERN_PROVINCE',
  GISAGARA: 'SOUTHERN_PROVINCE',
  HUYE: 'SOUTHERN_PROVINCE',
  NYANZA: 'SOUTHERN_PROVINCE',
  RUHANGO: 'SOUTHERN_PROVINCE',
  MUHANGA: 'SOUTHERN_PROVINCE',
  KAMONYI: 'SOUTHERN_PROVINCE',
  KIREHE: 'EASTERN_PROVINCE',
  NGOMA: 'EASTERN_PROVINCE',
  NYAGATARE: 'EASTERN_PROVINCE',
  GATSIBO: 'EASTERN_PROVINCE',
  KAYONZA: 'EASTERN_PROVINCE',
  RWAMAGANA: 'EASTERN_PROVINCE',
  BUGESERA: 'EASTERN_PROVINCE',
  RUSIZI: 'WESTERN_PROVINCE',
  NYAMASHEKE: 'WESTERN_PROVINCE',
  KARONGI: 'WESTERN_PROVINCE',
  RUTSIRO: 'WESTERN_PROVINCE',
  RUBAVU: 'WESTERN_PROVINCE',
  NYABIHU: 'WESTERN_PROVINCE',
  NGORORERO: 'WESTERN_PROVINCE',
} as const;

// ── RDF Application Categories ────────────────────────────────────
// Source: RDF May 2026 Announcement

export const RDF_APPLICATION_CATEGORIES = [
  'GENERAL_ENLISTMENT',         // Min: S3/Grade 9 | Age: 18-25
  'RESERVE_FORCE_ALEVEL',       // Min: A2 | Age: 18-25
  'RESERVE_FORCE_UNIVERSITY',   // Min: Bachelor/IPRC | Age: 18-26
  'RESERVE_FORCE_SPECIALIST'    // Min: Medicine/Eng/Law degree | Age: 18-27
] as const;
export type RDFApplicationCategory = typeof RDF_APPLICATION_CATEGORIES[number];

// ── RNP Application Categories ────────────────────────────────────
// Source: RNP May 2025 + Oct 2025 Announcements

export const RNP_APPLICATION_CATEGORIES = [
  'CADET_OFFICER',              // Min: Bachelor(A0)/A1IPRC | Age: 18-25
  'BASIC_POLICE_COURSE'         // Min: A2 | Age: 18-25
] as const;
export type RNPApplicationCategory = typeof RNP_APPLICATION_CATEGORIES[number];

// ── RCS Application Categories ────────────────────────────────────
// Source: RCS Aug 2025 + Jun 2026 Announcements

export const RCS_APPLICATION_CATEGORIES = [
  'GENERAL_ENLISTEE',           // Min: A2 | Age: 18-25
  'OFFICER_ONE_YEAR',           // Min: Bachelor(A0)/A1IPRC | Age: 18-25
  'OFFICER_ONE_YEAR_SPECIALIST',// Min: Medicine/Eng/Nursing/Law/Edu/Vet/ClinPsych | Age: 18-27
  'OFFICER_FOUR_YEAR_UR'        // Min: A2 + UR qualifying grades ≥70% Sci | Age: 18-21
] as const;
export type RCSApplicationCategory = typeof RCS_APPLICATION_CATEGORIES[number];

// ── Union type for all categories across agencies ─────────────────

export type ApplicationCategory =
  | RDFApplicationCategory
  | RNPApplicationCategory
  | RCSApplicationCategory;

// ── Walk-in Policy (Agency-specific) ─────────────────────────────

export const WALKIN_POLICY: Readonly<Record<Agency, boolean>> = {
  RDF: true,   // "Those who do not get the chance to pre-register
               //  are still permitted to present themselves on 
               //  the day of the recruitment examinations"
  RNP: false,  // Must register at DPU during registration window
  RCS: false,  // Must register at District level during window
               // (2026 Officer announcement adds walk-in exception)
} as const;

// ── Specialist Fields (priority/age-exception fields) ─────────────

export const RDF_SPECIALIST_FIELDS = [
  'MEDICINE', 'ENGINEERING', 'LAW'
] as const;
export type RDFSpecialistField = typeof RDF_SPECIALIST_FIELDS[number];

export const RNP_PRIORITY_FIELDS = [
  'STATISTICS', 'MEDICINE', 'VETERINARY_MEDICINE',
  'NURSING', 'EDUCATION', 'ENGINEERING'
] as const;
export type RNPPriorityField = typeof RNP_PRIORITY_FIELDS[number];

export const RCS_SPECIALIST_FIELDS = [
  'MEDICINE', 'ENGINEERING', 'NURSING',
  'LAW', 'EDUCATION', 'VETERINARY_MEDICINE',
  'CLINICAL_PSYCHOLOGY'
] as const;
export type RCSSpecialistField = typeof RCS_SPECIALIST_FIELDS[number];

export const RCS_FOUR_YEAR_UR_PROGRAMS = [
  'GENERAL_MEDICINE',
  'GENERAL_NURSING',
  'COMPUTER_ENGINEERING',
  'DENTAL_SURGERY'
] as const;
export type RCSFourYearURProgram = typeof RCS_FOUR_YEAR_UR_PROGRAMS[number];

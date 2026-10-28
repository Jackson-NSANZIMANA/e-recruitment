// ══════════════════════════════════════════════════════════════════
// @usrp/shared-campaign-policy — campaign policy v2 (ADR-049)
//
// PURE and dependency-free. A v2 policy is an ADDITIVE block (`v2`) inside a
// category's v1 policy, so the v1 shape every reader already knows keeps
// working. This module:
//   • normalises and validates the block (closed vocabularies, no free text
//     that a rule could hide in);
//   • checks the block cannot contradict its own v1 envelope;
//   • evaluates its rules: age by qualification, education alternatives, the
//     conviction rule, the clearance values and the document plan.
// Every decision function is total: it returns a verdict, it does not throw.
// Only normalisation throws, on malformed AUTHORED input (PolicyV2Error).
// ══════════════════════════════════════════════════════════════════

export const POLICY_V2_SCHEMA_VERSION = 2;

/** The education ladder (mirrors @usrp/shared-types EDUCATION_LEVELS; kept local so this package stays dependency-free). */
export const QUALIFICATION_LEVELS = [
  'O_LEVEL_S3',
  'O_LEVEL_S6_EQUIV',
  'A_LEVEL_A2',
  'A1_IPRC',
  'BACHELOR_A0',
  'MASTERS',
  'PHD',
] as const;
export type QualificationLevel = (typeof QUALIFICATION_LEVELS)[number];

/** Specialist fields named by the announcements (RDF Reserve, RCS officer one-year). */
export const SPECIALIST_FIELDS = [
  'MEDICINE',
  'ENGINEERING',
  'LAW',
  'NURSING',
  'EDUCATION',
  'VETERINARY_MEDICINE',
  'CLINICAL_PSYCHOLOGY',
] as const;
export type SpecialistField = (typeof SPECIALIST_FIELDS)[number];

/** A qualification an age band can name: a level, or a specialist field. */
export type QualificationCode = QualificationLevel | `FIELD:${SpecialistField}`;

export const CONVICTION_RULES = ['NEVER_CONVICTED', 'NO_SENTENCE_6M_OR_MORE', 'NO_SENTENCE_OVER_6M'] as const;
export type ConvictionRule = (typeof CONVICTION_RULES)[number];

export const SATISFACTION_MODES = ['REGISTRY_VERIFIED', 'UPLOAD', 'PRESENT_AT_VENUE'] as const;
export type SatisfactionMode = (typeof SATISFACTION_MODES)[number];

export interface AgeBand {
  /** Any of these qualifications puts the applicant in the band. */
  readonly qualifications: readonly QualificationCode[];
  readonly minimumAge: number;
  readonly maximumAge: number;
}

export interface EducationAlternative {
  readonly level: QualificationLevel;
}

export interface DocumentRule {
  /** A DocumentType code (validated against the agency by the application-service). */
  readonly type: string;
  readonly satisfaction: SatisfactionMode;
  /** The copy must be notarised (RCS academic certificate). */
  readonly notarised: boolean;
}

export interface ClearanceValues {
  readonly allowedCertificateCodes: readonly string[];
  /** A subset of allowedCertificateCodes: a distinct "no record" type, conclusive without a human step. */
  readonly noRecordCertificateCodes: readonly string[];
  readonly validityDays: number;
}

export interface PolicyV2 {
  readonly schemaVersion: 2;
  readonly ageBands: readonly AgeBand[];
  /** ANY ONE of these levels satisfies the education requirement. */
  readonly educationAlternatives: readonly EducationAlternative[];
  /** Minimum percentage in the secondary science subjects (RCS four-year), or null. */
  readonly minimumSciencePercent: number | null;
  readonly conviction: { readonly rule: ConvictionRule; readonly notUnderProsecution: boolean };
  readonly documents: readonly DocumentRule[];
  /** Present when the category requires a criminal clearance certificate. */
  readonly clearance: ClearanceValues | null;
}

export class PolicyV2Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolicyV2Error';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PolicyV2Error(code, message);
}

function obj(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_POLICY_V2', `${field} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('INVALID_POLICY_V2', `${field}.${key} is not accepted.`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail('INVALID_POLICY_V2', `${field}.${key} is required.`);
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_POLICY_V2', `${field} must be an integer from ${String(min)} to ${String(max)}.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail('INVALID_POLICY_V2', `${field} is not an accepted value.`);
  return value as T;
}

function array(value: unknown, field: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('INVALID_POLICY_V2', `${field} must be an array of ${String(min)}..${String(max)} entries.`);
  return value;
}

const CODE_TOKEN = /^[A-Z0-9][A-Z0-9_:-]{0,63}$/;

function qualification(value: unknown, field: string): QualificationCode {
  if (typeof value === 'string' && value.startsWith('FIELD:')) {
    return `FIELD:${oneOf(value.slice('FIELD:'.length), SPECIALIST_FIELDS, field)}`;
  }
  return oneOf(value, QUALIFICATION_LEVELS, field);
}

function codeSet(value: unknown, field: string, min: number): readonly string[] {
  const out: string[] = [];
  for (const [i, entry] of array(value, field, min, 20).entries()) {
    if (typeof entry !== 'string' || !CODE_TOKEN.test(entry)) fail('INVALID_POLICY_V2', `${field}[${String(i)}] must be a stable code token.`);
    if (out.includes(entry)) fail('INVALID_POLICY_V2', `${field} must not contain duplicates.`);
    out.push(entry);
  }
  return out.sort();
}

/** Normalise an authored v2 block. Throws PolicyV2Error on malformed input; the result is canonical (stable order). */
export function normalizePolicyV2(value: unknown, field = 'v2'): PolicyV2 {
  const body = obj(value, field);
  keys(body, ['schemaVersion', 'ageBands', 'educationAlternatives', 'minimumSciencePercent', 'conviction', 'documents', 'clearance'], field);
  if (body['schemaVersion'] !== POLICY_V2_SCHEMA_VERSION) fail('INVALID_POLICY_V2', `${field}.schemaVersion must be 2.`);

  const ageBands = array(body['ageBands'], `${field}.ageBands`, 1, 8).map((raw, i): AgeBand => {
    const band = obj(raw, `${field}.ageBands[${String(i)}]`);
    keys(band, ['qualifications', 'minimumAge', 'maximumAge'], `${field}.ageBands[${String(i)}]`);
    const qualifications = [...new Set(array(band['qualifications'], `${field}.ageBands[${String(i)}].qualifications`, 1, 12).map((q) => qualification(q, `${field}.ageBands[${String(i)}].qualifications`)))].sort();
    const minimumAge = int(band['minimumAge'], `${field}.ageBands[${String(i)}].minimumAge`, 0, 130);
    const maximumAge = int(band['maximumAge'], `${field}.ageBands[${String(i)}].maximumAge`, 0, 130);
    if (minimumAge > maximumAge) fail('INVALID_POLICY_V2', `${field}.ageBands[${String(i)}] has minimumAge above maximumAge.`);
    return { qualifications, minimumAge, maximumAge };
  });
  // A qualification named by two bands would make the cap ambiguous.
  const seen = new Set<string>();
  for (const band of ageBands) {
    for (const q of band.qualifications) {
      if (seen.has(q)) fail('INVALID_POLICY_V2', `${field}.ageBands names ${q} twice.`);
      seen.add(q);
    }
  }
  ageBands.sort((a, b) => a.maximumAge - b.maximumAge || a.minimumAge - b.minimumAge || (a.qualifications.join() < b.qualifications.join() ? -1 : 1));

  const alternatives = array(body['educationAlternatives'], `${field}.educationAlternatives`, 1, 7).map((raw, i): EducationAlternative => {
    const alt = obj(raw, `${field}.educationAlternatives[${String(i)}]`);
    keys(alt, ['level'], `${field}.educationAlternatives[${String(i)}]`);
    return { level: oneOf(alt['level'], QUALIFICATION_LEVELS, `${field}.educationAlternatives[${String(i)}].level`) };
  });
  if (new Set(alternatives.map((a) => a.level)).size !== alternatives.length) fail('INVALID_POLICY_V2', `${field}.educationAlternatives must not repeat a level.`);
  alternatives.sort((a, b) => QUALIFICATION_LEVELS.indexOf(a.level) - QUALIFICATION_LEVELS.indexOf(b.level));

  const science = body['minimumSciencePercent'];
  const minimumSciencePercent = science === null ? null : int(science, `${field}.minimumSciencePercent`, 1, 100);

  const conviction = obj(body['conviction'], `${field}.conviction`);
  keys(conviction, ['rule', 'notUnderProsecution'], `${field}.conviction`);
  if (typeof conviction['notUnderProsecution'] !== 'boolean') fail('INVALID_POLICY_V2', `${field}.conviction.notUnderProsecution must be a boolean.`);

  const documents = array(body['documents'], `${field}.documents`, 1, 20).map((raw, i): DocumentRule => {
    const doc = obj(raw, `${field}.documents[${String(i)}]`);
    keys(doc, ['type', 'satisfaction', 'notarised'], `${field}.documents[${String(i)}]`);
    const type = doc['type'];
    if (typeof type !== 'string' || !CODE_TOKEN.test(type)) fail('INVALID_POLICY_V2', `${field}.documents[${String(i)}].type must be a stable code token.`);
    if (typeof doc['notarised'] !== 'boolean') fail('INVALID_POLICY_V2', `${field}.documents[${String(i)}].notarised must be a boolean.`);
    return { type, satisfaction: oneOf(doc['satisfaction'], SATISFACTION_MODES, `${field}.documents[${String(i)}].satisfaction`), notarised: doc['notarised'] };
  });
  if (new Set(documents.map((d) => d.type)).size !== documents.length) fail('INVALID_POLICY_V2', `${field}.documents must not repeat a type.`);
  documents.sort((a, b) => (a.type < b.type ? -1 : 1));

  let clearance: ClearanceValues | null = null;
  if (body['clearance'] !== null) {
    const c = obj(body['clearance'], `${field}.clearance`);
    keys(c, ['allowedCertificateCodes', 'noRecordCertificateCodes', 'validityDays'], `${field}.clearance`);
    const allowed = codeSet(c['allowedCertificateCodes'], `${field}.clearance.allowedCertificateCodes`, 1);
    const noRecord = codeSet(c['noRecordCertificateCodes'], `${field}.clearance.noRecordCertificateCodes`, 0);
    if (noRecord.some((code) => !allowed.includes(code))) fail('INVALID_POLICY_V2', `${field}.clearance.noRecordCertificateCodes must be a subset of allowedCertificateCodes.`);
    clearance = { allowedCertificateCodes: allowed, noRecordCertificateCodes: noRecord, validityDays: int(c['validityDays'], `${field}.clearance.validityDays`, 1, 3650) };
  }

  return {
    schemaVersion: 2,
    ageBands,
    educationAlternatives: alternatives,
    minimumSciencePercent,
    conviction: { rule: oneOf(conviction['rule'], CONVICTION_RULES, `${field}.conviction.rule`), notUnderProsecution: conviction['notUnderProsecution'] },
    documents,
    clearance,
  };
}

/** The widest age window the block allows (what the v1 `age` envelope must equal). */
export function ageEnvelope(policy: PolicyV2): { readonly minimumAge: number; readonly maximumAge: number } {
  return {
    minimumAge: Math.min(...policy.ageBands.map((b) => b.minimumAge)),
    maximumAge: Math.max(...policy.ageBands.map((b) => b.maximumAge)),
  };
}

/** Facts about what the applicant's verified record says. */
export interface QualificationFacts {
  readonly level: QualificationLevel | null;
  readonly field: SpecialistField | null;
}

/**
 * The band that applies: of the bands the applicant's verified qualifications
 * match, the MOST GENEROUS (highest cap) wins, so a Medicine graduate with a
 * degree gets the specialist cap, not the degree cap. No match: null.
 */
export function ageBandFor(policy: PolicyV2, facts: QualificationFacts): AgeBand | null {
  const held = new Set<string>();
  if (facts.level !== null) held.add(facts.level);
  if (facts.field !== null) held.add(`FIELD:${facts.field}`);
  let best: AgeBand | null = null;
  for (const band of policy.ageBands) {
    if (band.qualifications.some((q) => held.has(q)) && (best === null || band.maximumAge > best.maximumAge)) best = band;
  }
  return best;
}

export type AgeVerdictCode = 'WITHIN_BAND' | 'BELOW_MINIMUM' | 'ABOVE_CAP' | 'NO_BAND_FOR_QUALIFICATION';

export interface AgeVerdict {
  readonly eligible: boolean;
  readonly code: AgeVerdictCode;
  readonly age: number;
  /** The cap that decided it (null when no band matched). The citizen copy names it. */
  readonly cap: number | null;
  readonly minimum: number | null;
}

export function evaluateAgeForQualification(policy: PolicyV2, facts: QualificationFacts, age: number): AgeVerdict {
  const band = ageBandFor(policy, facts);
  if (band === null) return { eligible: false, code: 'NO_BAND_FOR_QUALIFICATION', age, cap: null, minimum: null };
  if (age < band.minimumAge) return { eligible: false, code: 'BELOW_MINIMUM', age, cap: band.maximumAge, minimum: band.minimumAge };
  if (age > band.maximumAge) return { eligible: false, code: 'ABOVE_CAP', age, cap: band.maximumAge, minimum: band.minimumAge };
  return { eligible: true, code: 'WITHIN_BAND', age, cap: band.maximumAge, minimum: band.minimumAge };
}

/** ANY ONE alternative satisfies the education requirement (A0 OR A1 IPRC). */
export function educationSatisfied(policy: PolicyV2, level: QualificationLevel): boolean {
  return policy.educationAlternatives.some((a) => a.level === level);
}

export function scienceSatisfied(policy: PolicyV2, sciencePercent: number | undefined): boolean {
  return policy.minimumSciencePercent === null || (sciencePercent !== undefined && sciencePercent >= policy.minimumSciencePercent);
}

/** What a criminal record says, reduced to the facts a rule needs. */
export interface ConvictionFacts {
  readonly convicted: boolean;
  /** The longest custodial sentence in whole months, or null when none / unknown. */
  readonly longestSentenceMonths: number | null;
  readonly underProsecution: boolean;
}

export type ConvictionVerdictCode = 'CLEAR' | 'CONVICTED' | 'SENTENCE_BARS' | 'UNDER_PROSECUTION';

/** The conviction rule applied to a record's content (ADR-048's REVIEW step asks this of the officer's reading). */
export function convictionVerdict(policy: PolicyV2, facts: ConvictionFacts): { readonly eligible: boolean; readonly code: ConvictionVerdictCode } {
  if (policy.conviction.notUnderProsecution && facts.underProsecution) return { eligible: false, code: 'UNDER_PROSECUTION' };
  switch (policy.conviction.rule) {
    case 'NEVER_CONVICTED':
      return facts.convicted ? { eligible: false, code: 'CONVICTED' } : { eligible: true, code: 'CLEAR' };
    case 'NO_SENTENCE_6M_OR_MORE':
      return facts.longestSentenceMonths !== null && facts.longestSentenceMonths >= 6 ? { eligible: false, code: 'SENTENCE_BARS' } : { eligible: true, code: 'CLEAR' };
    case 'NO_SENTENCE_OVER_6M':
      return facts.longestSentenceMonths !== null && facts.longestSentenceMonths > 6 ? { eligible: false, code: 'SENTENCE_BARS' } : { eligible: true, code: 'CLEAR' };
  }
}

/** The v1 `criminalThreshold` a conviction rule corresponds to (the envelope must agree). */
export function v1CriminalThreshold(rule: ConvictionRule): 'ANY_CONVICTION' | 'IMPRISONMENT_GT_6MO' | 'IMPRISONMENT_GTE_6MO' {
  return rule === 'NEVER_CONVICTED' ? 'ANY_CONVICTION' : rule === 'NO_SENTENCE_OVER_6M' ? 'IMPRISONMENT_GT_6MO' : 'IMPRISONMENT_GTE_6MO';
}

/** The policy v2 consistency check against the v1 envelope of the same category. */
export function checkEnvelope(
  policy: PolicyV2,
  v1: { readonly age: { readonly minimumAge: number; readonly maximumAge: number }; readonly criminalThreshold: string; readonly requiredDocumentTypes: readonly string[] },
): string | null {
  const envelope = ageEnvelope(policy);
  if (envelope.minimumAge !== v1.age.minimumAge || envelope.maximumAge !== v1.age.maximumAge) {
    return `v1 age ${String(v1.age.minimumAge)}-${String(v1.age.maximumAge)} must equal the widest v2 band ${String(envelope.minimumAge)}-${String(envelope.maximumAge)}.`;
  }
  if (v1.criminalThreshold !== v1CriminalThreshold(policy.conviction.rule)) return 'v1 criminalThreshold must agree with the v2 conviction rule.';
  const v2Types = policy.documents.map((d) => d.type).sort();
  const v1Types = [...v1.requiredDocumentTypes].sort();
  if (v2Types.length !== v1Types.length || v2Types.some((t, i) => t !== v1Types[i])) return 'v1 requiredDocumentTypes must list exactly the v2 documents.';
  return null;
}

/** Documents the applicant must supply before the venue (UPLOAD) versus at it. */
export function documentPlan(policy: PolicyV2): { readonly registry: readonly DocumentRule[]; readonly upload: readonly DocumentRule[]; readonly atVenue: readonly DocumentRule[] } {
  return {
    registry: policy.documents.filter((d) => d.satisfaction === 'REGISTRY_VERIFIED'),
    upload: policy.documents.filter((d) => d.satisfaction === 'UPLOAD'),
    atVenue: policy.documents.filter((d) => d.satisfaction === 'PRESENT_AT_VENUE'),
  };
}

/** Read an unknown stored v2 block without throwing (a stored v1 category, or damage, yields null). */
export function readPolicyV2(value: unknown): PolicyV2 | null {
  try {
    return normalizePolicyV2(value);
  } catch {
    return null;
  }
}

/** The closed, locale-free picker explanation: one row per distinct qualification band. */
export interface QualificationRow {
  readonly qualifications: readonly QualificationCode[];
  readonly minimumAge: number;
  readonly maximumAge: number;
}

export function pickerRows(policy: PolicyV2): readonly QualificationRow[] {
  return policy.ageBands.map((b) => ({ qualifications: b.qualifications, minimumAge: b.minimumAge, maximumAge: b.maximumAge }));
}

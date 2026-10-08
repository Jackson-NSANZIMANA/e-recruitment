// BUILD-001 campaign request validation and normalization.
//
// This layer validates structure and known shared enums only. It deliberately
// does not choose age, education, criminal, medical, or other official policy
// values; an authorized officer must supply them explicitly.

import {
  ALL_CATEGORIES,
  CATEGORY_TO_AGENCY,
  DISTRICTS,
  DISTRICT_TO_PROVINCE,
  PROVINCES,
  type Agency,
  type ApplicationCategory,
  type CampaignCategoryPolicy,
  type CampaignDraftInput,
  type CampaignPolicyInput,
  type CampaignSessionInput,
  type District,
  type DocumentType,
  type Province,
} from '@usrp/shared-types';

const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'NATIONAL_ID',
  'APPLICATION_FORM_WITH_PHOTO',
  'ALEVEL_CERTIFICATE',
  'OLEVEL_CERTIFICATE',
  'DEGREE_DIPLOMA_COPY',
  'DEGREE_DIPLOMA_NOTARIZED',
  'GOOD_CONDUCT_CERTIFICATE',
  'NON_CONVICTION_CERTIFICATE',
  'CELIBACY_CERTIFICATE',
  'MEDICAL_CERTIFICATE_GOVT',
  'BIRTH_CERTIFICATE',
]);
const CODE_RE = /^[A-Z0-9][A-Z0-9_:-]{0,63}$/;
const PUBLIC_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

export class CampaignInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CampaignInputError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CampaignInputError(code, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('INVALID_REQUEST', `Field "${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('INVALID_REQUEST', `Field "${field}.${key}" is not accepted.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('INVALID_REQUEST', `Field "${field}.${key}" is required.`);
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail('INVALID_REQUEST', `Field "${field}" must be a string.`);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length === 0 || normalized.length > max || hasControlCharacters(normalized)) {
    fail('INVALID_REQUEST', `Field "${field}" must contain 1..${String(max)} printable characters.`);
  }
  return normalized;
}

function safeCode(value: unknown, field: string): string {
  const normalized = requiredString(value, field, 64).toUpperCase();
  if (!CODE_RE.test(normalized)) fail('INVALID_REQUEST', `Field "${field}" must be a stable code token.`);
  return normalized;
}

export function normalizePublicCode(value: unknown): string {
  const normalized = requiredString(value, 'publicCode', 64).toUpperCase();
  if (!PUBLIC_CODE_RE.test(normalized) || normalized.startsWith('LEGACY-')) {
    fail('INVALID_PUBLIC_CODE', 'Field "publicCode" is invalid or uses a reserved legacy prefix.');
  }
  return normalized;
}

function dateOnly(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('INVALID_DATE', `Field "${field}" must be an ISO calendar date (YYYY-MM-DD).`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('INVALID_DATE', `Field "${field}" must be a real calendar date.`);
  }
  return value;
}

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    fail('INVALID_TIMESTAMP', `Field "${field}" must be an ISO-8601 timestamp with an explicit timezone.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail('INVALID_TIMESTAMP', `Field "${field}" is not a valid timestamp.`);
  return parsed.toISOString();
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_REQUEST', `Field "${field}" must be an integer from ${String(min)} to ${String(max)}.`);
  }
  return value;
}

function stringSet(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('INVALID_REQUEST', `Field "${field}" must be a non-empty array.`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      fail('INVALID_REQUEST', `Field "${field}" contains an unknown value.`);
    }
    if (result.includes(entry)) fail('INVALID_REQUEST', `Field "${field}" must not contain duplicates.`);
    result.push(entry);
  }
  return result.sort();
}

export function normalizeCampaignDraft(value: unknown, agency: Agency): CampaignDraftInput {
  const body = record(value, 'body');
  exactKeys(
    body,
    [
      'publicCode',
      'campaignLabel',
      'targetCategories',
      'targetDistricts',
      'registrationOpensAt',
      'registrationClosesAt',
      'examinationStartDate',
      'examinationEndDate',
      'examinationReportingHour',
      'allowsWalkIn',
    ],
    ['targetIntakeCount', 'contactPhoneNumbers', 'contactWebsite'],
    'body',
  );

  const categories = stringSet(body.targetCategories, 'targetCategories', ALL_CATEGORIES) as readonly ApplicationCategory[];
  for (const category of categories) {
    if (CATEGORY_TO_AGENCY.get(category) !== agency) {
      fail('CATEGORY_AGENCY_MISMATCH', 'Every target category must belong to the verified officer agency.');
    }
  }
  const districts = stringSet(
    body.targetDistricts,
    'targetDistricts',
    new Set(DISTRICTS),
  ) as readonly District[];
  const registrationOpensAt = instant(body.registrationOpensAt, 'registrationOpensAt');
  const registrationClosesAt = instant(body.registrationClosesAt, 'registrationClosesAt');
  if (Date.parse(registrationOpensAt) >= Date.parse(registrationClosesAt)) {
    fail('INVALID_REGISTRATION_WINDOW', 'Registration must open before it closes.');
  }
  const examinationStartDate = dateOnly(body.examinationStartDate, 'examinationStartDate');
  const examinationEndDate = dateOnly(body.examinationEndDate, 'examinationEndDate');
  if (examinationStartDate > examinationEndDate) {
    fail('INVALID_EXAMINATION_WINDOW', 'Examination start date must not be after its end date.');
  }
  if (typeof body.allowsWalkIn !== 'boolean') {
    fail('INVALID_REQUEST', 'Field "allowsWalkIn" must be a boolean.');
  }

  let targetIntakeCount: number | null | undefined;
  if (body.targetIntakeCount !== undefined) {
    if (body.targetIntakeCount === null) {
      targetIntakeCount = null;
    } else {
      targetIntakeCount = integer(body.targetIntakeCount, 'targetIntakeCount', 1, 2_147_483_647);
    }
  }

  let contactPhoneNumbers: readonly string[] | undefined;
  if (body.contactPhoneNumbers !== undefined) {
    if (!Array.isArray(body.contactPhoneNumbers) || body.contactPhoneNumbers.length > 10) {
      fail('INVALID_REQUEST', 'Field "contactPhoneNumbers" must be an array with at most 10 entries.');
    }
    contactPhoneNumbers = body.contactPhoneNumbers.map((phone, index) =>
      requiredString(phone, `contactPhoneNumbers[${String(index)}]`, 40),
    );
  }

  let contactWebsite: string | null | undefined;
  if (body.contactWebsite !== undefined) {
    if (body.contactWebsite === null) {
      contactWebsite = null;
    } else {
      const candidate = requiredString(body.contactWebsite, 'contactWebsite', 100);
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return fail('INVALID_CONTACT_WEBSITE', 'Field "contactWebsite" must be an absolute HTTP(S) URL.');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        fail('INVALID_CONTACT_WEBSITE', 'Field "contactWebsite" must be an absolute HTTP(S) URL.');
      }
      contactWebsite = parsed.toString();
    }
  }

  return {
    publicCode: normalizePublicCode(body.publicCode),
    campaignLabel: requiredString(body.campaignLabel, 'campaignLabel', 50),
    targetCategories: categories,
    targetDistricts: districts,
    registrationOpensAt,
    registrationClosesAt,
    examinationStartDate,
    examinationEndDate,
    examinationReportingHour: integer(body.examinationReportingHour, 'examinationReportingHour', 0, 23),
    allowsWalkIn: body.allowsWalkIn,
    ...(targetIntakeCount === undefined ? {} : { targetIntakeCount }),
    ...(contactPhoneNumbers === undefined ? {} : { contactPhoneNumbers }),
    ...(contactWebsite === undefined ? {} : { contactWebsite }),
  };
}

function asPolicy(value: unknown, category: string): CampaignCategoryPolicy {
  const policy = record(value, `policyDocument.${category}`);
  exactKeys(
    policy,
    ['age', 'education', 'criminalThreshold', 'requiredDocumentTypes', 'medicalMode', 'legalBasis'],
    [],
    `policyDocument.${category}`,
  );

  const age = record(policy.age, `policyDocument.${category}.age`);
  exactKeys(age, ['minimumAge', 'maximumAge', 'referenceDate'], [], `policyDocument.${category}.age`);
  const minimumAge = integer(age.minimumAge, `${category}.age.minimumAge`, 0, 130);
  const maximumAge = integer(age.maximumAge, `${category}.age.maximumAge`, 0, 130);
  if (minimumAge > maximumAge) fail('INVALID_POLICY', `Category "${category}" has minimumAge above maximumAge.`);

  const education = record(policy.education, `policyDocument.${category}.education`);
  exactKeys(education, ['mode', 'threshold'], [], `policyDocument.${category}.education`);
  const educationMode = safeCode(education.mode, `${category}.education.mode`);
  let educationThreshold: string | number;
  if (typeof education.threshold === 'number') {
    if (!Number.isFinite(education.threshold)) fail('INVALID_POLICY', `Category "${category}" has an invalid education threshold.`);
    educationThreshold = Object.is(education.threshold, -0) ? 0 : education.threshold;
  } else {
    educationThreshold = requiredString(education.threshold, `${category}.education.threshold`, 100);
  }

  const documents = stringSet(
    policy.requiredDocumentTypes,
    `${category}.requiredDocumentTypes`,
    DOCUMENT_TYPES,
  ) as readonly DocumentType[];
  const legalBasis = record(policy.legalBasis, `policyDocument.${category}.legalBasis`);
  exactKeys(legalBasis, ['code', 'reference'], [], `policyDocument.${category}.legalBasis`);

  return {
    age: {
      minimumAge,
      maximumAge,
      referenceDate: dateOnly(age.referenceDate, `${category}.age.referenceDate`),
    },
    education: { mode: educationMode, threshold: educationThreshold },
    criminalThreshold: safeCode(policy.criminalThreshold, `${category}.criminalThreshold`),
    requiredDocumentTypes: documents,
    medicalMode: safeCode(policy.medicalMode, `${category}.medicalMode`),
    legalBasis: {
      code: safeCode(legalBasis.code, `${category}.legalBasis.code`),
      reference: requiredString(legalBasis.reference, `${category}.legalBasis.reference`, 256),
    },
  };
}

export function normalizeCampaignPolicy(
  value: unknown,
  campaignCategories: readonly ApplicationCategory[],
): CampaignPolicyInput {
  const body = record(value, 'body');
  exactKeys(body, ['publicCode', 'policyDocument', 'legalBasisCode', 'legalBasisReference'], [], 'body');
  const rawPolicies = record(body.policyDocument, 'policyDocument');
  const expected = new Set(campaignCategories);
  const actual = Object.keys(rawPolicies);
  if (actual.length !== expected.size || actual.some((category) => !expected.has(category as ApplicationCategory))) {
    fail('POLICY_CATEGORY_COVERAGE_MISMATCH', 'Policy document must define exactly the campaign target categories.');
  }
  const normalized: Record<string, CampaignCategoryPolicy> = {};
  for (const category of [...expected].sort()) {
    normalized[category] = asPolicy(rawPolicies[category], category);
  }
  return {
    publicCode: normalizePublicCode(body.publicCode),
    policyDocument: normalized,
    legalBasisCode: safeCode(body.legalBasisCode, 'legalBasisCode'),
    legalBasisReference: requiredString(body.legalBasisReference, 'legalBasisReference', 256),
  };
}

export function normalizeCampaignPublicCodeCommand(value: unknown): string {
  const body = record(value, 'body');
  exactKeys(body, ['publicCode'], [], 'body');
  return normalizePublicCode(body.publicCode);
}

export function normalizeCampaignSession(value: unknown): CampaignSessionInput {
  const body = record(value, 'body');
  exactKeys(
    body,
    ['publicCode', 'district', 'province', 'venueName', 'examDate', 'reportingTimeHour', 'capacityLimit', 'isActive'],
    [],
    'body',
  );
  if (typeof body.district !== 'string' || !DISTRICTS.includes(body.district as District)) {
    fail('INVALID_DISTRICT', 'Field "district" must be a recognized district.');
  }
  if (typeof body.province !== 'string' || !PROVINCES.includes(body.province as Province)) {
    fail('INVALID_PROVINCE', 'Field "province" must be a recognized province.');
  }
  const district = body.district as District;
  const province = body.province as Province;
  if (DISTRICT_TO_PROVINCE[district] !== province) {
    fail('DISTRICT_PROVINCE_MISMATCH', 'The supplied province does not own the selected district.');
  }
  let capacityLimit: number | null;
  if (body.capacityLimit === null) {
    capacityLimit = null;
  } else {
    capacityLimit = integer(body.capacityLimit, 'capacityLimit', 1, 2_147_483_647);
  }
  if (typeof body.isActive !== 'boolean') fail('INVALID_REQUEST', 'Field "isActive" must be a boolean.');
  return {
    publicCode: normalizePublicCode(body.publicCode),
    district,
    province,
    venueName: requiredString(body.venueName, 'venueName', 200),
    examDate: dateOnly(body.examDate, 'examDate'),
    reportingTimeHour: integer(body.reportingTimeHour, 'reportingTimeHour', 0, 23),
    capacityLimit,
    isActive: body.isActive,
  };
}

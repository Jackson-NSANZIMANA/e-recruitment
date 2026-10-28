// ══════════════════════════════════════════════════════════════════
// identity-service — NIDA identity MAPPING (IremboGov format → domain)
//
// Pure. Translates the captured IremboGov envelope (ADR-047 §1,
// tools/g2g-sandbox/contracts/irembo-user-profile-with-identity-info.schema.json)
// into NidaCitizen. Kept apart from the transport (nida.irembo-transport.ts)
// so the G2G channel can change at cutover without touching this file.
//
// EVERY CAPTURED FIELD, and what happens to it:
//   envelope   status, responseCode     → FOUND / NOT_FOUND / fault
//              message, timestamp, traceId → not kept (traceId is NIDA's;
//                                        our nidaRequestId is the audit key)
//   identityInfo
//     surname, forename                 → fullName "SURNAME Forename"
//     dateOfBirth  DD/MM/YYYY           → ISO date
//     sex          MALE/FEMALE          → gender
//     district                          → homeDistrict (enum); province is
//                                         DERIVED from it (authoritative map),
//                                         the record's province label is only
//                                         cross-checked
//     nationality, citizenStatus        → citizenshipStatus (RW + NORMAL only
//                                         is RWANDAN_CITIZEN)
//     dateOfExpiry DD/MM/YYYY           → idDocumentExpired (flag only)
//     photo, signature                  → NEVER read: portraits are B1–B3's,
//                                         fail-closed (ADR-037 NIDA_PORTRAIT)
//     fatherName, motherName, civilStatus, maritalStatus, spouse,
//     sector, cell, village, villageId, placeOfBirth, countryOfBirth,
//     birthCountry, countryOfDomicile(+Code), documentNumber, documentType,
//     issueNumber, dateOfIssue, placeOfIssue, nin, applicantType, status,
//     applicationNumber, timeSubmitted, email, message
//                                       → not mapped: data minimisation. The
//                                         form pre-fill (S12a hand-off) may
//                                         need some; it gets them through a
//                                         reviewed contract, not here.
//   userProfileDto (all 16 fields)      → not mapped: it is the citizen's
//                                         Irembo ACCOUNT, not the NIDA record;
//                                         a G2G channel will not carry it, and
//                                         USRP never holds a phone from NIDA
//                                         (ADR-029).
// ══════════════════════════════════════════════════════════════════

import { DISTRICT_TO_PROVINCE, type District, type Province } from '@usrp/shared-types';
import { parseDateOfBirth } from '@usrp/shared-identity-match';
import { RWANDAN_CITIZEN, type NidaCitizen } from '../domain/nida.types.js';

export type IremboMapping =
  | { readonly kind: 'FOUND'; readonly citizen: NidaCitizen }
  | { readonly kind: 'NOT_FOUND' }
  /** A malformed or status:false answer: an infrastructure fault, never a verdict. */
  | { readonly kind: 'FAULT'; readonly reason: string };

/** Province labels as the identity record renders them (Kinyarwanda and English). */
const PROVINCE_LABELS: Readonly<Record<string, Province>> = {
  'umujyi wa kigali': 'KIGALI_CITY', kigali: 'KIGALI_CITY', 'kigali city': 'KIGALI_CITY', 'city of kigali': 'KIGALI_CITY',
  amajyaruguru: 'NORTHERN_PROVINCE', north: 'NORTHERN_PROVINCE', northern: 'NORTHERN_PROVINCE', 'northern province': 'NORTHERN_PROVINCE',
  amajyepfo: 'SOUTHERN_PROVINCE', south: 'SOUTHERN_PROVINCE', southern: 'SOUTHERN_PROVINCE', 'southern province': 'SOUTHERN_PROVINCE',
  iburasirazuba: 'EASTERN_PROVINCE', east: 'EASTERN_PROVINCE', eastern: 'EASTERN_PROVINCE', 'eastern province': 'EASTERN_PROVINCE',
  iburengerazuba: 'WESTERN_PROVINCE', west: 'WESTERN_PROVINCE', western: 'WESTERN_PROVINCE', 'western province': 'WESTERN_PROVINCE',
};

/** responseCodes the sandbox answers for an unknown subject (assumption until the G2G channel defines it). */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['USER_PROFILE_NOT_FOUND', 'IDENTITY_NOT_FOUND', 'NOT_FOUND']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function districtOf(label: string): District | null {
  const key = label.trim().toUpperCase().replace(/[^A-Z]/g, '');
  return Object.hasOwn(DISTRICT_TO_PROVINCE, key) ? (key as District) : null;
}

/** Map the IremboGov envelope. `today` is an ISO date for the expiry flag. Pure. */
export function mapIremboIdentity(envelope: unknown, today: string, requestedNationalId: string): IremboMapping {
  if (!isRecord(envelope) || typeof envelope['status'] !== 'boolean') return { kind: 'FAULT', reason: 'not an Irembo envelope' };
  if (!envelope['status']) {
    const code = str(envelope['responseCode']) ?? '';
    return NOT_FOUND_CODES.has(code) ? { kind: 'NOT_FOUND' } : { kind: 'FAULT', reason: 'status:false' };
  }
  const data = envelope['data'];
  const info = isRecord(data) ? data['identityInfo'] : undefined;
  const profile = isRecord(data) ? data['userProfileDto'] : undefined;
  if (!isRecord(info) || !isRecord(profile)) return { kind: 'FAULT', reason: 'identity record missing' };
  const requestedDigits = requestedNationalId.replace(/\s+/g, '');
  const profileDigits = str(profile['identificationNumber'])?.replace(/\s+/g, '') ?? '';
  const documentDigits = str(info['documentNumber'])?.replace(/\s+/g, '') ?? '';
  if (!/^\d{16}$/.test(requestedDigits) || profileDigits !== requestedDigits || documentDigits !== requestedDigits) {
    return { kind: 'FAULT', reason: 'identity record does not match the requested subject' };
  }

  const surname = str(info['surname']);
  const forename = str(info['forename']);
  const dob = str(info['dateOfBirth']);
  const iso = dob === null ? null : parseDateOfBirth(dob);
  const sex = str(info['sex'])?.toUpperCase() ?? null;
  const districtLabel = str(info['district']);
  const district = districtLabel === null ? null : districtOf(districtLabel);
  const nationality = str(info['nationality'])?.toUpperCase() ?? null;
  const citizenStatus = str(info['citizenStatus'])?.toUpperCase() ?? null;
  if (surname === null || forename === null || iso === null || (sex !== 'MALE' && sex !== 'FEMALE') || district === null || nationality === null || citizenStatus === null) {
    return { kind: 'FAULT', reason: 'identity record missing or malformed required fields' };
  }
  const province = DISTRICT_TO_PROVINCE[district];
  const provinceLabel = str(info['province']);
  if (provinceLabel !== null) {
    const labelled = PROVINCE_LABELS[provinceLabel.toLowerCase()];
    if (labelled !== undefined && labelled !== province) return { kind: 'FAULT', reason: 'district and province disagree' };
  }
  const expiry = str(info['dateOfExpiry']);
  const expiryIso = expiry === null ? null : parseDateOfBirth(expiry);
  const citizenshipStatus = nationality !== 'RW' ? 'NON_CITIZEN' : citizenStatus !== 'NORMAL' ? `CITIZEN_STATUS_${citizenStatus.replace(/[^A-Z_]/g, '')}` : RWANDAN_CITIZEN;
  return {
    kind: 'FOUND',
    citizen: {
      fullName: `${surname} ${forename}`,
      dateOfBirth: iso,
      gender: sex,
      homeDistrict: district,
      homeProvince: province,
      citizenshipStatus,
      idDocumentExpired: expiryIso !== null && expiryIso < today,
    },
  };
}

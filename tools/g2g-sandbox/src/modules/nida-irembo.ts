// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — nida-irembo: NIDA identity in the IremboGov wire format
//
//   GET /auth/v1/user-profile-with-identity-info
//   Authorization: Bearer <sandbox G2G client token>   (NEVER a citizen token)
//   x-usrp-subject: <16-digit NID>
//
// Found: the exact Irembo envelope with data.userProfileDto + data.identityInfo
// (contracts/irembo-user-profile-with-identity-info.schema.json).
//
// SANDBOX ASSUMPTIONS (the citizen endpoint never shows them; the production
// G2G channel will define them): unknown subject → HTTP 200,
// status:false, responseCode USER_PROFILE_NOT_FOUND, data:null; bad or missing
// credential → 401 UNAUTHORIZED; malformed subject → 400 INVALID_SUBJECT.
// ══════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { SimRequest, SimResponse, SimulatorModule, Subject } from '../module.js';
import { districtLabel, PROVINCE_LABEL_RW } from '../population/geography.js';
import type { SyntheticCitizen } from '../population/model.js';
import { spacedDocumentNumber } from '../population/nid.js';
import { syntheticPortrait, syntheticSignature } from '../population/portrait.js';
import { iremboEnvelope } from './irembo-envelope.js';

export const NIDA_IDENTITY_PATH = '/auth/v1/user-profile-with-identity-info';
export const SUBJECT_HEADER = 'x-usrp-subject';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO → DD/MM/YYYY, the registry's date format. */
export function ddmmyyyy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** "Jan 05 2016  9:41AM": the legacy timestamp format observed in identityInfo. */
function timeSubmitted(iso: string): string {
  const month = MONTHS[Number(iso.slice(5, 7)) - 1] ?? 'Jan';
  return `${month} ${iso.slice(8, 10)} ${iso.slice(0, 4)}  9:41AM`;
}

/** A stable synthetic UUID per citizen. */
function stableUuid(key: string): string {
  const h = createHash('sha256').update(`irembo-user:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function identityInfoOf(c: SyntheticCitizen): Record<string, unknown> {
  return {
    documentNumber: spacedDocumentNumber(c.nid),
    documentType: '1',
    issueNumber: String(c.issueNumber),
    dateOfIssue: ddmmyyyy(c.dateOfIssue),
    dateOfExpiry: ddmmyyyy(c.dateOfExpiry),
    placeOfIssue: 'Sandbox / Synthetic',
    nin: null,
    forename: c.forename,
    surname: c.surname,
    fatherName: c.fatherName,
    motherName: c.motherName,
    sex: c.sex,
    dateOfBirth: ddmmyyyy(c.dateOfBirth),
    placeOfBirth: c.placeOfBirth,
    countryOfBirth: 'RW',
    villageId: c.address.villageId,
    village: c.address.village,
    cell: c.address.cell,
    sector: c.address.sector,
    district: districtLabel(c.address.district),
    province: PROVINCE_LABEL_RW[c.address.province],
    civilStatus: c.civilStatus,
    spouse: '',
    photo: syntheticPortrait(c.key),
    signature: syntheticSignature(c.key),
    nationality: c.nationality,
    applicantType: '1',
    status: '0',
    applicationNumber: `99${c.nid.slice(9, 15)}`,
    birthCountry: 'RW',
    maritalStatus: c.civilStatus,
    timeSubmitted: timeSubmitted(c.dateOfIssue),
    email: null,
    countryOfDomicileCode: 'RW',
    countryOfDomicile: 'Rwanda',
    citizenStatus: c.citizenStatus,
    message: null,
  };
}

function userProfileOf(key: string, nid: string, phone: string | null): Record<string, unknown> {
  return {
    userId: stableUuid(key),
    identificationType: 'NID',
    identificationNumber: nid,
    accountVerified: true,
    notificationPhoneNumber: phone,
    notificationEmail: null,
    notificationType: 'PHONE_NUMBER',
    firstLogin: false,
    verificationMethod: 'NID_WITH_PHONE_NUMBER',
    consularCardNumber: null,
    verificationEmail: null,
    verificationPhoneNumber: phone,
    firstName: null,
    lastName: null,
    accountCreatedAt: '2024-01-15T08:00:00.000000Z',
    lastUpdated: '2025-06-01T08:00:00.000000Z',
  };
}

function bearer(req: SimRequest): string | null {
  const raw = req.header('authorization');
  const match = raw === null ? null : /^Bearer\s+(\S+)$/i.exec(raw);
  return match?.[1] ?? null;
}

export const nidaIremboModule: SimulatorModule = {
  id: 'nida-irembo',
  authority: 'nida',
  matches: (method, path) => method === 'GET' && path === NIDA_IDENTITY_PATH,
  authorize(req, world) {
    const token = bearer(req);
    if (token === null || !world.clientTokens.has(token)) {
      return { status: 401, json: iremboEnvelope(world.now(), false, 'UNAUTHORIZED', null) };
    }
    return { client: `token:${createHash('sha256').update(token).digest('hex').slice(0, 12)}` };
  },
  subject(req, world): Subject | null {
    const nid = req.header(SUBJECT_HEADER)?.trim() ?? '';
    if (world.overlay !== null && world.overlay.nid === nid) return { kind: 'private', persona: world.overlay };
    const citizen = world.population.findByNid(nid);
    return citizen === null ? null : { kind: 'synthetic', citizen };
  },
  fault(kind, world): SimResponse {
    if (kind === 'rate-limited') return { status: 429, json: iremboEnvelope(world.now(), false, 'TOO_MANY_REQUESTS', null) };
    if (kind === 'maintenance') return { status: 503, json: iremboEnvelope(world.now(), false, 'SERVICE_UNAVAILABLE', null) };
    return { status: 200, json: iremboEnvelope(world.now(), false, 'INTERNAL_SERVER_ERROR', null) };
  },
  handle(req, subject, world): SimResponse {
    const nid = req.header(SUBJECT_HEADER)?.trim() ?? '';
    if (!/^\d{16}$/.test(nid)) return { status: 400, json: iremboEnvelope(world.now(), false, 'INVALID_SUBJECT', null) };
    if (subject === null) return { status: 200, json: iremboEnvelope(world.now(), false, 'USER_PROFILE_NOT_FOUND', null) };
    const data = subject.kind === 'private'
      ? { userProfileDto: userProfileOf('PRIVATE', subject.persona.nid, null), identityInfo: subject.persona.identityInfo }
      : { userProfileDto: userProfileOf(subject.citizen.key, subject.citizen.nid, subject.citizen.phone), identityInfo: identityInfoOf(subject.citizen) };
    return { status: 200, json: iremboEnvelope(world.now(), true, 'USER_PROFILE_FOUND', data) };
  },
};

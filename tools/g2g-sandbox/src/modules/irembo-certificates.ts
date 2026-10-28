// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — irembo-certificates: certificate verification, IremboGov wire
//
//   GET /irembo/rest/public/request/verify-certificate-by-application-number
//   applicationnumber: <letter, 12 digits, 4 letters>
//   Authorization: Bearer <sandbox G2G client token>   (NEVER a citizen token)
//
// Found: {status, data:{ISSUED_ON, STATUS, REFERENCE_NUMBER, SIGNED_BY,
// DATE_OF_BIRTH, APPLICATION_CODE, NAME}, responseCode "3104", message
// "Dosiye yabonetse", responseEncrypted, traceId}
// (contracts/irembo-certificate-verification.schema.json; shape only, no value
// from the third-party sample appears here).
//
// SANDBOX ASSUMPTIONS until a live capture shows them: not found → HTTP 200,
// status:false, responseCode 3105, "Dosiye ntabwo yabonetse", data null; a
// malformed number → 400 / 4000; any other failure → status:false with
// responseCode 5000 (so an adapter can tell "no such certificate" from "the
// registry failed", which must never become a negative verdict).
// The APPLICATION_CODE values are clearly named PLACEHOLDERS (model.ts).
// ══════════════════════════════════════════════════════════════════

import { createHash, randomBytes } from 'node:crypto';
import type { SimResponse, SimulatorModule, Subject } from '../module.js';
import { ddmmyyyy } from './nida-irembo.js';

export const IREMBO_CERTIFICATE_PATH = '/irembo/rest/public/request/verify-certificate-by-application-number';
export const APPLICATION_NUMBER_HEADER = 'applicationnumber';
/** The observed shape of the citizen-held number: a letter, 12 digits, 4 letters. */
export const APPLICATION_NUMBER_PATTERN = /^[A-Z][0-9]{12}[A-Z]{4}$/;

export const CERT_CODES = {
  FOUND: { code: '3104', message: 'Dosiye yabonetse' },
  NOT_FOUND: { code: '3105', message: 'Dosiye ntabwo yabonetse' },
  BAD_NUMBER: { code: '4000', message: 'Nimero ya dosiye ntiyujujwe neza' },
  UNAUTHORIZED: { code: '4010', message: 'Ntabwo wemerewe' },
  TOO_MANY: { code: '4290', message: 'Ibyifuzo byabaye byinshi, ongera ugerageze nyuma' },
  UNAVAILABLE: { code: '5030', message: 'Serivisi ntiboneka muri iki gihe' },
  FAILED: { code: '5000', message: 'Habaye ikibazo, ongera ugerageze' },
} as const;

type CodeEntry = (typeof CERT_CODES)[keyof typeof CERT_CODES];

function envelope(entry: CodeEntry, status: boolean, data: Record<string, unknown> | null): Record<string, unknown> {
  return { status, data, responseCode: entry.code, message: entry.message, responseEncrypted: false, traceId: randomBytes(16).toString('hex') };
}

function bearer(header: string | null): string | null {
  const match = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

export const iremboCertificatesModule: SimulatorModule = {
  id: 'irembo-certificates',
  authority: 'irembo-certificates',
  matches: (method, path) => method === 'GET' && path === IREMBO_CERTIFICATE_PATH,
  authorize(req, world) {
    const token = bearer(req.header('authorization'));
    if (token === null || !world.clientTokens.has(token)) {
      return { status: 401, json: envelope(CERT_CODES.UNAUTHORIZED, false, null) };
    }
    return { client: `token:${createHash('sha256').update(token).digest('hex').slice(0, 12)}` };
  },
  subject(req, world): Subject | null {
    const number = req.header(APPLICATION_NUMBER_HEADER)?.trim() ?? '';
    const hit = world.population.findByCertificate(number);
    return hit === null ? null : { kind: 'synthetic', citizen: hit.citizen };
  },
  fault(kind): SimResponse {
    if (kind === 'rate-limited') return { status: 429, json: envelope(CERT_CODES.TOO_MANY, false, null) };
    if (kind === 'maintenance') return { status: 503, json: envelope(CERT_CODES.UNAVAILABLE, false, null) };
    return { status: 200, json: envelope(CERT_CODES.FAILED, false, null) };
  },
  handle(req, subject, world): SimResponse {
    const number = req.header(APPLICATION_NUMBER_HEADER)?.trim() ?? '';
    if (!APPLICATION_NUMBER_PATTERN.test(number)) return { status: 400, json: envelope(CERT_CODES.BAD_NUMBER, false, null) };
    const hit = world.population.findByCertificate(number);
    if (hit === null || subject === null) return { status: 200, json: envelope(CERT_CODES.NOT_FOUND, false, null) };
    const c = hit.certificate;
    return {
      status: 200,
      json: envelope(CERT_CODES.FOUND, true, {
        ISSUED_ON: ddmmyyyy(c.issuedOn),
        STATUS: c.status,
        REFERENCE_NUMBER: c.applicationNumber,
        SIGNED_BY: c.signedBy,
        DATE_OF_BIRTH: ddmmyyyy(c.dateOfBirth),
        APPLICATION_CODE: c.applicationCode,
        NAME: c.name,
      }),
    };
  },
};

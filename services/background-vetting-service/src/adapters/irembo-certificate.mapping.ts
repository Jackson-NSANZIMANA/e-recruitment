// ══════════════════════════════════════════════════════════════════
// background-vetting-service — the PURE mapping of the Irembo certificate
// envelope (contracts/irembo-certificate-verification.schema.json in
// tools/g2g-sandbox) into the domain's ClearanceLookup.
//
//   status:true  + data                         → FOUND
//   status:false + responseCode 3105, data null → NOT_FOUND (a SANDBOX
//        ASSUMPTION until a live capture of a missing number exists)
//   anything else (any other status:false code, a missing field, a bad
//   date, a non-object body)                    → FAULT
//
// A fault is never "not found": the caller throws the retryable error.
// Values from the body never appear in a reason string.
// ══════════════════════════════════════════════════════════════════

import type { ClearanceCertificate } from '../domain/clearance.types.js';

/** The Irembo responseCode that means "no certificate with this number" (sandbox assumption). */
export const IREMBO_NOT_FOUND_CODE = '3105';

export type CertificateMapping =
  | { readonly kind: 'FOUND'; readonly certificate: ClearanceCertificate }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FAULT'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** DD/MM/YYYY → ISO, calendar-checked; null if it is not a real date. */
export function isoFromDdMmYyyy(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (match === null) return null;
  const [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export function mapIremboCertificate(body: unknown): CertificateMapping {
  if (!isRecord(body)) return { kind: 'FAULT', reason: 'body is not an object' };
  if (body['status'] === false) {
    return body['responseCode'] === IREMBO_NOT_FOUND_CODE && body['data'] === null
      ? { kind: 'NOT_FOUND' }
      : { kind: 'FAULT', reason: 'registry answered status:false' };
  }
  if (body['status'] !== true) return { kind: 'FAULT', reason: 'status is not a boolean' };
  const data = body['data'];
  if (!isRecord(data)) return { kind: 'FAULT', reason: 'data is not an object' };
  const type = data['APPLICATION_CODE'];
  const name = data['NAME'];
  const reference = data['REFERENCE_NUMBER'];
  const issuedOn = isoFromDdMmYyyy(data['ISSUED_ON']);
  const dob = isoFromDdMmYyyy(data['DATE_OF_BIRTH']);
  if (typeof data['STATUS'] !== 'boolean') return { kind: 'FAULT', reason: 'STATUS is not a boolean' };
  if (typeof type !== 'string' || !/^[A-Z0-9_]+$/.test(type)) return { kind: 'FAULT', reason: 'APPLICATION_CODE is unusable' };
  if (typeof name !== 'string' || name.trim() === '') return { kind: 'FAULT', reason: 'NAME is unusable' };
  if (typeof reference !== 'string') return { kind: 'FAULT', reason: 'REFERENCE_NUMBER is unusable' };
  if (issuedOn === null) return { kind: 'FAULT', reason: 'ISSUED_ON is not a date' };
  if (dob === null) return { kind: 'FAULT', reason: 'DATE_OF_BIRTH is not a date' };
  return {
    kind: 'FOUND',
    certificate: { authentic: data['STATUS'], type, issuedOn, holderName: name, holderDob: dob, reference },
  };
}

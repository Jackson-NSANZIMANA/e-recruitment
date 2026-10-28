// ══════════════════════════════════════════════════════════════════
// background-vetting-service — Irembo certificate TRANSPORT (swappable at cutover)
//
//   GET {base}/irembo/rest/public/request/verify-certificate-by-application-number
//   applicationnumber: <number>
//   Authorization: Bearer <G2G client token>
//
// The citizen-session API answers to the citizen's own bearer; USRP never
// holds one (ADR-047 §1). The sandbox accepts a sandbox G2G client token; the
// production channel (RISA/Irembo interoperability) will differ, and replacing
// THIS module is the whole cutover. The mapping lives elsewhere.
// ══════════════════════════════════════════════════════════════════

import { ClearanceRegistryUnavailableError } from '../domain/clearance.types.js';

export const IREMBO_CERTIFICATE_PATH = '/irembo/rest/public/request/verify-certificate-by-application-number';

export interface CertificateTransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

export interface IremboCertificateTransport {
  fetchCertificate(applicationNumber: string, requestId: string): Promise<CertificateTransportResponse>;
}

export interface HttpIremboCertificateTransportOptions {
  readonly baseUrl: string;
  /** Secret. Held privately; never logged. */
  readonly clientToken: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class HttpIremboCertificateTransport implements IremboCertificateTransport {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpIremboCertificateTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.clientToken;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async fetchCertificate(applicationNumber: string, requestId: string): Promise<CertificateTransportResponse> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}${IREMBO_CERTIFICATE_PATH}`, {
        method: 'GET',
        headers: { accept: 'application/json', applicationnumber: applicationNumber, authorization: `Bearer ${this.#token}`, 'x-request-id': requestId },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      return { status: response.status, headers: response.headers, bodyText: await response.text() };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.name : 'unknown';
      throw new ClearanceRegistryUnavailableError(`Irembo certificate request failed (${reason})`, requestId);
    }
  }

  toJSON(): { transport: 'irembo-certificates' } {
    return { transport: 'irembo-certificates' };
  }
}

// ══════════════════════════════════════════════════════════════════
// eligibility-service — NESA results TRANSPORT (swappable at cutover)
//
// The public SDMS endpoint: GET /api/v1/public/results/by-index?indexNumber=.
// No credential (it is public in production too). Today it reaches the
// nesa-sdms simulator; the opt-in live passthrough lives in the simulator,
// so this service never holds the real registry URL in the sandbox.
// ══════════════════════════════════════════════════════════════════

import { NesaUnavailableError } from '../domain/nesa.types.js';

export const SDMS_RESULTS_PATH = '/api/v1/public/results/by-index';

export interface NesaTransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

export interface NesaSdmsTransport {
  fetchResults(indexNumber: string, requestId: string): Promise<NesaTransportResponse>;
}

export interface HttpNesaSdmsTransportOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class HttpNesaSdmsTransport implements NesaSdmsTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpNesaSdmsTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchResults(indexNumber: string, requestId: string): Promise<NesaTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${SDMS_RESULTS_PATH}?indexNumber=${encodeURIComponent(indexNumber)}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-request-id': requestId },
        signal: controller.signal,
      });
      return { status: response.status, headers: response.headers, bodyText: await response.text() };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.name : 'unknown';
      throw new NesaUnavailableError(`NESA request failed (${reason})`, requestId);
    } finally {
      clearTimeout(timer);
    }
  }
}

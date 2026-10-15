// ══════════════════════════════════════════════════════════════════
// identity-service — GateAdmissionGateway adapter (HTTP, ADR-034)
//
// The one identity-service → application-service call that does NOT use the
// service's client credentials: it forwards the officer's own bearer token
// verbatim. A system token here would let identity-service assert an officer
// identity on application-service's behalf; forwarding keeps authorization
// with the human who presented the credential (same rule as the edge tier).
// ══════════════════════════════════════════════════════════════════

import { UpstreamUnavailableError } from '../domain/identity.errors.js';
import type {
  GateAdmissionGateway,
  GateAdmissionRequest,
  GateAdmissionUpstream,
} from '../ports/gate-admission-gateway.js';

export const UPSTREAM_GATE_ADMISSION_PATH = '/v1/applications/admissions/gate';
const DEFAULT_TIMEOUT_MS = 5_000;

export interface HttpGateAdmissionGatewayOptions {
  readonly applicationBaseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class HttpGateAdmissionGateway implements GateAdmissionGateway {
  readonly #opts: HttpGateAdmissionGatewayOptions;
  readonly #fetch: typeof fetch;

  constructor(options: HttpGateAdmissionGatewayOptions) {
    this.#opts = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async admit(officerBearer: string, request: GateAdmissionRequest, correlationId: string): Promise<GateAdmissionUpstream> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#opts.applicationBaseUrl}${UPSTREAM_GATE_ADMISSION_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${officerBearer}`,
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new UpstreamUnavailableError('application-service unreachable', { cause });
    }
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  }
}

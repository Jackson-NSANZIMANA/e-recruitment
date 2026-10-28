// ══════════════════════════════════════════════════════════════════
// identity-service — NidaIremboGateway: the NidaGateway port on the real
// IremboGov identity format (ADR-047). Composes a transport and the pure
// mapping, and enforces fence 2's response half: a PRODUCTION process
// refuses any answer stamped x-usrp-sandbox.
//
// Outcomes: FOUND / NOT_FOUND are return values. Every fault (network,
// timeout, non-2xx including 429/503, truncated or reshaped body,
// status:false, a sandbox answer in production) throws NidaUnavailableError:
// an upstream failure is never a verdict about the citizen.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { isForbiddenSandboxResponse, type EnvSource } from '@usrp/shared-config';
import { hashNationalId } from '@usrp/shared-security';
import type { NidaGateway } from '../ports/nida.gateway.js';
import type { NidaLookupResult } from '../domain/nida.types.js';
import { NidaUnavailableError } from '../domain/identity.errors.js';
import { mapIremboIdentity } from './nida.irembo-mapping.js';
import type { NidaIremboTransport } from './nida.irembo-transport.js';

export interface NidaIremboGatewayOptions {
  readonly transport: NidaIremboTransport;
  /**
   * Key of the G2G subject token HMAC(key, NID) that HEC/RIB credential checks
   * re-present (rls/0005). Unchanged by the move to the Irembo format.
   */
  readonly subjectHmacSecret: string;
  readonly now?: () => Date;
  readonly env?: EnvSource;
}

export class NidaIremboGateway implements NidaGateway {
  constructor(private readonly options: NidaIremboGatewayOptions) {}

  async lookupCitizen(rawNationalId: string): Promise<NidaLookupResult> {
    const requestId = randomUUID();
    // Validates the NID shape before any I/O (throws InvalidNationalIdError).
    const nidaLookupHash = hashNationalId(rawNationalId, this.options.subjectHmacSecret);
    const response = await this.options.transport.fetchIdentity(rawNationalId.trim(), requestId);

    if (isForbiddenSandboxResponse(response.headers, this.options.env ?? process.env)) {
      throw new NidaUnavailableError('NIDA answered from a SANDBOX simulator; refused in production', requestId);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new NidaUnavailableError(`NIDA returned HTTP ${String(response.status)}`, requestId);
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(response.bodyText);
    } catch {
      throw new NidaUnavailableError('NIDA returned a non-JSON or truncated body', requestId);
    }
    const today = (this.options.now ?? ((): Date => new Date()))().toISOString().slice(0, 10);
    const mapped = mapIremboIdentity(envelope, today);
    switch (mapped.kind) {
      case 'NOT_FOUND':
        return { status: 'NOT_FOUND', nidaRequestId: requestId };
      case 'FAULT':
        throw new NidaUnavailableError(`NIDA answer unusable (${mapped.reason})`, requestId);
      case 'FOUND':
        return { status: 'FOUND', nidaRequestId: requestId, citizen: mapped.citizen, nidaLookupHash, matchConfidence: null };
    }
  }
}

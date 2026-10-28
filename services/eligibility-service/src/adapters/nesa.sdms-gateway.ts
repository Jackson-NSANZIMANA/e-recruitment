// ══════════════════════════════════════════════════════════════════
// eligibility-service — NesaSdmsGateway: the NesaGateway port on the real
// SDMS results format (ADR-047). Transport + pure mapping, plus fence 2's
// response half (production refuses an x-usrp-sandbox answer).
//
// 404 is NOT_FOUND (a sandbox assumption until a live capture of a missing
// index exists). Every other non-2xx (429 and 503 included), a truncated
// or reshaped body, or a sandbox answer in production → NesaUnavailableError.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { isForbiddenSandboxResponse, type EnvSource } from '@usrp/shared-config';
import type { NesaGateway } from '../ports/nesa.gateway.js';
import { NesaUnavailableError, type NesaLookupResult } from '../domain/nesa.types.js';
import { mapSdmsResults } from './nesa.sdms-mapping.js';
import type { NesaSdmsTransport } from './nesa.sdms-transport.js';

export interface NesaSdmsGatewayOptions {
  readonly transport: NesaSdmsTransport;
  readonly env?: EnvSource;
}

export class NesaSdmsGateway implements NesaGateway {
  constructor(private readonly options: NesaSdmsGatewayOptions) {}

  async lookupResults(indexNumber: string): Promise<NesaLookupResult> {
    const requestId = randomUUID();
    const index = indexNumber.trim();
    const response = await this.options.transport.fetchResults(index, requestId);
    if (isForbiddenSandboxResponse(response.headers, this.options.env ?? process.env)) {
      throw new NesaUnavailableError('NESA answered from a SANDBOX simulator; refused in production', requestId);
    }
    if (response.status === 404) return { status: 'NOT_FOUND', nesaRequestId: requestId };
    if (response.status < 200 || response.status >= 300) {
      throw new NesaUnavailableError(`NESA returned HTTP ${String(response.status)}`, requestId);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText);
    } catch {
      throw new NesaUnavailableError('NESA returned a non-JSON or truncated body', requestId);
    }
    const mapped = mapSdmsResults(body, index);
    if (mapped.kind === 'FAULT') throw new NesaUnavailableError(`NESA answer unusable (${mapped.reason})`, requestId);
    return { status: 'FOUND', nesaRequestId: requestId, results: mapped.results };
  }
}

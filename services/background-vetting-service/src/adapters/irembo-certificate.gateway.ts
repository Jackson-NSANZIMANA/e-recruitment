// ══════════════════════════════════════════════════════════════════
// background-vetting-service — IremboCertificateGateway: the
// ClearanceCertificateGateway port on the real Irembo envelope (ADR-047/048).
// Transport + pure mapping, plus fence 2's response half (production refuses
// an x-usrp-sandbox answer).
//
// 429, 5xx, any non-2xx, a truncated or reshaped body, a status:false that is
// not "not found", or a sandbox answer in production → the retryable
// ClearanceRegistryUnavailableError. Only the registry's own "no such
// certificate" is NOT_FOUND.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { isForbiddenSandboxResponse, type EnvSource } from '@usrp/shared-config';
import { ClearanceRegistryUnavailableError, type ClearanceLookup } from '../domain/clearance.types.js';
import type { ClearanceCertificateGateway } from '../ports/clearance-certificate.gateway.js';
import { mapIremboCertificate } from './irembo-certificate.mapping.js';
import type { IremboCertificateTransport } from './irembo-certificate.transport.js';

export interface IremboCertificateGatewayOptions {
  readonly transport: IremboCertificateTransport;
  readonly env?: EnvSource;
}

export class IremboCertificateGateway implements ClearanceCertificateGateway {
  constructor(private readonly options: IremboCertificateGatewayOptions) {}

  async verify(applicationNumber: string): Promise<ClearanceLookup> {
    const requestId = randomUUID();
    const response = await this.options.transport.fetchCertificate(applicationNumber, requestId);
    if (isForbiddenSandboxResponse(response.headers, this.options.env ?? process.env)) {
      throw new ClearanceRegistryUnavailableError('Irembo answered from a SANDBOX simulator; refused in production', requestId);
    }
    // 200 carries every Irembo answer, including status:false. 400 is our bug
    // (we validate the shape first), 401 a configuration fault: all faults.
    if (response.status < 200 || response.status >= 300) {
      throw new ClearanceRegistryUnavailableError(`Irembo returned HTTP ${String(response.status)}`, requestId);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText);
    } catch {
      throw new ClearanceRegistryUnavailableError('Irembo returned a non-JSON or truncated body', requestId);
    }
    const mapped = mapIremboCertificate(body);
    if (mapped.kind === 'FAULT') throw new ClearanceRegistryUnavailableError(`Irembo answer unusable (${mapped.reason})`, requestId);
    if (mapped.kind === 'NOT_FOUND') return { status: 'NOT_FOUND', requestId };
    return { status: 'FOUND', certificate: mapped.certificate, requestId };
  }
}

// ══════════════════════════════════════════════════════════════════
// identity-service — NIDA gateway adapter (HTTP over the G2G tunnel)
//
// Talks to the NIDA citizen registry (mocked in dev by usrp-nida-mock).
// Signs every request with the NIDA-shared HMAC secret and a fresh
// requestId + timestamp for replay protection, exactly matching the
// x-hmac-signature / x-request-id / x-timestamp scheme the endpoint
// expects. The raw National ID is hashed with the NIDA-shared secret for
// the lookup and is otherwise never transmitted or logged.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { hashNationalId, signG2GRequest, type G2GSignedHeaders } from '@usrp/shared-security';
import type { Gender } from '@usrp/shared-database';
import type { NidaGateway } from '../ports/nida.gateway.js';
import type { NidaCitizen, NidaLookupResult } from '../domain/nida.types.js';
import { NidaUnavailableError } from '../domain/identity.errors.js';

const LOOKUP_PATH = '/v1/citizen/lookup';
const VALID_GENDERS: ReadonlySet<string> = new Set<Gender>(['MALE', 'FEMALE']);

export interface NidaHttpGatewayOptions {
  readonly baseUrl: string;
  /** NIDA-shared HMAC secret — signs requests AND derives the lookup hash. */
  readonly hmacSecret: string;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Minimal shape we read from a citizen-lookup response. */
interface NidaLookupWire {
  readonly status?: unknown;
  readonly citizen?: {
    readonly fullName?: unknown;
    readonly dateOfBirth?: unknown;
    readonly gender?: unknown;
    readonly homeDistrict?: unknown;
    readonly homeProvince?: unknown;
    readonly registeredPhoneNumber?: unknown;
    readonly citizenshipStatus?: unknown;
  };
}

export class NidaHttpGateway implements NidaGateway {
  private readonly baseUrl: string;
  private readonly hmacSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NidaHttpGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.hmacSecret = options.hmacSecret;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async lookupCitizen(rawNationalId: string): Promise<NidaLookupResult> {
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();

    // NIDA receives only the hash keyed with the NIDA-shared secret; NIDA
    // holds the reverse mapping. hashNationalId validates the NID format.
    const nationalIdHash = hashNationalId(rawNationalId, this.hmacSecret);
    const body = JSON.stringify({ nationalIdHash, requestId });

    const signed = signG2GRequest(this.hmacSecret, {
      method: 'POST',
      path: LOOKUP_PATH,
      timestamp,
      requestId,
      body,
    });

    const response = await this.post(body, signed, requestId);
    return this.mapResponse(response, requestId, nationalIdHash);
  }

  private async post(
    body: string,
    signed: G2GSignedHeaders,
    requestId: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${LOOKUP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signed },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      // Network error or timeout abort — an infrastructure fault. Do not
      // include the raw NID or body in the message.
      const reason = cause instanceof Error ? cause.name : 'unknown';
      throw new NidaUnavailableError(`NIDA request failed (${reason})`, requestId);
    } finally {
      clearTimeout(timer);
    }
  }

  private async mapResponse(
    response: Response,
    requestId: string,
    nidaLookupHash: string,
  ): Promise<NidaLookupResult> {
    if (!response.ok) {
      throw new NidaUnavailableError(`NIDA returned HTTP ${response.status}`, requestId);
    }

    let wire: NidaLookupWire;
    try {
      wire = (await response.json()) as NidaLookupWire;
    } catch {
      throw new NidaUnavailableError('NIDA returned a non-JSON body', requestId);
    }

    if (wire.status === 'NOT_FOUND') {
      return { status: 'NOT_FOUND', nidaRequestId: requestId };
    }
    if (wire.status !== 'FOUND' || wire.citizen === undefined) {
      throw new NidaUnavailableError(`NIDA returned unexpected status "${String(wire.status)}"`, requestId);
    }

    return {
      status: 'FOUND',
      nidaRequestId: requestId,
      citizen: this.mapCitizen(wire.citizen, requestId),
      nidaLookupHash, // the G2G subject hash NIDA resolved this citizen by
      matchConfidence: null, // demographic lookup carries no biometric score
    };
  }

  private mapCitizen(raw: NonNullable<NidaLookupWire['citizen']>, requestId: string): NidaCitizen {
    const fullName = raw.fullName;
    const dateOfBirth = raw.dateOfBirth;
    const gender = raw.gender;
    const homeDistrict = raw.homeDistrict;
    const homeProvince = raw.homeProvince;
    const citizenshipStatus = raw.citizenshipStatus;

    if (
      typeof fullName !== 'string' ||
      typeof dateOfBirth !== 'string' ||
      typeof gender !== 'string' ||
      !VALID_GENDERS.has(gender) ||
      typeof homeDistrict !== 'string' ||
      typeof homeProvince !== 'string' ||
      typeof citizenshipStatus !== 'string'
    ) {
      throw new NidaUnavailableError('NIDA citizen record is missing required fields', requestId);
    }

    const phone = raw.registeredPhoneNumber;
    return {
      fullName,
      dateOfBirth,
      gender: gender as Gender,
      homeDistrict,
      homeProvince,
      registeredPhoneNumber: typeof phone === 'string' ? phone : null,
      citizenshipStatus,
    };
  }
}

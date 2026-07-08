// ══════════════════════════════════════════════════════════════════
// eligibility-service — HEC gateway adapter (HTTP over the G2G tunnel)
//
// Talks to the HEC (Higher Education Council) degree registry (mocked in
// dev by usrp-hec-mock). Signs every request with the HEC-shared HMAC
// secret and a fresh requestId + timestamp for replay protection — the
// same scheme NIDA/NESA use. The applicant's G2G subject hash is sent in
// the body so HEC can bind the degree to its holder; it is never logged.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { signG2GRequest, type G2GSignedHeaders } from '@usrp/shared-security';
import { EDUCATION_LEVELS, type EducationLevel, type HECVerifiedPayload } from '@usrp/shared-types';
import type { HecGateway } from '../ports/hec.gateway.js';
import type { HecLookupResult } from '../domain/hec.types.js';
import { HecUnavailableError } from '../domain/hec.types.js';

const VERIFY_PATH = '/v1/degree/verify';
const VALID_LEVELS: ReadonlySet<string> = new Set<EducationLevel>(EDUCATION_LEVELS);

export interface HecHttpGatewayOptions {
  readonly baseUrl: string;
  /** HEC-shared HMAC secret — signs G2G requests. */
  readonly hmacSecret: string;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Minimal shape we read from a degree-verify response. */
interface HecVerifyWire {
  readonly verified?: unknown;
  readonly reason?: unknown;
  readonly registrationNumber?: unknown;
  readonly institutionName?: unknown;
  readonly degreeTitle?: unknown;
  readonly educationLevel?: unknown;
  readonly specialistField?: unknown;
  readonly graduationYear?: unknown;
}

export class HecHttpGateway implements HecGateway {
  private readonly baseUrl: string;
  private readonly hmacSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HecHttpGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.hmacSecret = options.hmacSecret;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verifyDegree(registrationNumber: string, holderNidaLookupHash: string): Promise<HecLookupResult> {
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();
    // HEC keys the holder by the G2G subject hash — the field is named
    // nationalIdHash on the wire (HEC's contract), but it is the G2G hash.
    const body = JSON.stringify({ registrationNumber, nationalIdHash: holderNidaLookupHash, requestId });

    const signed = signG2GRequest(this.hmacSecret, {
      method: 'POST',
      path: VERIFY_PATH,
      timestamp,
      requestId,
      body,
    });

    const response = await this.post(body, signed, requestId);
    return this.mapResponse(response, requestId);
  }

  private async post(body: string, signed: G2GSignedHeaders, requestId: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${VERIFY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signed },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.name : 'unknown';
      throw new HecUnavailableError(`HEC request failed (${reason})`, requestId);
    } finally {
      clearTimeout(timer);
    }
  }

  private async mapResponse(response: Response, requestId: string): Promise<HecLookupResult> {
    if (!response.ok) {
      throw new HecUnavailableError(`HEC returned HTTP ${response.status}`, requestId);
    }

    let wire: HecVerifyWire;
    try {
      wire = (await response.json()) as HecVerifyWire;
    } catch {
      throw new HecUnavailableError('HEC returned a non-JSON body', requestId);
    }

    if (wire.verified === true) {
      return { status: 'VERIFIED', hecRequestId: requestId, payload: this.mapPayload(wire, requestId) };
    }
    if (wire.verified === false) {
      // Distinguish the two business outcomes by the mock's reason code.
      if (wire.reason === 'HOLDER_MISMATCH') {
        return { status: 'HOLDER_MISMATCH', hecRequestId: requestId };
      }
      return { status: 'NOT_FOUND', hecRequestId: requestId };
    }
    throw new HecUnavailableError(`HEC returned unexpected verified="${String(wire.verified)}"`, requestId);
  }

  private mapPayload(wire: HecVerifyWire, requestId: string): HECVerifiedPayload {
    const registrationNumber = wire.registrationNumber;
    const institutionName = wire.institutionName;
    const degreeTitle = wire.degreeTitle;
    const educationLevel = wire.educationLevel;
    const graduationYear = wire.graduationYear;

    if (
      typeof registrationNumber !== 'string' ||
      typeof institutionName !== 'string' ||
      typeof degreeTitle !== 'string' ||
      typeof educationLevel !== 'string' ||
      !VALID_LEVELS.has(educationLevel) ||
      typeof graduationYear !== 'number'
    ) {
      throw new HecUnavailableError('HEC degree record is missing required fields', requestId);
    }

    const rawField = wire.specialistField;
    const specialistField = typeof rawField === 'string' ? rawField : null;

    return {
      registrationNumber,
      institutionName,
      degreeTitle,
      educationLevel: educationLevel as EducationLevel,
      specialistField,
      graduationYear,
      verifiedAt: new Date().toISOString(),
    };
  }
}

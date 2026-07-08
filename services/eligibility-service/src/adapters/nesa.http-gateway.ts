// ══════════════════════════════════════════════════════════════════
// eligibility-service — NESA gateway adapter (HTTP over the G2G tunnel)
//
// Talks to the NESA examination-results registry (mocked in dev by
// usrp-nesa-mock). Signs every request with the NESA-shared HMAC secret
// and a fresh requestId + timestamp for replay protection, exactly the
// x-hmac-signature / x-request-id / x-timestamp scheme NIDA uses — so the
// adapter is forward-compatible with a real, signature-enforcing NESA even
// though the dev mock does not currently verify the signature.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { signG2GRequest, type G2GSignedHeaders } from '@usrp/shared-security';
import {
  QUALIFICATION_LEVELS,
  RWANDAN_ALEVEL_GRADES,
  type NESASubjectResult,
  type NESAVerifiedPayload,
  type QualificationLevel,
  type RwandanALevelGrade,
} from '@usrp/shared-types';
import type { NesaGateway } from '../ports/nesa.gateway.js';
import type { NesaLookupResult } from '../domain/nesa.types.js';
import { NesaUnavailableError } from '../domain/nesa.types.js';

const LOOKUP_PATH = '/v1/results/lookup';
const VALID_QUALIFICATIONS: ReadonlySet<string> = new Set<QualificationLevel>(QUALIFICATION_LEVELS);
const VALID_GRADES: ReadonlySet<string> = new Set<RwandanALevelGrade>(RWANDAN_ALEVEL_GRADES);

export interface NesaHttpGatewayOptions {
  readonly baseUrl: string;
  /** NESA-shared HMAC secret — signs G2G requests. */
  readonly hmacSecret: string;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Minimal shape we read from a results-lookup response. */
interface NesaLookupWire {
  readonly status?: unknown;
  readonly payload?: unknown;
}

export class NesaHttpGateway implements NesaGateway {
  private readonly baseUrl: string;
  private readonly hmacSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NesaHttpGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.hmacSecret = options.hmacSecret;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async lookupResults(indexNumber: string): Promise<NesaLookupResult> {
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ indexNumber, requestId });

    const signed = signG2GRequest(this.hmacSecret, {
      method: 'POST',
      path: LOOKUP_PATH,
      timestamp,
      requestId,
      body,
    });

    const response = await this.post(body, signed, requestId);
    return this.mapResponse(response, requestId);
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
      // Network error or timeout abort — an infrastructure fault.
      const reason = cause instanceof Error ? cause.name : 'unknown';
      throw new NesaUnavailableError(`NESA request failed (${reason})`, requestId);
    } finally {
      clearTimeout(timer);
    }
  }

  private async mapResponse(response: Response, requestId: string): Promise<NesaLookupResult> {
    if (!response.ok) {
      throw new NesaUnavailableError(`NESA returned HTTP ${response.status}`, requestId);
    }

    let wire: NesaLookupWire;
    try {
      wire = (await response.json()) as NesaLookupWire;
    } catch {
      throw new NesaUnavailableError('NESA returned a non-JSON body', requestId);
    }

    if (wire.status === 'NOT_FOUND') {
      return { status: 'NOT_FOUND', nesaRequestId: requestId };
    }
    if (wire.status !== 'FOUND' || wire.payload === undefined) {
      throw new NesaUnavailableError(`NESA returned unexpected status "${String(wire.status)}"`, requestId);
    }

    return {
      status: 'FOUND',
      nesaRequestId: requestId,
      payload: this.mapPayload(wire.payload, requestId),
    };
  }

  private mapPayload(raw: unknown, requestId: string): NESAVerifiedPayload {
    if (raw === null || typeof raw !== 'object') {
      throw new NesaUnavailableError('NESA results payload is not an object', requestId);
    }
    const p = raw as Record<string, unknown>;

    const indexNumber = p['indexNumber'];
    const qualificationLevel = p['qualificationLevel'];
    const yearOfExamination = p['yearOfExamination'];
    const schoolName = p['schoolName'];
    const overallPoints = p['overallPoints'];
    const verificationToken = p['verificationToken'];
    const verifiedAt = p['verifiedAt'];

    if (
      typeof indexNumber !== 'string' ||
      typeof qualificationLevel !== 'string' ||
      !VALID_QUALIFICATIONS.has(qualificationLevel) ||
      typeof yearOfExamination !== 'number' ||
      typeof schoolName !== 'string' ||
      typeof overallPoints !== 'number' ||
      typeof verificationToken !== 'string' ||
      typeof verifiedAt !== 'string'
    ) {
      throw new NesaUnavailableError('NESA results payload is missing required fields', requestId);
    }

    const subjects = this.mapSubjects(p['subjects'], requestId);

    // percentageScore is optional (only the RCS 4-year track uses it).
    const rawPercent = p['percentageScore'];
    const percentageScore = typeof rawPercent === 'number' ? rawPercent : undefined;

    return {
      indexNumber,
      qualificationLevel: qualificationLevel as QualificationLevel,
      yearOfExamination,
      schoolName,
      subjects,
      overallPoints,
      ...(percentageScore !== undefined ? { percentageScore } : {}),
      verificationToken,
      verifiedAt,
    };
  }

  private mapSubjects(raw: unknown, requestId: string): readonly NESASubjectResult[] {
    if (!Array.isArray(raw)) {
      throw new NesaUnavailableError('NESA results payload has no subjects array', requestId);
    }
    return raw.map((entry): NESASubjectResult => {
      if (entry === null || typeof entry !== 'object') {
        throw new NesaUnavailableError('NESA subject entry is not an object', requestId);
      }
      const s = entry as Record<string, unknown>;
      const subjectCode = s['subjectCode'];
      const subjectName = s['subjectName'];
      const grade = s['grade'];
      const points = s['points'];
      if (
        typeof subjectCode !== 'string' ||
        typeof subjectName !== 'string' ||
        typeof grade !== 'string' ||
        !VALID_GRADES.has(grade) ||
        typeof points !== 'number'
      ) {
        throw new NesaUnavailableError('NESA subject entry is missing required fields', requestId);
      }
      return { subjectCode, subjectName, grade: grade as RwandanALevelGrade, points };
    });
  }
}

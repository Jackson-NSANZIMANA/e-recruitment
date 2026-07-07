// ── NIDA Integration Types ────────────────────────────────────────

export type NIDACitizenshipStatus = 'RWANDAN_CITIZEN' | 'FOREIGN_RESIDENT';
export type NIDARecordStatus = 'FOUND' | 'NOT_FOUND' | 'SUSPENDED';

export interface NIDACitizenRecord {
  readonly nationalIdHash: string;
  readonly fullName: string;
  readonly dateOfBirth: string;           // ISO 8601
  readonly gender: 'MALE' | 'FEMALE';
  readonly homeDistrict: string;
  readonly homeProvince: string;
  readonly registeredPhoneNumber: string; // Masked: 07X-XXX-X890
  readonly citizenshipStatus: NIDACitizenshipStatus;
}

export interface NIDALookupResponse {
  readonly status: NIDARecordStatus;
  readonly citizen?: NIDACitizenRecord;
  readonly requestId: string;
  readonly respondedAt: string;
}

export interface NIDABiometricMatchResponse {
  readonly matched: boolean;
  readonly matchConfidence: number;       // 0.0 - 100.0
  readonly matchThreshold: number;        // NIDA configured threshold
  readonly requestId: string;
  readonly respondedAt: string;
}

// ── NESA Integration Types ────────────────────────────────────────

export type NESALookupStatus = 'FOUND' | 'NOT_FOUND' | 'INVALID_INDEX';

export interface NESALookupResponse {
  readonly status: NESALookupStatus;
  readonly payload?: import('./eligibility.types').NESAVerifiedPayload;
  readonly requestId: string;
  readonly respondedAt: string;
}

// ── RIB Integration Types ─────────────────────────────────────────

export type RIBRecordStatus = 'CLEAR' | 'HAS_RECORDS' | 'UNDER_INVESTIGATION';

export interface RIBVettingRequest {
  readonly nationalIdHash: string;
  readonly requestId: string;
  readonly requestingAgency: import('./agency.types').Agency;
  readonly requestedAt: string;
}

export interface RIBVettingResponse {
  readonly status: RIBRecordStatus;
  readonly requestId: string;
  readonly respondedAt: string;
  // No case details returned — only status flag
  // Detailed records require separate authorized physical request
}

// ── G2G Request Envelope (HMAC-signed) ───────────────────────────

export interface G2GRequestEnvelope {
  readonly requestId: string;
  readonly timestamp: string;
  readonly hmacSignature: string;
  readonly payload: unknown;
}

// ══════════════════════════════════════════════════════════════════
// biometric-service — The evidence record USRP-BIO-EVIDENCE.v1 (pure, ADR-037 §3–§5)
//
// The tablet matches the live face against the portrait printed on the
// candidate's card ON THE DEVICE and sends a signed, flat, closed-schema
// record: outcome, integer scores, model, policy. Nothing biometric leaves
// the device, and this module is where the server REFUSES anything that
// could carry an image, a frame, a template or an embedding:
//
//   1. findImagePayload  — deep, before any schema check, so an image-shaped
//      value is named for what it is even under an unknown key: any string
//      over 1 KiB, any `data:` value, any long base64-looking value, any
//      array (an embedding's natural shape) → IMAGE_PAYLOAD_REFUSED;
//   2. parseEvidenceRequest — exactly { record, signature }; the record has
//      exactly the v1 keys, all required, every value a bounded scalar of
//      its declared type → SCHEMA_INVALID;
//   3. checkEvidenceConsistency — the outcome is what the declared policy
//      says the scores mean, consent and reasons agree, and the legal basis
//      in force permits the consent state.
//
// SIGNING INPUT: the UTF-8 bytes of canonicalJson(record) (sorted keys, no
// whitespace, nulls kept). Signature: Ed25519, standard base64, 88 chars.
//
// PURE: no I/O, no clock (callers pass `now`).
// ══════════════════════════════════════════════════════════════════

import { createHash, createPublicKey } from 'node:crypto';
import { canonicalJson, type JsonValue } from '@usrp/shared-security';
import { AGENCIES, type Agency } from '@usrp/shared-types';
import { RECORDING_MODES, type RecordingMode } from './biometric-mode.js';
import {
  BASIS_POINTS_MAX,
  EVIDENCE_OUTCOMES,
  attemptedOutcome,
  thresholdPolicy,
  type EvidenceOutcome,
} from './threshold-policy.js';

export const EVIDENCE_SCHEMA = 'USRP-BIO-EVIDENCE.v1' as const;

/** The edge and the service both cap the whole request at this size. */
export const MAX_EVIDENCE_BODY_BYTES = 4 * 1024;
/** No string anywhere in an evidence request may exceed this (kit: "1 KB"). */
export const MAX_ANY_STRING = 1024;
/** Base64-looking strings longer than this are refused as image-shaped. */
export const MAX_OPAQUE_TOKEN = 128;

export const REFERENCE_SOURCES = ['CARD_PORTRAIT', 'NIDA_PORTRAIT', 'NONE'] as const;
export type ReferenceSourceId = (typeof REFERENCE_SOURCES)[number];

export const EVIDENCE_METHODS = ['FACE_1_1_ON_DEVICE', 'NONE'] as const;
export type EvidenceMethod = (typeof EVIDENCE_METHODS)[number];

export const CONSENT_STATES = ['GIVEN', 'DECLINED', 'NOT_REQUIRED_BY_POLICY'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const NOT_ATTEMPTED_REASONS = [
  'CANDIDATE_DECLINED',
  'CAPTURE_FAILED',
  'CARD_PORTRAIT_UNREADABLE',
  'DEVICE_UNAVAILABLE',
  'NO_REFERENCE_SOURCE',
] as const;
export type NotAttemptedReason = (typeof NOT_ATTEMPTED_REASONS)[number];

/**
 * The legal bases engineering can enforce. Owner decision (ADR-037 §12):
 * CONSENT_OR_DECLINE. NECESSITY exists only so a future DPO decision is a
 * one-line composition change; nothing wires it today.
 */
export type BiometricLegalBasis = 'CONSENT_OR_DECLINE' | 'NECESSITY';

export interface EvidenceRecord {
  readonly schema: typeof EVIDENCE_SCHEMA;
  readonly recordId: string;
  readonly agency: Agency;
  readonly applicationId: string;
  readonly ticketId: string;
  readonly deviceId: string;
  readonly keyId: string;
  readonly referenceSource: ReferenceSourceId;
  readonly method: EvidenceMethod;
  readonly consentState: ConsentState;
  readonly outcome: EvidenceOutcome;
  readonly notAttemptedReason: NotAttemptedReason | null;
  readonly livenessScoreBp: number | null;
  readonly matchScoreBp: number | null;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly thresholdPolicyVersion: string;
  readonly mode: RecordingMode;
  readonly capturedAt: string;
}

/** Every key of a v1 record, all required (nullable ones are sent as null). */
export const EVIDENCE_RECORD_KEYS: readonly (keyof EvidenceRecord)[] = [
  'schema', 'recordId', 'agency', 'applicationId', 'ticketId', 'deviceId', 'keyId',
  'referenceSource', 'method', 'consentState', 'outcome', 'notAttemptedReason',
  'livenessScoreBp', 'matchScoreBp', 'modelId', 'modelVersion',
  'thresholdPolicyVersion', 'mode', 'capturedAt',
];

export interface EvidenceRequest {
  readonly record: EvidenceRecord;
  readonly signature: string;
}

export type EvidenceRejection =
  | 'IMAGE_PAYLOAD_REFUSED'
  | 'SCHEMA_INVALID'
  | 'THRESHOLD_POLICY_UNKNOWN'
  | 'OUTCOME_INCONSISTENT'
  | 'CONSENT_STATE_NOT_PERMITTED'
  | 'CAPTURED_AT_OUT_OF_RANGE';

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: EvidenceRejection };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Ticket ids are 43-char base64url (scheduling); device ids are operator-chosen. */
const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const KEY_ID_RE = /^[0-9a-f]{64}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MODEL_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
const POLICY_VERSION_RE = /^[A-Z][A-Za-z0-9._-]{0,31}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** Ed25519 signatures are 64 bytes: exactly 86 base64 symbols and "==". */
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
const BASE64ISH_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** True when a string could be (part of) an encoded image or embedding. */
export function isImageShapedString(value: string): boolean {
  if (value.length > MAX_ANY_STRING) return true;
  if (/^\s*data:/i.test(value)) return true;
  if (value.length > MAX_OPAQUE_TOKEN && BASE64ISH_RE.test(value.replace(/\s+/g, ''))) return true;
  return false;
}

/**
 * Deep scan of an untrusted evidence request. Returns true when anything in it
 * could carry an image, frame, template or embedding. Runs BEFORE the schema
 * check. Arrays are refused outright: no v1 field is a list, and a list of
 * numbers is exactly what an embedding looks like.
 */
export function findImagePayload(value: unknown, depth = 0): boolean {
  if (depth > 4) return true; // nothing legitimate nests this deep
  if (typeof value === 'string') return isImageShapedString(value);
  if (Array.isArray(value)) return true;
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (findImagePayload(v, depth + 1)) return true;
    }
  }
  return false;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function nullableMatch(value: unknown, re: RegExp): value is string | null {
  return value === null || (typeof value === 'string' && re.test(value));
}

function nullableBasisPoints(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= BASIS_POINTS_MAX);
}

/** PURE. The exact v1 record, or null. */
export function parseEvidenceRecord(raw: unknown): EvidenceRecord | null {
  if (!isPlainObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== EVIDENCE_RECORD_KEYS.length) return null;
  for (const k of EVIDENCE_RECORD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) return null;
  }
  const r = raw;
  if (r['schema'] !== EVIDENCE_SCHEMA) return null;
  if (typeof r['recordId'] !== 'string' || !UUID_RE.test(r['recordId'])) return null;
  if (!oneOf(AGENCIES, r['agency'])) return null;
  if (typeof r['applicationId'] !== 'string' || !UUID_RE.test(r['applicationId'])) return null;
  if (typeof r['ticketId'] !== 'string' || !OPAQUE_ID_RE.test(r['ticketId'])) return null;
  if (typeof r['deviceId'] !== 'string' || !OPAQUE_ID_RE.test(r['deviceId'])) return null;
  if (typeof r['keyId'] !== 'string' || !KEY_ID_RE.test(r['keyId'])) return null;
  if (!oneOf(REFERENCE_SOURCES, r['referenceSource'])) return null;
  if (!oneOf(EVIDENCE_METHODS, r['method'])) return null;
  if (!oneOf(CONSENT_STATES, r['consentState'])) return null;
  if (!oneOf(EVIDENCE_OUTCOMES, r['outcome'])) return null;
  if (r['notAttemptedReason'] !== null && !oneOf(NOT_ATTEMPTED_REASONS, r['notAttemptedReason'])) return null;
  if (!nullableBasisPoints(r['livenessScoreBp']) || !nullableBasisPoints(r['matchScoreBp'])) return null;
  if (!nullableMatch(r['modelId'], MODEL_ID_RE) || !nullableMatch(r['modelVersion'], MODEL_VERSION_RE)) return null;
  if (typeof r['thresholdPolicyVersion'] !== 'string' || !POLICY_VERSION_RE.test(r['thresholdPolicyVersion'])) return null;
  if (!oneOf(RECORDING_MODES, r['mode'])) return null;
  if (typeof r['capturedAt'] !== 'string' || !ISO_INSTANT_RE.test(r['capturedAt'])
      || Number.isNaN(Date.parse(r['capturedAt']))) return null;

  return {
    schema: EVIDENCE_SCHEMA,
    recordId: r['recordId'],
    agency: r['agency'],
    applicationId: r['applicationId'],
    ticketId: r['ticketId'],
    deviceId: r['deviceId'],
    keyId: r['keyId'],
    referenceSource: r['referenceSource'],
    method: r['method'],
    consentState: r['consentState'],
    outcome: r['outcome'],
    notAttemptedReason: r['notAttemptedReason'],
    livenessScoreBp: r['livenessScoreBp'],
    matchScoreBp: r['matchScoreBp'],
    modelId: r['modelId'],
    modelVersion: r['modelVersion'],
    thresholdPolicyVersion: r['thresholdPolicyVersion'],
    mode: r['mode'],
    capturedAt: r['capturedAt'],
  };
}

/** PURE. The image guard, then the exact request shape. */
export function parseEvidenceRequest(raw: unknown): Parsed<EvidenceRequest> {
  if (!isPlainObject(raw)) return { ok: false, reason: 'SCHEMA_INVALID' };
  // The signature is the one long base64 value allowed, and only in its exact form.
  const { signature, ...rest } = raw;
  if (findImagePayload(rest)) return { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' };
  if (typeof signature === 'string' && !SIGNATURE_RE.test(signature) && isImageShapedString(signature)) {
    return { ok: false, reason: 'IMAGE_PAYLOAD_REFUSED' };
  }
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes('record') || !keys.includes('signature')) {
    return { ok: false, reason: 'SCHEMA_INVALID' };
  }
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return { ok: false, reason: 'SCHEMA_INVALID' };
  const record = parseEvidenceRecord(raw['record']);
  if (record === null) return { ok: false, reason: 'SCHEMA_INVALID' };
  return { ok: true, value: { record, signature } };
}

/**
 * PURE, TOTAL. Semantic consistency of a parsed record under the legal basis
 * in force. Returns null when consistent, otherwise the refusal.
 */
export function checkEvidenceConsistency(
  record: EvidenceRecord,
  legalBasis: BiometricLegalBasis,
): EvidenceRejection | null {
  const policy = thresholdPolicy(record.thresholdPolicyVersion);
  if (policy === null) return 'THRESHOLD_POLICY_UNKNOWN';

  // Consent-or-decline: a "not required" state has no basis today.
  if (legalBasis === 'CONSENT_OR_DECLINE' && record.consentState === 'NOT_REQUIRED_BY_POLICY') {
    return 'CONSENT_STATE_NOT_PERMITTED';
  }

  if (record.outcome === 'NOT_ATTEMPTED') {
    const reason = record.notAttemptedReason;
    if (reason === null) return 'OUTCOME_INCONSISTENT';
    if (record.method !== 'NONE') return 'OUTCOME_INCONSISTENT';
    if (record.livenessScoreBp !== null || record.matchScoreBp !== null) return 'OUTCOME_INCONSISTENT';
    if (record.modelId !== null || record.modelVersion !== null) return 'OUTCOME_INCONSISTENT';
    // A decline and its reason always travel together.
    if ((record.consentState === 'DECLINED') !== (reason === 'CANDIDATE_DECLINED')) return 'OUTCOME_INCONSISTENT';
    // "No reference" and the NONE source always travel together.
    if ((record.referenceSource === 'NONE') !== (reason === 'NO_REFERENCE_SOURCE')) return 'OUTCOME_INCONSISTENT';
    return null;
  }

  // An attempted capture: consent given, a real source, a model, both scores.
  if (record.consentState !== 'GIVEN') return 'OUTCOME_INCONSISTENT';
  if (record.notAttemptedReason !== null) return 'OUTCOME_INCONSISTENT';
  if (record.referenceSource === 'NONE' || record.method !== 'FACE_1_1_ON_DEVICE') return 'OUTCOME_INCONSISTENT';
  if (record.modelId === null || record.modelVersion === null) return 'OUTCOME_INCONSISTENT';
  if (record.livenessScoreBp === null || record.matchScoreBp === null) return 'OUTCOME_INCONSISTENT';
  return attemptedOutcome(record.livenessScoreBp, record.matchScoreBp, policy) === record.outcome
    ? null
    : 'OUTCOME_INCONSISTENT';
}

/** Offline tolerance: a record may be up to 24h old; clocks may run 5 min fast. */
export const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** PURE. Whether capturedAt is acceptable at `now`. */
export function isCapturedAtAcceptable(capturedAt: string, now: Date): boolean {
  const t = Date.parse(capturedAt);
  if (Number.isNaN(t)) return false;
  const delta = now.getTime() - t;
  return delta <= MAX_EVIDENCE_AGE_MS && delta >= -MAX_EVIDENCE_FUTURE_SKEW_MS;
}

/** The exact bytes the device signs: canonicalJson(record), UTF-8. */
export function evidenceSigningInput(record: EvidenceRecord): Buffer {
  return Buffer.from(canonicalJson(record as unknown as JsonValue), 'utf8');
}

/** SHA-256 (hex) of the signing input; stored so a row can be re-verified. */
export function evidenceDigest(record: EvidenceRecord): string {
  return createHash('sha256').update(evidenceSigningInput(record)).digest('hex');
}

/**
 * The key id of a device public key: lowercase hex SHA-256 of its SPKI DER.
 * rls/0034 computes the same value in the engine from field_devices.
 */
export function deviceKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

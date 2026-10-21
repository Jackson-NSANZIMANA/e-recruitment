// ══════════════════════════════════════════════════════════════════
// rehearsal — biometric identity evidence, SHADOW (ADR-037)
//
// DEV-ONLY stand-in for the Field Station tablet until B2 builds on-device
// capture. It never captures, holds or sends a face: it signs a SYNTHETIC
// USRP-BIO-EVIDENCE.v1 record (fixed synthetic scores, model
// "rehearsal-synthetic") with a key it enrols through the real
// enrollFieldDevice operation, and records it through the real
// recordBiometricEvidence operation, as the scenario's gate officer.
//
// Then it proves the SHADOW contract from both sides:
//   • the edge answered RECORDED in mode SHADOW, without an outcome;
//   • the agency supervisor's getBiometricEvidence does NOT list it;
//   • the row exists in <agency>_ops.biometric_evidence with mode SHADOW.
//
//   pnpm rehearse --biometric-shadow [personaId]      (default persona A)
//
// The persona's application must already hold an exam QR (the live journey
// or a scheduled pilot run gets it there).
// ══════════════════════════════════════════════════════════════════

import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { canonicalJson, generateDeviceKeyPair, hashNationalId, signEd25519, type JsonValue } from '@usrp/shared-security';
import type { Agency } from '@usrp/shared-types';
import { EdgeSession } from './edge.js';

/** Same well-known dev key as scripts/run-selfchecks.sh; the fence keeps this local. */
const DEV_NATIONAL_ID_HMAC_KEY = 'dev_national_id_hmac_key_min_32_chars!!';
const SCHEMA: Readonly<Record<Agency, string>> = { RDF: 'rdf_ops', RNP: 'rnp_ops', RCS: 'rcs_ops' };

export type EvidenceMode = 'SHADOW' | 'ADVISORY';

export interface SyntheticEvidenceInput {
  readonly recordId: string;
  readonly applicationId: string;
  readonly ticketId: string;
  readonly deviceId: string;
  readonly publicKeyPem: string;
  readonly mode: EvidenceMode;
  readonly capturedAt: string;
}

/** PURE. The key id ADR-037 §4 defines: SHA-256 (hex) of the SPKI DER. */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** PURE. A synthetic MATCH record — integer scores, no biometric data at all. */
export function syntheticEvidenceRecord(input: SyntheticEvidenceInput): Record<string, JsonValue> {
  return {
    schema: 'USRP-BIO-EVIDENCE.v1',
    recordId: input.recordId,
    applicationId: input.applicationId,
    ticketId: input.ticketId,
    deviceId: input.deviceId,
    keyId: keyIdOf(input.publicKeyPem),
    referenceSource: 'CARD_PORTRAIT',
    method: 'FACE_1_1_ON_DEVICE',
    consentState: 'GIVEN',
    outcome: 'MATCH',
    notAttemptedReason: null,
    livenessScoreBp: 9_500,
    matchScoreBp: 9_200,
    modelId: 'rehearsal-synthetic',
    modelVersion: '0.0.0',
    thresholdPolicyVersion: 'BIO-THRESHOLDS.v1',
    mode: input.mode,
    capturedAt: input.capturedAt,
  };
}

/** The ADR-037 signing input: UTF-8 bytes of canonicalJson(record). */
export function signEvidenceRecord(record: Record<string, JsonValue>, privateKeyPem: string): string {
  return signEd25519(privateKeyPem, Buffer.from(canonicalJson(record), 'utf8'));
}

/** PURE. The ticket id inside a USRP-SLOT.v1 token (no signature check: it is our own row). */
export function ticketIdOf(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'USRP-SLOT') return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[2] ?? '', 'base64url').toString('utf8')) as { ticketId?: unknown };
    return typeof claims.ticketId === 'string' ? claims.ticketId : null;
  } catch {
    return null;
  }
}

export interface BiometricShadowConfig {
  readonly edgeBaseUrl: string;
  readonly origin: string;
  readonly databaseUrl: string;
  readonly agency: Agency;
  readonly nationalId: string;
  readonly gateOfficer: { readonly loginHandle: string; readonly password: string };
  readonly reader: { readonly loginHandle: string; readonly password: string };
  readonly now: Date;
}

export interface BiometricStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Record one SHADOW evidence row for a persona and prove it stays invisible. */
export async function recordShadowEvidence(config: BiometricShadowConfig): Promise<readonly BiometricStep[]> {
  const steps: BiometricStep[] = [];
  const fail = (step: string, detail: string): readonly BiometricStep[] => [...steps, { step, ok: false, detail }];
  const db = postgres(config.databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const hash = hashNationalId(config.nationalId, process.env['NATIONAL_ID_HMAC_KEY'] ?? DEV_NATIONAL_ID_HMAC_KEY);
    const apps = await db<{ id: string; qr_signed_token: string }[]>`
      SELECT a.id::text, a.qr_signed_token
      FROM ${db(SCHEMA[config.agency])}.applications AS a
      JOIN public_core.applicant_identities AS i ON i.id = a.applicant_id
      WHERE i.national_id_hash = ${hash} AND a.qr_signed_token IS NOT NULL
      ORDER BY a.created_at DESC LIMIT 1`;
    const app = apps[0];
    const ticketId = app === undefined ? null : ticketIdOf(app.qr_signed_token);
    if (app === undefined || ticketId === null) {
      return fail('persona exam QR', 'no application with an exam QR yet; run the live journey (or schedule the persona) first');
    }
    steps.push({ step: 'persona exam QR', ok: true, detail: `application ${app.id}` });

    const gate = new EdgeSession(config.edgeBaseUrl, config.origin);
    if (!(await gate.signIn(config.gateOfficer.loginHandle, config.gateOfficer.password))) {
      return fail('gate sign-in', `edge refused ${config.gateOfficer.loginHandle}`);
    }
    const policy = await gate.get('/edge/v1/gate/biometric-policy');
    const mode = (policy.body as { mode?: unknown } | null)?.mode;
    if (policy.status !== 200 || mode !== 'SHADOW') {
      return fail('biometric policy', `expected mode SHADOW, got HTTP ${String(policy.status)} mode ${String(mode)}`);
    }
    steps.push({ step: 'biometric policy', ok: true, detail: 'SHADOW' });

    const keys = generateDeviceKeyPair();
    const deviceId = `reh-${config.agency.toLowerCase()}-bio-${randomUUID().slice(0, 8)}`;
    const enrol = await gate.post('/edge/v1/field-sync/devices', { deviceId, publicKeyPem: keys.publicKeyPem });
    if (enrol.status !== 201 && enrol.status !== 200) return fail('enrol rehearsal device', `HTTP ${String(enrol.status)}`);
    steps.push({ step: 'enrol rehearsal device', ok: true, detail: deviceId });

    const recordId = randomUUID();
    const record = syntheticEvidenceRecord({
      recordId, applicationId: app.id, ticketId, deviceId, publicKeyPem: keys.publicKeyPem,
      mode: 'SHADOW', capturedAt: config.now.toISOString(),
    });
    const recorded = await gate.post('/edge/v1/gate/biometric-evidence', { record, signature: signEvidenceRecord(record, keys.privateKeyPem) });
    const body = (recorded.body ?? {}) as Record<string, unknown>;
    if (recorded.status !== 201 || body['status'] !== 'RECORDED' || body['mode'] !== 'SHADOW' || 'outcome' in body) {
      return fail('record SHADOW evidence', `HTTP ${String(recorded.status)} ${JSON.stringify(body)}`);
    }
    steps.push({ step: 'record SHADOW evidence', ok: true, detail: recordId });

    const reader = new EdgeSession(config.edgeBaseUrl, config.origin);
    if (!(await reader.signIn(config.reader.loginHandle, config.reader.password))) {
      return fail('reader sign-in', `edge refused ${config.reader.loginHandle}`);
    }
    const read = await reader.get(`/edge/v1/applications/biometric-evidence?applicationId=${app.id}`);
    const listed = JSON.stringify(read.body ?? {}).includes(recordId);
    if (read.status !== 200 || listed) {
      return fail('SHADOW invisible to officers', `HTTP ${String(read.status)}; listed=${String(listed)}`);
    }
    steps.push({ step: 'SHADOW invisible to officers', ok: true, detail: 'officer read does not list it' });

    const rows = await db<{ mode: string }[]>`
      SELECT mode FROM ${db(SCHEMA[config.agency])}.biometric_evidence WHERE record_id = ${recordId}::uuid`;
    if (rows[0]?.mode !== 'SHADOW') return fail('SHADOW row stored', 'no SHADOW row found');
    steps.push({ step: 'SHADOW row stored', ok: true, detail: `${SCHEMA[config.agency]}.biometric_evidence` });
    return steps;
  } finally {
    await db.end({ timeout: 5 });
  }
}

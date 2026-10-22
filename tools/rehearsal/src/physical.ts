// ══════════════════════════════════════════════════════════════════
// rehearsal — complete the physical test of one admitted application (S06)
//
// DEV-ONLY stand-in for the Field Station tablet's score capture until S08. The
// live staff-and-decision journey needs persona A at PHYSICAL_TEST_COMPLETE (the
// state the medical officer acts on). This signs ONE synthetic score record with
// a freshly enrolled rehearsal device and syncs it through the real
// enrollFieldDevice and syncFieldScores operations, as the gate officer.
//
//   pnpm rehearse --complete-physical <applicationId> <qrInvitationCode>
//
// The application must already be admitted at the gate (PHYSICAL_TEST_SCHEDULED)
// and the QR code is the one on the citizen's exam pass.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { generateDeviceKeyPair, signFieldScoreRecord, type SignableFieldPayload } from '@usrp/shared-security';
import { EdgeSession } from './edge.js';

export interface PhysicalConfig {
  readonly edgeBaseUrl: string;
  readonly origin: string;
  readonly agency: string;
  readonly gate: { readonly loginHandle: string; readonly password: string };
  readonly applicationId: string;
  readonly qrInvitationCode: string;
  readonly now: Date;
}

export interface PhysicalStep { readonly step: string; readonly ok: boolean; readonly detail: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PURE. Refuses malformed input before any call. */
export function validatePhysicalInput(applicationId: string, qr: string): string | null {
  if (!UUID_RE.test(applicationId)) return 'the application id must be a UUID';
  if (qr.trim().length < 8 || qr.length > 512) return 'the QR invitation code looks wrong';
  return null;
}

export async function completePhysicalTest(cfg: PhysicalConfig): Promise<readonly PhysicalStep[]> {
  const steps: PhysicalStep[] = [];
  const bad = (step: string, detail: string): readonly PhysicalStep[] => [...steps, { step, ok: false, detail }];
  const problem = validatePhysicalInput(cfg.applicationId, cfg.qrInvitationCode);
  if (problem !== null) return bad('input', problem);

  const gate = new EdgeSession(cfg.edgeBaseUrl, cfg.origin);
  if (!(await gate.signIn(cfg.gate.loginHandle, cfg.gate.password))) return bad('gate sign-in', cfg.gate.loginHandle);
  steps.push({ step: 'gate sign-in', ok: true, detail: cfg.gate.loginHandle });

  const keys = generateDeviceKeyPair();
  const deviceId = `reh-${cfg.agency.toLowerCase()}-score-${randomUUID().slice(0, 8)}`;
  const enrol = await gate.post('/edge/v1/field-sync/devices', { deviceId, publicKeyPem: keys.publicKeyPem });
  if (enrol.status !== 201) return bad('enrol device', `HTTP ${String(enrol.status)}`);
  steps.push({ step: 'enrol device', ok: true, detail: deviceId });

  const payload: SignableFieldPayload = {
    applicationId: cfg.applicationId, qrInvitationCode: cfg.qrInvitationCode,
    metrics: { heightCm: 178, weightKg: 72, run3kmTimeSeconds: 720, chestCm: 96, medicalFitnessStatus: 'FIT' },
    capturedAt: cfg.now.toISOString(), deviceId, capturingOfficerId: randomUUID(), vectorClock: { [deviceId]: 1 },
  };
  const sig = signFieldScoreRecord(keys.privateKeyPem, payload);
  const res = await gate.post('/edge/v1/field-sync/scores', { records: [{ ...payload, ...sig }] });
  const result = ((res.body as { results?: Record<string, unknown>[] } | null)?.results ?? [])[0] ?? {};
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const status = text(result['status']) || `HTTP ${String(res.status)}`;
  if (status !== 'ACCEPTED' && status !== 'SUPERSEDED') return bad('sync the score', `${status} ${text(result['reason'])}`.trim());
  steps.push({ step: 'sync the score', ok: true, detail: status });
  return steps;
}

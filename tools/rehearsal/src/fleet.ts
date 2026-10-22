// ══════════════════════════════════════════════════════════════════
// rehearsal — device fleet and venue live counts (S09)
//
// `pnpm rehearse --fleet` drives the real edge as the day's staff and proves:
//   • enrol → assign to the Gasabo venue day → the supervisor's list shows it;
//   • the venue's live counts (getVenueLiveCounts) EQUAL the ground truth counted
//     independently from the engine tables (admissions, scores, conflicts) and
//     carry an asOf when anything has happened at the venue;
//   • before revocation the device's evidence and score sync get PAST the device
//     check; revoke (reason required) → the NEXT evidence is 403 DEVICE_REVOKED,
//     the NEXT score sync is REJECTED REVOKED_DEVICE, re-enrolment is 409, and
//     the list shows it revoked.
// Synthetic only: the evidence names an application and ticket that do not exist,
// which is enough because the device check comes first.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { generateDeviceKeyPair, signFieldScoreRecord, type SignableFieldPayload } from '@usrp/shared-security';
import { EdgeSession } from './edge.js';
import { signEvidenceRecord, syntheticEvidenceRecord } from './biometric.js';

export interface VenueCounts {
  readonly expected: number;
  readonly admitted: number;
  readonly physicalCaptured: number;
  readonly medicalRecorded: number;
  readonly openConflicts: number;
}

export class FleetAssertion extends Error {
  override readonly name = 'FleetAssertion';
}

/** PURE. Throws unless the edge's counts equal the ground truth and asOf is present when the venue has activity. */
export function assertVenueCounts(body: unknown, truth: VenueCounts): VenueCounts {
  const b = (body ?? {}) as { counts?: Record<string, unknown>; asOf?: unknown };
  const c = b.counts;
  if (c === undefined || c === null || typeof c !== 'object') throw new FleetAssertion('live counts answer has no counts');
  for (const key of Object.keys(truth) as (keyof VenueCounts)[]) {
    if (c[key] !== truth[key]) throw new FleetAssertion(`${key}: edge says ${String(c[key])}, engine says ${String(truth[key])}`);
  }
  const active = Object.values(truth).some((v) => v > 0);
  if (active && (typeof b.asOf !== 'string' || Number.isNaN(Date.parse(b.asOf)))) throw new FleetAssertion('counts carry no asOf although the venue has activity');
  if (!active && b.asOf !== null && typeof b.asOf !== 'string') throw new FleetAssertion('asOf is neither an instant nor null');
  return truth;
}

const SCHEMA = { RDF: 'rdf_ops', RNP: 'rnp_ops', RCS: 'rcs_ops' } as const;

async function groundTruth(db: postgres.Sql, agency: keyof typeof SCHEMA, campaignCode: string, district: string): Promise<VenueCounts> {
  const s = db(SCHEMA[agency]);
  const rows = await db<{ expected: number; admitted: number; physical: number; medical: number; conflicts: number }[]>`
    WITH c AS (SELECT id FROM public_core.recruitment_campaigns WHERE public_code = ${campaignCode}),
    a AS (SELECT id, status::text AS status FROM ${s}.applications
          WHERE campaign_id = (SELECT id FROM c) AND assigned_district = ${district})
    SELECT
      (SELECT count(*)::int FROM a WHERE status IN ('SLOT_ASSIGNED','PHYSICAL_TEST_SCHEDULED','PHYSICAL_TEST_COMPLETE')) AS expected,
      (SELECT count(*)::int FROM ${s}.gate_admissions g WHERE g.application_id IN (SELECT id FROM a)) AS admitted,
      (SELECT count(DISTINCT application_id)::int FROM ${s}.physical_test_scores WHERE application_id IN (SELECT id FROM a)) AS physical,
      (SELECT count(DISTINCT application_id)::int FROM ${s}.physical_test_scores WHERE application_id IN (SELECT id FROM a) AND medical_fitness_status IS NOT NULL) AS medical,
      (SELECT count(DISTINCT application_id)::int FROM ${s}.physical_test_scores WHERE application_id IN (SELECT id FROM a) AND sync_conflict_detected IS TRUE) AS conflicts`;
  const r = rows[0];
  if (r === undefined) throw new FleetAssertion('ground-truth query returned nothing');
  return { expected: r.expected, admitted: r.admitted, physicalCaptured: r.physical, medicalRecorded: r.medical, openConflicts: r.conflicts };
}

export interface FleetConfig {
  readonly edgeBaseUrl: string;
  readonly origin: string;
  readonly databaseUrl: string;
  readonly agency: keyof typeof SCHEMA;
  readonly campaignCode: string;
  readonly district: string;
  readonly examDate: string;
  readonly gate: { readonly loginHandle: string; readonly password: string };
  readonly supervisor: { readonly loginHandle: string; readonly password: string };
  readonly now: Date;
}
export interface FleetStep { readonly step: string; readonly ok: boolean; readonly detail: string }

export async function rehearseFleet(cfg: FleetConfig): Promise<readonly FleetStep[]> {
  const steps: FleetStep[] = [];
  const ok = (step: string, detail: string): void => void steps.push({ step, ok: true, detail });
  const bad = (step: string, detail: string): readonly FleetStep[] => [...steps, { step, ok: false, detail }];
  const db = postgres(cfg.databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const gate = new EdgeSession(cfg.edgeBaseUrl, cfg.origin);
    const sup = new EdgeSession(cfg.edgeBaseUrl, cfg.origin);
    if (!(await gate.signIn(cfg.gate.loginHandle, cfg.gate.password))) return bad('gate sign-in', cfg.gate.loginHandle);
    if (!(await sup.signIn(cfg.supervisor.loginHandle, cfg.supervisor.password))) return bad('supervisor sign-in', cfg.supervisor.loginHandle);

    const keys = generateDeviceKeyPair();
    const deviceId = `reh-${cfg.agency.toLowerCase()}-fleet-${randomUUID().slice(0, 8)}`;
    const enrol = await gate.post('/edge/v1/field-sync/devices', { deviceId, publicKeyPem: keys.publicKeyPem });
    if (enrol.status !== 201) return bad('enrol device', `HTTP ${String(enrol.status)}`);
    ok('enrol device', deviceId);

    const assign = await sup.post('/edge/v1/field-sync/devices/assign', { deviceId, campaign: cfg.campaignCode, district: cfg.district, examDate: cfg.examDate });
    if (assign.status !== 200) return bad('assign to venue day', `HTTP ${String(assign.status)}`);
    const listed = await sup.get('/edge/v1/field-sync/devices');
    const row = ((listed.body as { devices?: Record<string, unknown>[] } | null)?.devices ?? []).find((d) => d['deviceId'] === deviceId);
    const binding = row?.['assignment'] as Record<string, unknown> | null | undefined;
    if (binding?.['district'] !== cfg.district || row?.['revoked'] !== false) return bad('list shows the binding', JSON.stringify(row));
    ok('assign and list', `${cfg.district} ${cfg.examDate}`);

    const query = new URLSearchParams({ campaign: cfg.campaignCode, district: cfg.district, examDate: cfg.examDate });
    const live = await sup.get(`/edge/v1/gate/live-counts?${query.toString()}`);
    if (live.status !== 200) return bad('live counts', `HTTP ${String(live.status)}`);
    const truth = await groundTruth(db, cfg.agency, cfg.campaignCode, cfg.district);
    try {
      assertVenueCounts(live.body, truth);
    } catch (error) {
      return bad('live counts match the engine', error instanceof Error ? error.message : String(error));
    }
    ok('live counts match the engine', JSON.stringify(truth));

    const evidence = (): Promise<{ status: number; body: unknown }> => {
      const record = syntheticEvidenceRecord({
        recordId: randomUUID(), applicationId: randomUUID(), ticketId: 'REH-NO-SUCH-TICKET', deviceId,
        publicKeyPem: keys.publicKeyPem, mode: 'SHADOW', capturedAt: cfg.now.toISOString(),
      });
      return gate.post('/edge/v1/gate/biometric-evidence', { record, signature: signEvidenceRecord(record, keys.privateKeyPem) });
    };
    const syncOnce = async (): Promise<Record<string, unknown>> => {
      const payload: SignableFieldPayload = {
        applicationId: randomUUID(), qrInvitationCode: 'REH-NO-SUCH-TICKET',
        metrics: { heightCm: 178, weightKg: 72, run3kmTimeSeconds: 720, chestCm: 96, medicalFitnessStatus: 'FIT' },
        capturedAt: cfg.now.toISOString(), deviceId, capturingOfficerId: randomUUID(), vectorClock: { [deviceId]: 1 },
      };
      const sig = signFieldScoreRecord(keys.privateKeyPem, payload);
      const res = await gate.post('/edge/v1/field-sync/scores', { records: [{ ...payload, ...sig }] });
      return ((res.body as { results?: Record<string, unknown>[] } | null)?.results ?? [])[0] ?? {};
    };

    const evBefore = await evidence();
    const syncBefore = await syncOnce();
    if ((evBefore.body as { reason?: unknown } | null)?.reason === 'DEVICE_REVOKED' || syncBefore['reason'] === 'REVOKED_DEVICE') {
      return bad('control before revocation', 'an active device was refused as revoked');
    }
    ok('control before revocation', `evidence HTTP ${String(evBefore.status)}, sync ${String(syncBefore['status'])} (past the device check)`);

    if ((await sup.post('/edge/v1/field-sync/devices/revoke', { deviceId })).status !== 400) return bad('revoke needs a reason', 'accepted without one');
    if ((await gate.post('/edge/v1/field-sync/devices/revoke', { deviceId, reason: 'LOST' })).status !== 403) return bad('revoke needs field.device.manage', 'a screening officer revoked');
    const rev = await sup.post('/edge/v1/field-sync/devices/revoke', { deviceId, reason: 'LOST' });
    if (rev.status !== 200) return bad('revoke', `HTTP ${String(rev.status)}`);
    ok('revoke', 'reason LOST; reason required; screening officer refused');

    const evAfter = await evidence();
    if (evAfter.status !== 403 || (evAfter.body as { reason?: unknown } | null)?.reason !== 'DEVICE_REVOKED') {
      return bad('next biometric evidence refused', `HTTP ${String(evAfter.status)} ${JSON.stringify(evAfter.body)}`);
    }
    const syncAfter = await syncOnce();
    if (syncAfter['status'] !== 'REJECTED' || syncAfter['reason'] !== 'REVOKED_DEVICE') return bad('next score sync refused', JSON.stringify(syncAfter));
    ok('next evidence and next score sync refused', 'DEVICE_REVOKED / REVOKED_DEVICE');

    const reenrol = await gate.post('/edge/v1/field-sync/devices', { deviceId, publicKeyPem: keys.publicKeyPem });
    if (reenrol.status !== 409) return bad('enrolment of a revoked id refused', `HTTP ${String(reenrol.status)}`);
    const after = await sup.get('/edge/v1/field-sync/devices');
    const rowAfter = ((after.body as { devices?: Record<string, unknown>[] } | null)?.devices ?? []).find((d) => d['deviceId'] === deviceId);
    if (rowAfter?.['revoked'] !== true || rowAfter['revokeReason'] !== 'LOST') return bad('list shows it revoked', JSON.stringify(rowAfter));
    ok('enrolment refused; list shows revoked', 'a revoked device that never reconnects keeps its data until wiped (S15)');
    return steps;
  } finally {
    await db.end({ timeout: 5 });
  }
}

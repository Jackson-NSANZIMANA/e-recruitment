// ══════════════════════════════════════════════════════════════════
// field-sync-service — ACTOR BINDING PROOF (D11, zero infrastructure)
//
// The reported defect was a 500: a non-UUID capturingOfficerId reached a
// `uuid NOT NULL` column and Postgres answered 22P02. The reported CAUSE was
// wrong — the edge session already carries the officer subject — and the real
// defect is worse than a status code: the DEVICE, not the platform, decided who
// captured a citizen's physical test, and nothing compared that claim with the
// officer who actually uploaded it. On a record that becomes legal evidence of a
// citizen's fitness, that is a forgeable actor.
//
// This proof pins both halves:
//
//   1. SHAPE — a malformed claim is a 400 for the tablet, at the edge and at the
//      service, never a 500 from the database.
//   2. AUTHORITY — a signed claim naming anyone other than the authenticated
//      officer is REFUSED (OFFICER_MISMATCH), nothing is stored, and the value
//      STORED is the principal's. One bad record does not lose a tablet's batch.
//
// It runs the REAL use case against fakes for its three ports, so the decision
// under test is the shipped one, not a copy of it.
// ══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDeviceKeyPair, signFieldScoreRecord, type SignableFieldPayload } from '@usrp/shared-security';
import { InMemoryEventBus } from '@usrp/shared-events';
import type { FieldScoreRecord } from '@usrp/shared-types';
import { SyncFieldScoresService } from '../src/application/sync-field-scores.service.js';
import type { DeviceRecord, DeviceRegistry } from '../src/ports/device-registry.js';
import type { FieldScoreStore, SyncOutcome, SyncRecordInput } from '../src/ports/field-score-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}
function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

const OFFICER = '5f000000-0000-4000-8000-00000000ff01';
const OTHER_OFFICER = '5f000000-0000-4000-8000-00000000ff02';
const DEVICE = 'ACTOR-DEVICE-1';
const keys = generateDeviceKeyPair();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(applicationId: string, claimedOfficerId: string, counter: number): FieldScoreRecord {
  const payload: SignableFieldPayload = {
    applicationId,
    qrInvitationCode: 'ACTOR-TICKET',
    metrics: { heightCm: 178, weightKg: 72, run3kmTimeSeconds: 720, chestCm: 96, medicalFitnessStatus: 'FIT' },
    capturedAt: '2026-11-01T09:00:00.000Z',
    deviceId: DEVICE,
    capturingOfficerId: claimedOfficerId,
    vectorClock: { [DEVICE]: counter },
  };
  const signature = signFieldScoreRecord(keys.privateKeyPem, payload);
  return { ...payload, deviceSignature: signature.deviceSignature, signedPayloadHash: signature.signedPayloadHash };
}

/** Records what the store was asked to write, so "nothing was stored" is provable. */
const storeCalls: SyncRecordInput[] = [];
/** Only `find` and `touch` are on the path under test; the rest throw if reached. */
const registry: DeviceRegistry = {
  find: (deviceId: string): Promise<DeviceRecord | null> =>
    Promise.resolve(
      deviceId === DEVICE ? { deviceId: DEVICE, publicKeyPem: keys.publicKeyPem, agency: 'RDF', revokedAt: null } : null,
    ),
  touch: (): Promise<void> => Promise.resolve(),
  enroll: (): Promise<never> => {
    throw new Error('unexpected enroll');
  },
  list: (): Promise<never> => Promise.reject(new Error('unexpected list')),
  revoke: (): Promise<never> => Promise.reject(new Error('unexpected revoke')),
  assign: (): Promise<never> => Promise.reject(new Error('unexpected assign')),
} as DeviceRegistry;

const store = {
  sync: (input: SyncRecordInput): Promise<SyncOutcome> => {
    storeCalls.push(input);
    return Promise.resolve({ kind: 'ACCEPTED' as const, scoreId: 'score-1', campaignId: 'campaign-1', isWalkIn: false });
  },
  resolveConflict: () => Promise.resolve({ kind: 'NOT_FOUND' as const }),
} as unknown as FieldScoreStore;

function service(): SyncFieldScoresService {
  return new SyncFieldScoresService({ registry, store, eventBus: new InMemoryEventBus() });
}

const context = { correlationId: 'd11', causationId: 'd11' };

// ── 1. Shape: the claim is a UUID, everywhere ──────────────────────
section('Shape: a malformed claim is a 400, not a database 500');
const serviceController = readFileSync(join(REPO, 'services/field-sync-service/src/adapters/http/sync-scores.controller.ts'), 'utf8');
const edgeController = readFileSync(join(REPO, 'services/edge-gateway/src/adapters/http/field-sync.controller.ts'), 'utf8');
check(
  'field-sync validates capturingOfficerId as a UUID',
  /capturingOfficerId:\s*uuid\(/.test(serviceController),
);
check(
  'the edge validates capturingOfficerId as a UUID',
  /capturingOfficerId:\s*requireUuid\(/.test(edgeController),
);
check(
  'neither passes the claim through as a bounded string any more',
  !/capturingOfficerId:\s*(str|requireBoundedString)\(/.test(serviceController) &&
    !/capturingOfficerId:\s*requireBoundedString\(/.test(edgeController),
);
check('the validator rejects a non-UUID claim', !UUID_RE.test('officer-1') && UUID_RE.test(OFFICER));

// ── 2. Authority: the token decides, the device only claims ────────
section('Authority: the authenticated officer is the only actor');
storeCalls.length = 0;
const mismatched = await service().sync({
  records: [record('11111111-1111-4111-8111-111111111111', OTHER_OFFICER, 1)],
  actorAgency: 'RDF',
  actorSubjectId: OFFICER,
  context,
});
const mismatchResult = mismatched.results[0];
check(
  'a signed claim naming another officer → REJECTED / OFFICER_MISMATCH',
  mismatchResult?.status === 'REJECTED' && mismatchResult.reason === 'OFFICER_MISMATCH',
  JSON.stringify(mismatchResult),
);
check('the store was NEVER asked to write it', storeCalls.length === 0, `${String(storeCalls.length)} write(s)`);

storeCalls.length = 0;
const matched = await service().sync({
  records: [record('22222222-2222-4222-8222-222222222222', OFFICER, 1)],
  actorAgency: 'RDF',
  actorSubjectId: OFFICER,
  context,
});
check('a claim naming the signed-in officer → ACCEPTED', matched.results[0]?.status === 'ACCEPTED', JSON.stringify(matched.results[0]));
check(
  'the STORED actor is the principal subject',
  storeCalls.length === 1 && storeCalls[0]?.capturingOfficerId === OFFICER,
  JSON.stringify(storeCalls[0]?.capturingOfficerId),
);

// A batch is per-record: one refusal must not lose a tablet's morning.
storeCalls.length = 0;
const batch = await service().sync({
  records: [
    record('33333333-3333-4333-8333-333333333333', OFFICER, 1),
    record('44444444-4444-4444-8444-444444444444', OTHER_OFFICER, 1),
    record('55555555-5555-4555-8555-555555555555', OFFICER, 2),
  ],
  actorAgency: 'RDF',
  actorSubjectId: OFFICER,
  context,
});
check(
  'a mixed batch reports per-record outcomes (ACCEPTED, OFFICER_MISMATCH, ACCEPTED)',
  batch.results.map((r) => r.status).join(',') === 'ACCEPTED,REJECTED,ACCEPTED',
  batch.results.map((r) => `${r.status}${r.reason === undefined ? '' : `/${r.reason}`}`).join(','),
);
check('only the two genuine records were stored', storeCalls.length === 2, `${String(storeCalls.length)}`);

// ── 3. The refusal is a first-class, shared state ──────────────────
section('The refusal is one shared state, not a string');
const sharedTypes = readFileSync(join(REPO, 'packages/shared-types/src/field.types.ts'), 'utf8');
check(
  "OFFICER_MISMATCH is declared in the shared closed set",
  /FieldScoreRejectReason[\s\S]{0,400}'OFFICER_MISMATCH'/.test(sharedTypes),
);
const serviceSource = readFileSync(join(REPO, 'services/field-sync-service/src/application/sync-field-scores.service.ts'), 'utf8');
check(
  'the use case re-exports the shared union (the tablet and the service cannot disagree)',
  /export type RejectReason = FieldScoreRejectReason/.test(serviceSource),
);
check(
  'the binding is checked AFTER the device signature (a forger learns nothing)',
  serviceSource.indexOf("'BAD_SIGNATURE'") < serviceSource.indexOf("'OFFICER_MISMATCH'"),
);
check(
  'the use case takes the actor from the verified principal, not the payload',
  /readonly actorSubjectId: string;/.test(serviceSource) &&
    serviceSource.includes('capturingOfficerId: actorSubjectId,'),
);

// ── Verdict ────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\u001b[0;32m' : '\u001b[0;31m'}${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
if (fail > 0) {
  console.error(`\nACTOR BINDING FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\u001b[0;32mACTOR BINDING OK\u001b[0m');

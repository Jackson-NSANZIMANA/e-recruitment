import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFleetDevices, projectVenueLiveCounts } from '../src/adapters/http/operational-projections.js';
import { EDGE_OPERATIONS } from '../src/domain/edge-operations.js';

const LEAKS = { publicKeyPem: 'leak-key', agency: 'RNP', revokedBy: 'leak-actor', applicantId: 'leak-1' };
const device = {
  deviceId: 'D1', enrolledBy: 'officer-1', enrolledAt: '2026-10-01T08:00:00.000Z', lastSeenAt: null, lastSeenSource: null,
  lastSyncAt: null, revokedAt: null, revokeReason: null, assignment: null, ...LEAKS,
};

test('a fleet row crosses with exactly the allowlisted fields and never the key', () => {
  const p = projectFleetDevices({ devices: [device] });
  assert.ok(p !== null);
  assert.ok(!JSON.stringify(p).includes('leak-'));
  assert.deepEqual(Object.keys(p['devices'][0] as object).sort(),
    ['assignment', 'deviceId', 'enrolledAt', 'enrolledBy', 'lastSeenAt', 'lastSeenSource', 'lastSyncAt', 'revokeReason', 'revoked', 'revokedAt']);
  assert.equal((p['devices'][0] as { revoked: boolean }).revoked, false);
});

test('revoked is derived from revokedAt, and the reason must be in the closed vocabulary', () => {
  const ok = projectFleetDevices({ devices: [{ ...device, revokedAt: '2026-10-02T08:00:00.000Z', revokeReason: 'STOLEN' }] });
  assert.equal((ok?.['devices'][0] as { revoked: boolean }).revoked, true);
  assert.equal(projectFleetDevices({ devices: [{ ...device, revokedAt: '2026-10-02T08:00:00.000Z', revokeReason: 'BORED' }] }), null);
  assert.equal(projectFleetDevices({ devices: [{ ...device, lastSeenSource: 'CARRIER_PIGEON' }] }), null);
});

test('a malformed fleet answer is a contract fault', () => {
  assert.equal(projectFleetDevices({ devices: 'x' }), null);
  assert.equal(projectFleetDevices({ devices: [{ ...device, enrolledAt: 'yesterday' }] }), null);
});

test('live counts carry counts and asOf only', () => {
  const p = projectVenueLiveCounts({
    agency: 'RDF', venue: { venueName: 'V', district: 'GASABO', examDate: '2030-03-02', ...LEAKS },
    counts: { expected: 3, admitted: 2, physicalCaptured: 1, medicalRecorded: 1, openConflicts: 0, ...LEAKS }, asOf: null, ...LEAKS,
  });
  assert.ok(p !== null);
  assert.ok(!JSON.stringify(p).includes('leak-'));
  assert.deepEqual(Object.keys(p['counts'] as object).sort(), ['admitted', 'expected', 'medicalRecorded', 'openConflicts', 'physicalCaptured']);
  assert.equal(projectVenueLiveCounts({ agency: 'RDF', venue: { venueName: 'V', district: 'G', examDate: '2030-03-02' }, counts: { expected: -1, admitted: 0, physicalCaptured: 0, medicalRecorded: 0, openConflicts: 0 }, asOf: null }), null);
});

test('the four S09 operations are permissioned and writes are never retried', () => {
  for (const id of ['listFieldDevices', 'assignDeviceToVenueDay', 'revokeFieldDevice'] as const) {
    assert.equal(EDGE_OPERATIONS[id].permission, 'field.device.manage');
  }
  assert.equal(EDGE_OPERATIONS.assignDeviceToVenueDay.retryOnG2G, false);
  assert.equal(EDGE_OPERATIONS.revokeFieldDevice.retryOnG2G, false);
  assert.equal(EDGE_OPERATIONS.revokeFieldDevice.csrf, true);
});

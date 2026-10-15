import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { USRPEvent } from '@usrp/shared-types';
import { ReannounceStalledClearancesService } from '../src/application/reannounce-stalled-clearances.service.js';
import { loadSlotRetryConfig } from '../src/config.js';
import type { StalledClearance, StalledClearanceRepository } from '../src/ports/stalled-clearance-repository.js';

const STALLED: StalledClearance = {
  applicationId: '11111111-1111-4111-8111-111111111111',
  applicantId: '22222222-2222-4222-8222-222222222222',
  agency: 'RNP',
  campaignId: '33333333-3333-4333-8333-333333333333',
  category: 'GENERAL_ENLISTMENT',
};

function harness(rows: readonly StalledClearance[]): {
  service: ReannounceStalledClearancesService;
  calls: { untouchedSince: Date; limit: number }[];
  dispatched: USRPEvent[];
} {
  const calls: { untouchedSince: Date; limit: number }[] = [];
  const dispatched: USRPEvent[] = [];
  const repository: StalledClearanceRepository = {
    reannounce(untouchedSince, limit, announce) {
      calls.push({ untouchedSince, limit });
      return Promise.resolve(rows.length === 0 ? [] : announce(rows));
    },
  };
  const service = new ReannounceStalledClearancesService({
    repository,
    events: { dispatch: (events) => { dispatched.push(...events); return Promise.resolve(); } },
    policy: { graceMs: 3_600_000, batchSize: 50 },
  });
  return { service, calls, dispatched };
}

test('claims rows untouched for the grace period, bounded by the batch size', async () => {
  const { service, calls } = harness([]);
  await service.sweep(new Date('2026-10-15T12:00:00Z'));
  assert.deepEqual(calls, [{ untouchedSince: new Date('2026-10-15T11:00:00Z'), limit: 50 }]);
});

test('re-announces each stalled row as APPLICATION_ELIGIBILITY_CLEARED and dispatches exactly what was staged', async () => {
  const { service, dispatched } = harness([STALLED]);
  assert.equal(await service.sweep(), 1);
  assert.equal(dispatched.length, 1);
  const [event] = dispatched;
  assert.ok(event !== undefined && event.eventType === 'APPLICATION_ELIGIBILITY_CLEARED');
  assert.equal(event.applicationId, STALLED.applicationId);
  assert.equal(event.applicantId, STALLED.applicantId);
  assert.equal(event.agency, 'RNP');
  assert.equal(event.campaignId, STALLED.campaignId);
  assert.equal(event.category, 'GENERAL_ENLISTMENT');
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
});

test('nothing stalled → nothing dispatched', async () => {
  const { service, dispatched } = harness([]);
  assert.equal(await service.sweep(), 0);
  assert.equal(dispatched.length, 0);
});

test('config: on by default, every 15 min, 6 h grace; 0 disables; a tiny grace is refused', () => {
  assert.deepEqual(loadSlotRetryConfig({}), { intervalMs: 900_000, graceMs: 21_600_000, batchSize: 200 });
  assert.equal(loadSlotRetryConfig({ SLOT_RETRY_INTERVAL_MS: '0' }).intervalMs, 0);
  assert.throws(() => loadSlotRetryConfig({ SLOT_RETRY_GRACE_MS: '1000' }));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_PERMISSIONS } from '@usrp/shared-auth';
import {
  projectApplicationSearch,
  projectErasureQueue,
  projectVenueRoster,
} from '../src/adapters/http/operational-projections.js';
import { EDGE_OPERATIONS } from '../src/domain/edge-operations.js';

const LEAKS = { applicantId: 'leak-1', nationalId: 'leak-2', nationalIdHash: 'leak-3', fullName: 'leak-4', qrInvitationCode: 'leak-5', phone: 'leak-6' };

test('a roster candidate crosses with exactly the allowlisted fields', () => {
  const projected = projectVenueRoster({
    agency: 'RDF',
    venue: { venueName: 'V', district: 'GASABO', examDate: '2030-03-02', reportingTimeHour: 7, capacityLimit: null, registeredCount: 0, ...LEAKS },
    candidates: [{ processingCode: 'RDF-1', category: 'GENERAL_ENLISTMENT', status: 'SLOT_ASSIGNED', admission: 'ADMITTED', requiredPaperItems: ['NATIONAL_ID'], ...LEAKS }],
    truncated: false,
  });
  assert.ok(projected !== null);
  assert.ok(!JSON.stringify(projected).includes('leak-'));
  assert.deepEqual(Object.keys((projected['candidates'] as object[])[0] as object).sort(), ['admission', 'category', 'processingCode', 'requiredPaperItems', 'status']);
});

test('one off-contract roster row makes the whole roster a contract fault', () => {
  const row = { processingCode: 'RDF-1', category: 'GENERAL_ENLISTMENT', status: 'SLOT_ASSIGNED', admission: 'ADMITTED', requiredPaperItems: [] };
  const body = (candidates: unknown[]) => ({ agency: 'RDF', venue: { venueName: 'V', district: 'GASABO', examDate: '2030-03-02', reportingTimeHour: 7, capacityLimit: 1, registeredCount: 0 }, candidates, truncated: false });
  assert.ok(projectVenueRoster(body([row])) !== null);
  assert.equal(projectVenueRoster(body([row, { ...row, admission: 'UNKNOWN' }])), null);
  assert.equal(projectVenueRoster(body([row, { ...row, processingCode: 7 }])), null);
});

test('the application search page keeps total and cursor, and drops everything unnamed', () => {
  const projected = projectApplicationSearch({
    agency: 'RNP',
    applications: [{ applicationId: 'a', processingCode: 'RNP-1', category: 'CADET_OFFICER', status: 'SUBMITTED', submittedAt: null, ...LEAKS }],
    total: 3,
    nextCursor: 'abc',
  });
  assert.ok(projected !== null);
  assert.equal(projected['total'], 3);
  assert.ok(!JSON.stringify(projected).includes('leak-'));
  assert.equal(projectApplicationSearch({ agency: 'RNP', applications: [], total: -1, nextCursor: null }), null);
  assert.equal(projectApplicationSearch({ agency: 'ZZZ', applications: [], total: 0, nextCursor: null }), null);
  assert.equal(projectApplicationSearch({ agency: 'RNP', applications: [], total: 0, nextCursor: 'has space' }), null);
});

test('the DPO queue never carries the applicant id', () => {
  const projected = projectErasureQueue({ requests: [{ requestId: 'r', applicantId: 'leak-applicant', requestedAt: '2030-01-01T00:00:00.000Z' }] });
  assert.deepEqual(projected, { requests: [{ requestId: 'r', requestedAt: '2030-01-01T00:00:00.000Z' }] });
  assert.equal(projectErasureQueue({ requests: [{ requestId: 'r' }] }), null);
});

test('every S04 operation is an officer read/decision with a known permission; the roster is any-of', () => {
  const ops = ['listAgencyCampaigns', 'getCampaignAdminDetail', 'searchApplications', 'getVenueRoster', 'listErasureRequests', 'decideErasureRequest'] as const;
  for (const id of ops) {
    const op = EDGE_OPERATIONS[id] as { session: string; permission?: string };
    assert.equal(op.session, 'officer');
    assert.ok(op.permission !== undefined && (ALL_PERMISSIONS as readonly string[]).includes(op.permission), id);
  }
  const roster = EDGE_OPERATIONS.getVenueRoster as { permission: string; alsoPermission: readonly string[] };
  assert.deepEqual([roster.permission, ...roster.alsoPermission].sort(), ['admission.gate', 'field.score.sync']);
  assert.equal(EDGE_OPERATIONS.decideErasureRequest.retryOnG2G, false);
});

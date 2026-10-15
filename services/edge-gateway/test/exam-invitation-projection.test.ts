import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectExamInvitation } from '../src/adapters/http/exam-invitation.controller.js';

const TOKEN = 'USRP-SLOT.v1.eyJ0IjoxfQ.c2ln';
const READY = {
  state: 'READY', agency: 'RDF', processingCode: 'RDF-00042', campaignLabel: 'RDF 2026', currentStatus: 'SLOT_ASSIGNED',
  applicantId: 'leak-1', nationalIdHash: 'leak-2',
  invitation: { qrPayload: TOKEN, ticketId: 'TKT-1', venueName: 'ULK Stadium', examDate: '2026-12-01', reportingTimeHour: 8, validUntil: '2026-12-01T23:59:59.000Z', officerId: 'leak-3' },
};

test('READY is rebuilt from the allowlist; leaked fields never cross', () => {
  const v = projectExamInvitation(READY);
  assert.ok(v !== null);
  const text = JSON.stringify(v);
  assert.ok(!text.includes('leak-'), text);
  assert.equal((v['invitation'] as Record<string, unknown>)['qrPayload'], TOKEN);
});

test('a non-READY state carries no invitation even if upstream sent one', () => {
  const v = projectExamInvitation({ ...READY, state: 'ON_HOLD' });
  assert.ok(v !== null && !('invitation' in v));
});

test('a malformed QR payload or unknown state is a contract fault (null), never relayed', () => {
  assert.equal(projectExamInvitation({ ...READY, invitation: { ...READY.invitation, qrPayload: 'javascript:alert(1)' } }), null);
  assert.equal(projectExamInvitation({ ...READY, invitation: { ...READY.invitation, qrPayload: 'USRP-SLOT.v1.a b.c' } }), null);
  assert.equal(projectExamInvitation({ ...READY, state: 'ADMIT_ANYWAY' }), null);
  assert.equal(projectExamInvitation({ ...READY, invitation: undefined }), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideInvitation, readInvitationClaims } from '../src/domain/exam-invitation.js';

const APP = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-01T08:00:00Z');
function token(over: Record<string, unknown> = {}): string {
  const claims = {
    v: 1, keyId: 'k1', ticketId: 'TKT-1', applicationId: APP, applicantId: 'a', agency: 'RDF', campaignId: 'c',
    slotId: 's', venueName: 'ULK Stadium', examDate: '2026-12-01', reportingTimeHour: 8,
    issuedAt: '2026-10-15T00:00:00.000Z', expiresAt: '2026-12-01T23:59:59.000Z', ...over,
  };
  return `USRP-SLOT.v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

test('READY only once a slot is assigned and the token belongs to this application', () => {
  const d = decideInvitation(APP, 'SLOT_ASSIGNED', token(), NOW);
  assert.equal(d.state, 'READY');
  if (d.state === 'READY') {
    assert.equal(d.claims.venueName, 'ULK Stadium');
    assert.equal(d.claims.reportingTimeHour, 8);
  }
  assert.equal(decideInvitation(APP, 'PHYSICAL_TEST_SCHEDULED', token(), NOW).state, 'READY');
});

test('no QR before eligibility: every vetting state is PENDING', () => {
  for (const s of ['SUBMITTED', 'ACADEMIC_VETTING', 'CRIMINAL_CLEARANCE', 'DOCUMENT_REVIEW_GREEN', 'DOCUMENT_REVIEW_AMBER'] as const) {
    assert.equal(decideInvitation(APP, s, null, NOW).state, 'PENDING', s);
  }
});

test('a late hold withholds the QR even though a token exists', () => {
  assert.equal(decideInvitation(APP, 'ADJUDICATION_REVIEW', token(), NOW).state, 'ON_HOLD');
});

test('closed, completed, walk-in and expired are distinct and never READY', () => {
  assert.equal(decideInvitation(APP, 'REJECTED', token(), NOW).state, 'CLOSED');
  assert.equal(decideInvitation(APP, 'WITHDRAWN', token(), NOW).state, 'CLOSED');
  assert.equal(decideInvitation(APP, 'MEDICAL_REVIEW', token(), NOW).state, 'COMPLETED');
  assert.equal(decideInvitation(APP, 'WALK_IN_REGISTERED', null, NOW).state, 'WALK_IN');
  assert.equal(decideInvitation(APP, 'SLOT_ASSIGNED', token(), new Date('2026-12-02T00:00:00Z')).state, 'EXPIRED');
});

test('a missing, malformed or foreign token is UNAVAILABLE, never handed out', () => {
  assert.equal(decideInvitation(APP, 'SLOT_ASSIGNED', null, NOW).state, 'UNAVAILABLE');
  assert.equal(decideInvitation(APP, 'SLOT_ASSIGNED', 'garbage', NOW).state, 'UNAVAILABLE');
  assert.equal(decideInvitation(APP, 'SLOT_ASSIGNED', token({ applicationId: '22222222-2222-4222-8222-222222222222' }), NOW).state, 'UNAVAILABLE');
  assert.equal(readInvitationClaims('USRP-SLOT.v1.notbase64json.sig'), null);
});

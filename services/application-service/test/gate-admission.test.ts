import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMISSIBLE_STATUSES,
  GATE_OUTCOMES,
  decideBeforeIdentity,
  kigaliDate,
  normalizeVenueName,
  parseGateTicket,
  type GateRowFacts,
} from '../src/domain/gate-admission.js';

const APP = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
// 08:00 in Kigali on the exam day (UTC+2).
const EXAM_MORNING = new Date('2026-12-01T06:00:00Z');

function token(over: Record<string, unknown> = {}, sig = 'sig'): string {
  const claims = {
    v: 1, keyId: 'k1', ticketId: 'TKT-1', applicationId: APP, applicantId: 'a', agency: 'RDF', campaignId: CAMPAIGN,
    slotId: 's', venueName: 'ULK Stadium', examDate: '2026-12-01', reportingTimeHour: 8,
    issuedAt: '2026-10-15T00:00:00.000Z', expiresAt: '2026-12-02T00:00:00.000Z', ...over,
  };
  return `USRP-SLOT.v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
}

const TOKEN = token();
const CLAIMS = parseGateTicket(TOKEN)!;
const ROW: GateRowFacts = { status: 'SLOT_ASSIGNED', storedToken: TOKEN, alreadyAdmitted: false };

function decide(row: GateRowFacts | null = ROW, venue = 'ULK Stadium', now = EXAM_MORNING, presented = TOKEN) {
  return decideBeforeIdentity(CLAIMS, presented, row, venue, now);
}

test('a genuine, unspent ticket at the right gate on the exam day goes to the identity check', () => {
  assert.deepEqual(decide(), { kind: 'CHECK_IDENTITY' });
  assert.deepEqual(decide({ ...ROW, status: 'PHYSICAL_TEST_SCHEDULED' }), { kind: 'CHECK_IDENTITY' });
});

test('parse: only a well-formed USRP-SLOT.v1 ticket with our claims is a ticket', () => {
  assert.equal(CLAIMS.applicationId, APP);
  assert.equal(CLAIMS.agency, 'RDF');
  assert.equal(parseGateTicket(''), null);
  assert.equal(parseGateTicket('hello'), null);
  assert.equal(parseGateTicket('USRP-SLOT.v2.x.y'), null);
  assert.equal(parseGateTicket(`USRP-SLOT.v1.${Buffer.from('[1]').toString('base64url')}.s`), null);
  assert.equal(parseGateTicket(token({ applicationId: 'not-a-uuid' })), null);
  assert.equal(parseGateTicket(token({ agency: 'XYZ' })), null);
  assert.equal(parseGateTicket(token({ examDate: '1/12/2026' })), null);
  assert.equal(parseGateTicket(token({ expiresAt: 'soon' })), null);
  assert.equal(parseGateTicket('U'.repeat(5000)), null, 'oversized payloads are refused before parsing');
});

test('unknown application and a token that is not the stored one are refused before anything else', () => {
  assert.deepEqual(decide(null), { kind: 'REFUSE', outcome: 'UNKNOWN_TICKET' });
  assert.deepEqual(decide({ ...ROW, storedToken: null }), { kind: 'REFUSE', outcome: 'TICKET_NOT_ISSUED' });
  // Same claims, different signature: a forged or re-signed QR.
  assert.deepEqual(decide(ROW, 'ULK Stadium', EXAM_MORNING, token({}, 'forged')), { kind: 'REFUSE', outcome: 'TICKET_NOT_ISSUED' });
});

test('a spent QR is a duplicate at ANY gate, on ANY day — checked before venue and date', () => {
  const spent = { ...ROW, alreadyAdmitted: true };
  assert.deepEqual(decide(spent), { kind: 'REFUSE', outcome: 'ALREADY_ADMITTED' });
  assert.deepEqual(decide(spent, 'Another Venue'), { kind: 'REFUSE', outcome: 'ALREADY_ADMITTED' });
  assert.deepEqual(decide(spent, 'ULK Stadium', new Date('2026-12-05T06:00:00Z')), { kind: 'REFUSE', outcome: 'ALREADY_ADMITTED' });
});

test('only SLOT_ASSIGNED and PHYSICAL_TEST_SCHEDULED are admissible', () => {
  assert.deepEqual([...ADMISSIBLE_STATUSES].sort(), ['PHYSICAL_TEST_SCHEDULED', 'SLOT_ASSIGNED']);
  for (const status of ['WITHDRAWN', 'REJECTED', 'ADJUDICATION_REVIEW', 'PHYSICAL_TEST_COMPLETE', 'DOCUMENT_REVIEW_GREEN'] as const) {
    assert.deepEqual(decide({ ...ROW, status }), { kind: 'REFUSE', outcome: 'NOT_ADMISSIBLE' }, status);
  }
});

test('venue: case and spacing do not matter, a different venue does', () => {
  assert.deepEqual(decide(ROW, '  ulk   STADIUM '), { kind: 'CHECK_IDENTITY' });
  assert.deepEqual(decide(ROW, 'Amahoro Stadium'), { kind: 'REFUSE', outcome: 'WRONG_VENUE' });
  assert.equal(normalizeVenueName('Ulk\tStadium'), 'ULK STADIUM');
});

test('the exam day is the Kigali calendar day, not the UTC one', () => {
  // 23:30 UTC on 30 Nov is 01:30 on 1 Dec in Kigali: the exam day.
  assert.equal(kigaliDate(new Date('2026-11-30T23:30:00Z')), '2026-12-01');
  assert.deepEqual(decide(ROW, 'ULK Stadium', new Date('2026-11-30T23:30:00Z')), { kind: 'CHECK_IDENTITY' });
  // 21:00 UTC on 30 Nov is 23:00 in Kigali: still the day before.
  assert.deepEqual(decide(ROW, 'ULK Stadium', new Date('2026-11-30T21:00:00Z')), { kind: 'REFUSE', outcome: 'TOO_EARLY' });
  // 22:30 UTC on 1 Dec is 00:30 on 2 Dec in Kigali: the day is over.
  assert.deepEqual(decide(ROW, 'ULK Stadium', new Date('2026-12-01T22:30:00Z')), { kind: 'REFUSE', outcome: 'EXPIRED' });
});

test('an expiresAt earlier than the end of the Kigali day still expires the ticket', () => {
  const early = token({ expiresAt: '2026-12-01T05:00:00.000Z' });
  const claims = parseGateTicket(early)!;
  assert.deepEqual(
    decideBeforeIdentity(claims, early, { ...ROW, storedToken: early }, 'ULK Stadium', EXAM_MORNING),
    { kind: 'REFUSE', outcome: 'EXPIRED' },
  );
});

test('the outcome vocabulary mirrors the rls/0032 CHECK constraint exactly', () => {
  assert.deepEqual([...GATE_OUTCOMES].sort(), [
    'ADMITTED', 'ALREADY_ADMITTED', 'EXPIRED', 'IDENTITY_MISMATCH', 'MALFORMED_TICKET', 'NOT_ADMISSIBLE',
    'TICKET_NOT_ISSUED', 'TOO_EARLY', 'UNKNOWN_TICKET', 'WRONG_AGENCY', 'WRONG_VENUE',
  ]);
});

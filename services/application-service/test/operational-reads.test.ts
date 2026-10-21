import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeCursor,
  encodeCursor,
  parseApplicationSearch,
  parseCampaignAdminSearch,
  parseRosterQuery,
  ReadInputError,
} from '../src/domain/operational-reads.js';

const q = (s: string): URLSearchParams => new URLSearchParams(s);
const ID = '9d300001-0000-4000-8000-000000000000';
const KEY = '2026-10-15T09:30:00.123456Z';

test('a cursor round-trips exactly, microseconds included', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ sortKey: KEY, id: ID })), { sortKey: KEY, id: ID });
});

test('a cursor this service did not issue is refused', () => {
  for (const bad of ['', '!!!', 'e30', Buffer.from('{"k":"2026-10-15","i":"x"}').toString('base64url'), 'a'.repeat(300)]) {
    assert.throws(() => decodeCursor(bad), (e: unknown) => e instanceof ReadInputError && e.code === 'INVALID_CURSOR', bad);
  }
});

test('application filters: repeatable and comma lists, normalised and de-duplicated', () => {
  const s = parseApplicationSearch(q('status=submitted&status=SLOT_ASSIGNED,submitted&district=gasabo&campaign=rdf-2030&limit=7'));
  assert.deepEqual(s.statuses, ['SUBMITTED', 'SLOT_ASSIGNED']);
  assert.equal(s.district, 'GASABO');
  assert.equal(s.campaignPublicCode, 'RDF-2030');
  assert.equal(s.limit, 7);
  assert.equal(s.cursor, null);
});

test('application filters reject what they cannot trust', () => {
  for (const bad of ['status=NOPE', 'category=NOPE', 'district=ATLANTIS', 'submittedFrom=2026-02-30', 'submittedFrom=2026-03-02&submittedTo=2026-03-01', 'limit=0', 'limit=101', 'limit=x', 'campaign=a', 'campaign=A&campaign=B']) {
    assert.throws(() => parseApplicationSearch(q(bad)), ReadInputError, bad);
  }
});

test('campaign search and roster queries validate every input', () => {
  assert.deepEqual(parseCampaignAdminSearch(q('status=draft,CANCELLED&q=%20rdf%20')).statuses, ['DRAFT', 'CANCELLED']);
  assert.throws(() => parseCampaignAdminSearch(q(`q=${'x'.repeat(65)}`)), ReadInputError);
  assert.deepEqual(parseRosterQuery(q('campaign=rdf-2030&district=gasabo&examDate=2030-03-02')), { campaignPublicCode: 'RDF-2030', district: 'GASABO', examDate: '2030-03-02' });
  assert.throws(() => parseRosterQuery(q('campaign=RDF-2030&district=GASABO')), ReadInputError);
});

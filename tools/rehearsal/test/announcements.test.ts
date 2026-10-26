// The announcement scenarios (docs/product/recruitment-announcements-2025-2026.md):
// every file passes the publication preflight except the RCS junior file kept
// AS PRINTED, whose §8.1 inconsistency the preflight must reject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONA_IDS } from '@usrp/g2g-sandbox';
import { ScenarioInvalid, stageCampaigns, validateScenario, type Scenario } from '../src/scenario.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');
const load = (id: string): Scenario => JSON.parse(readFileSync(join(DIR, `${id}.json`), 'utf8')) as Scenario;
const ANNOUNCED = ['rdf-2026', 'rnp-basic-2025', 'rnp-cadet-2025', 'rcs-junior-2025', 'rcs-officer-2026-1y', 'rcs-officer-2026-4y'];

test('the six announcement campaigns pass the preflight and stage as rehearsal', () => {
  for (const id of ANNOUNCED) {
    const scenario = load(id);
    assert.doesNotThrow(() => { validateScenario(scenario); }, id);
    assert.ok(scenario.announcement?.source.startsWith('docs/product/recruitment-announcements-2025-2026.md'), id);
    for (const staged of stageCampaigns(scenario, new Date('2026-10-26T08:00:00Z'))) {
      assert.match(staged.draft.publicCode, /^REH-/);
      assert.match(staged.draft.campaignLabel, /^\[REHEARSAL\]/);
      for (const s of staged.sessions) assert.match(s.venueName, /^Rehearsal Venue — /);
    }
  }
});

test('RCS junior AS PRINTED is rejected by the preflight (§8.1), and names the reason', () => {
  assert.throws(() => { validateScenario(load('rcs-junior-2025-as-printed')); }, (e: unknown) => e instanceof ScenarioInvalid && /outside the printed examination window/.test(e.message));
  const corrected = load('rcs-junior-2025');
  assert.ok(corrected.announcement?.notes.some((n) => n.section === '§8.1'));
});

test('RDF 2026 is the primary scenario: all 30 districts printed, provinces as in the original, Nyagatare staged today', () => {
  const rdf = load('rdf-2026');
  const a = rdf.announcement;
  assert.ok(a !== undefined);
  assert.equal(a.registration.opens, '2026-05-23');
  assert.equal(a.examination?.hour, '08:00');
  assert.equal(new Set(a.venues.flatMap((v) => v.districts)).size, 30);
  const nyagatare = a.venues.find((v) => v.districts.includes('NYAGATARE'));
  assert.deepEqual(nyagatare?.dates, ['2026-06-06', '2026-06-07']);
  assert.equal(nyagatare?.venue, 'Nyagatare stadium');
  const session = rdf.campaigns[0]?.sessions.find((s) => s.district === 'NYAGATARE');
  assert.equal(session?.examOffsetDays, 0);
  assert.equal(a.documents.some((d) => /bankrupt/i.test(d)), false, 'no bankruptcy requirement in the original');
});

test('the preflight refuses a mislabelled province and exams before registration', () => {
  const rdf = load('rdf-2026');
  const a = rdf.announcement;
  assert.ok(a !== undefined);
  const wrongProvince = { ...rdf, announcement: { ...a, venues: a.venues.map((v) => (v.districts[0] === 'HUYE' ? { ...v, province: 'WESTERN_PROVINCE' } : v)) } };
  assert.throws(() => { validateScenario(wrongProvince); }, /printed under WESTERN_PROVINCE/);
  const early = { ...rdf, announcement: { ...a, registration: { ...a.registration, opens: '2026-06-23', closes: '2026-07-01' } } };
  assert.throws(() => { validateScenario(early); }, /begin before registration opens/);
});

test('every sandbox persona a scenario names exists in the catalogue', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const scenario = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Scenario;
    for (const p of scenario.personas) if (p.sandboxPersona !== undefined) assert.ok(PERSONA_IDS.includes(p.sandboxPersona), `${file}: ${p.sandboxPersona}`);
  }
});

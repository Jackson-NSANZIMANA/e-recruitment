// ADR-049: every announcement scenario publishes policy v2 AS PRINTED. Values restate
// docs/product/recruitment-announcements-2025-2026.md (never the English translations).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ageBandFor, checkEnvelope, convictionVerdict, educationSatisfied } from '@usrp/shared-campaign-policy';
import { policyFromAnnouncement, syntheticPolicy } from '../src/policy.js';
import type { Scenario } from '../src/scenario.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');
const scenarios = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Scenario).filter((s) => s.announcement !== undefined);

function publish(scenario: Scenario, campaignIndex = 0) {
  const campaign = scenario.campaigns[campaignIndex]!;
  const base = syntheticPolicy({ publicCode: 'REH-X', agency: campaign.agency as 'RDF', categories: campaign.categories as never, referenceDate: '2026-01-01', scenarioId: scenario.id, scenarioVersion: scenario.version });
  return policyFromAnnouncement(base, campaign.agency as 'RDF', scenario.announcement!.categories);
}

test('every announcement scenario publishes a v2 policy whose v1 envelope agrees', () => {
  assert.ok(scenarios.length >= 7);
  for (const scenario of scenarios) {
    const policy = publish(scenario);
    for (const category of scenario.campaigns[0]!.categories) {
      const entry = policy.policyDocument[category]!;
      assert.ok(entry.v2, `${scenario.id}/${category} carries v2`);
      assert.equal(checkEnvelope(entry.v2, entry), null, `${scenario.id}/${category}`);
      const printed = scenario.announcement!.categories.find((c) => c.category === category)!;
      assert.equal(Math.max(...entry.v2.ageBands.map((b) => b.maximumAge)), Math.max(...printed.ageCaps.map((c) => c.maxAge)));
    }
  }
});

function category(id: string, name: string) {
  const s = scenarios.find((x) => x.id === id)!;
  return publish(s).policyDocument[name]!.v2!;
}

test('RDF Reserve caps: A-Level 25, A0/IPRC 26, specialists 27', () => {
  assert.equal(ageBandFor(category('rdf-2026', 'RESERVE_FORCE_ALEVEL'), { level: 'A_LEVEL_A2', field: null })?.maximumAge, 25);
  assert.equal(ageBandFor(category('rdf-2026', 'RESERVE_FORCE_UNIVERSITY'), { level: 'BACHELOR_A0', field: null })?.maximumAge, 26);
  assert.equal(ageBandFor(category('rdf-2026', 'RESERVE_FORCE_SPECIALIST'), { level: 'BACHELOR_A0', field: null })?.maximumAge, 27);
});

test('RDF regular: S3 minimum; RCS officer: A0 or A1 IPRC alternatives; four-year: science bar 70', () => {
  assert.equal(educationSatisfied(category('rdf-2026', 'GENERAL_ENLISTMENT'), 'O_LEVEL_S3'), true);
  const officer = category('rcs-officer-2026-1y', 'OFFICER_ONE_YEAR');
  assert.equal(educationSatisfied(officer, 'A1_IPRC'), true);
  assert.equal(educationSatisfied(officer, 'BACHELOR_A0'), true);
  assert.equal(educationSatisfied(officer, 'A_LEVEL_A2'), false);
  assert.equal(category('rcs-officer-2026-4y', 'OFFICER_FOUR_YEAR_UR').minimumSciencePercent, 70);
});

test('conviction rules per agency, and RCS adds not-under-prosecution', () => {
  const clean = { convicted: true, longestSentenceMonths: 6, underProsecution: false };
  assert.equal(convictionVerdict(category('rdf-2026', 'GENERAL_ENLISTMENT'), clean).eligible, false);
  assert.equal(convictionVerdict(category('rnp-basic-2025', 'BASIC_POLICE_COURSE'), clean).eligible, false);
  assert.equal(convictionVerdict(category('rnp-cadet-2025', 'CADET_OFFICER'), clean).eligible, true);
  assert.equal(convictionVerdict(category('rcs-junior-2025', 'GENERAL_ENLISTEE'), { convicted: false, longestSentenceMonths: null, underProsecution: true }).code, 'UNDER_PROSECUTION');
});

test('RCS notarises the academic certificate; RDF does not; clearance values ride in the policy', () => {
  const rcs = category('rcs-junior-2025', 'GENERAL_ENLISTEE');
  assert.equal(rcs.documents.find((d) => d.type === 'ALEVEL_CERTIFICATE')?.notarised, true);
  assert.equal(category('rdf-2026', 'RESERVE_FORCE_ALEVEL').documents.some((d) => d.notarised), false);
  assert.equal(rcs.clearance?.validityDays, 90);
  assert.equal(category('rnp-basic-2025', 'BASIC_POLICE_COURSE').clearance, null);
});

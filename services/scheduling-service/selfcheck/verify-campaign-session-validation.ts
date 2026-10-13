// BUILD-001 proof for scheduling-service's authoritative session input shape.
// This fast check needs no PostgreSQL; database invariants and command writes
// are exercised by the application-service campaign-control-plane selfcheck.

import { normalizeCampaignSession, CampaignSessionInputError } from '../src/domain/campaign-session-validation.js';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function rejects(label: string, run: () => unknown, code: string): void {
  try {
    run();
    check(label, false, `expected ${code}`);
  } catch (error) {
    check(label,
      error instanceof CampaignSessionInputError && error.code === code,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

const finiteInput = {
  publicCode: 'rdf-session-proof-2030',
  district: 'GASABO',
  province: 'KIGALI_CITY',
  venueName: '  Synthetic test venue  ',
  examDate: '2030-02-03',
  reportingTimeHour: 8,
  capacityLimit: 100,
  isActive: true,
};

const finite = normalizeCampaignSession(finiteInput);
check('finite capacity remains unchanged and needs no extra decision',
  finite.publicCode === 'RDF-SESSION-PROOF-2030' &&
  finite.capacityLimit === 100 && finite.capacityDecisionCode === null);
check('venue text is normalized before the scheduling command', finite.venueName === 'Synthetic test venue');

rejects('NULL capacity without explicit decision is denied', () =>
  normalizeCampaignSession({ ...finiteInput, capacityLimit: null }), 'CAPACITY_DECISION_REQUIRED');

const unbounded = normalizeCampaignSession({
  ...finiteInput,
  capacityLimit: null,
  capacityDecisionCode: 'UNBOUNDED_CAPACITY',
});
check('explicit unbounded decision is retained',
  unbounded.capacityLimit === null && unbounded.capacityDecisionCode === 'UNBOUNDED_CAPACITY');

rejects('unbounded decision cannot be attached to a finite capacity', () =>
  normalizeCampaignSession({ ...finiteInput, capacityDecisionCode: 'UNBOUNDED_CAPACITY' }),
'INVALID_CAPACITY_DECISION');
rejects('unsupported decision code is denied', () =>
  normalizeCampaignSession({ ...finiteInput, capacityLimit: null, capacityDecisionCode: 'OTHER' }),
'CAPACITY_DECISION_REQUIRED');
rejects('district/province mismatches are denied', () =>
  normalizeCampaignSession({ ...finiteInput, province: 'EASTERN_PROVINCE' }),
'DISTRICT_PROVINCE_MISMATCH');
rejects('unknown fields are denied rather than silently persisted', () =>
  normalizeCampaignSession({ ...finiteInput, campaignId: 'internal-id' }),
'INVALID_REQUEST');

console.log(`\nBUILD-001 scheduling session validation: ${failures === 0 ? 'PASSED' : `${String(failures)} failed`}.`);
if (failures > 0) process.exitCode = 1;

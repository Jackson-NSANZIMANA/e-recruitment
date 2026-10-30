// ADR-049: the public campaign detail carries only the rules a citizen may read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectEligibility } from '../src/adapters/http/campaigns.controller.js';

const band = { qualifications: ['BACHELOR_A0', 'A1_IPRC'], minimumAge: 18, maximumAge: 26 };

test('age bands, accepted levels and the science bar pass; nothing else does', () => {
  const view = projectEligibility({
    RESERVE_FORCE_UNIVERSITY: { ageBands: [band], educationAlternatives: [{ level: 'BACHELOR_A0' }], minimumSciencePercent: null, documents: [{ type: 'X' }], clearance: { allowedCertificateCodes: ['SECRET'] }, conviction: { rule: 'NEVER_CONVICTED' } },
  });
  assert.deepEqual(Object.keys(view), ['RESERVE_FORCE_UNIVERSITY']);
  assert.deepEqual(Object.keys(view['RESERVE_FORCE_UNIVERSITY'] as object).sort(), ['ageBands', 'educationAlternatives', 'minimumSciencePercent']);
  assert.doesNotMatch(JSON.stringify(view), /SECRET|NEVER_CONVICTED|documents/);
});

test('malformed or empty input yields an empty summary, never a partial leak', () => {
  assert.deepEqual(projectEligibility(null), {});
  assert.deepEqual(projectEligibility({ BAD: { ageBands: 'x', educationAlternatives: [] } }), {});
  assert.deepEqual(projectEligibility({ lowercase: { ageBands: [band], educationAlternatives: [] } }), {});
  assert.deepEqual(projectEligibility({ CAT: { ageBands: [{ ...band, qualifications: ['drop table'] }], educationAlternatives: [] } }), {});
});

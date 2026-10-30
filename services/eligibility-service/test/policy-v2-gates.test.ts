// ADR-049: the pinned policy v2 applied to the academic gate. Synthetic dates only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolicyV2 } from '@usrp/shared-campaign-policy';
import { applyPolicyV2Education, ageWindowFromPolicy, type PinnedPolicy } from '../src/domain/policy-v2-gates.js';
import type { EducationEligibilityResult } from '../src/domain/education-rules.js';

const v2 = normalizePolicyV2({
  schemaVersion: 2,
  ageBands: [
    { qualifications: ['A_LEVEL_A2'], minimumAge: 18, maximumAge: 25 },
    { qualifications: ['BACHELOR_A0', 'A1_IPRC'], minimumAge: 18, maximumAge: 26 },
    { qualifications: ['FIELD:MEDICINE'], minimumAge: 18, maximumAge: 27 },
  ],
  educationAlternatives: [{ level: 'A_LEVEL_A2' }],
  minimumSciencePercent: null,
  conviction: { rule: 'NEVER_CONVICTED', notUnderProsecution: false },
  documents: [{ type: 'NATIONAL_ID', satisfaction: 'REGISTRY_VERIFIED', notarised: false }],
  clearance: null,
});
const policy: PinnedPolicy = { v2, referenceDate: '2026-06-01' };
const base: EducationEligibilityResult = { academicStatus: 'ELIGIBLE', meetsRequirement: true, reason: 'x', requiredMinLevel: 'A_LEVEL_A2', evaluatedLevel: 'BACHELOR_A0', evaluationDate: '2026-06-01T00:00:00Z' };
const dobAged = (years: number) => `${String(2026 - years)}-01-01`;

test('no policy, or a pending result: unchanged', () => {
  assert.equal(applyPolicyV2Education(base, null, { level: 'BACHELOR_A0', field: null, sciencePercent: undefined, dateOfBirth: dobAged(40) }), base);
  const pending = { ...base, academicStatus: 'PENDING' as const };
  assert.equal(applyPolicyV2Education(pending, policy, { level: 'BACHELOR_A0', field: null, sciencePercent: undefined, dateOfBirth: dobAged(40) }), pending);
});

test('A0 aged 26 accepted, aged 27 refused with the cap named', () => {
  const ev = (age: number, field: 'MEDICINE' | null = null) => applyPolicyV2Education(base, policy, { level: 'BACHELOR_A0', field, sciencePercent: undefined, dateOfBirth: dobAged(age) });
  assert.equal(ev(26).academicStatus, 'ELIGIBLE');
  const refused = ev(27);
  assert.equal(refused.academicStatus, 'INELIGIBLE');
  assert.match(refused.reason, /maximum age 26/);
  assert.equal(ev(27, 'MEDICINE').academicStatus, 'ELIGIBLE');
});

test('the age gate window is the widest printed band', () => {
  assert.deepEqual(ageWindowFromPolicy(policy), { minAge: 18, maxAge: 27 });
});

test('a level the campaign does not accept is refused', () => {
  const r = applyPolicyV2Education(base, policy, { level: 'O_LEVEL_S3', field: null, sciencePercent: undefined, dateOfBirth: dobAged(20) });
  assert.equal(r.academicStatus, 'INELIGIBLE');
});

test('no reference-date leakage: the reason never contains the date of birth', () => {
  const r = applyPolicyV2Education(base, policy, { level: 'BACHELOR_A0', field: null, sciencePercent: undefined, dateOfBirth: dobAged(30) });
  assert.doesNotMatch(r.reason, /\d{4}-\d{2}-\d{2}/);
});

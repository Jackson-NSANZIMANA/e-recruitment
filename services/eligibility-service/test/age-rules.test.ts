import test from 'node:test';
import assert from 'node:assert/strict';
import { ageInYears, evaluateAgeEligibility } from '../src/domain/age-rules.js';
import { InvalidDateOfBirthError } from '../src/domain/eligibility.errors.js';

test('ageInYears: computes exact whole years elapsed in UTC', () => {
  const asOf = new Date('2026-10-04T00:00:00Z');

  // Exact 20th birthday
  assert.equal(ageInYears('2006-10-04', asOf), 20);

  // Day before 20th birthday -> 19
  assert.equal(ageInYears('2006-10-05', asOf), 19);

  // Day after 20th birthday -> 20
  assert.equal(ageInYears('2006-10-03', asOf), 20);

  // 18th birthday
  assert.equal(ageInYears('2008-10-04', asOf), 18);
});

test('ageInYears: strictly rejects invalid calendar dates and bad formats (F2 fix)', () => {
  const asOf = new Date('2026-10-04T00:00:00Z');

  // Impossible leap year date
  assert.throws(() => ageInYears('2004-02-30', asOf), InvalidDateOfBirthError);

  // Non-leap year February 29
  assert.throws(() => ageInYears('2005-02-29', asOf), InvalidDateOfBirthError);

  // Invalid month
  assert.throws(() => ageInYears('2004-13-01', asOf), InvalidDateOfBirthError);

  // Bad format
  assert.throws(() => ageInYears('2004/05/10', asOf), InvalidDateOfBirthError);
  assert.throws(() => ageInYears('04-05-2004', asOf), InvalidDateOfBirthError);
});

test('evaluateAgeEligibility: verifies category age criteria and boundaries', () => {
  const asOf = new Date('2026-10-04T00:00:00Z');

  // Exactly 20 years old for GENERAL_ENLISTMENT (min 18, max 25) -> ELIGIBLE
  const r1 = evaluateAgeEligibility('GENERAL_ENLISTMENT', '2006-10-04', asOf);
  assert.equal(r1.eligible, true);
  assert.equal(r1.ageAtEvaluation, 20);
  assert.equal(r1.appliedMaxAge, 25);

  // Underage (17 years old) -> INELIGIBLE
  const r2 = evaluateAgeEligibility('GENERAL_ENLISTMENT', '2009-10-04', asOf);
  assert.equal(r2.eligible, false);
  assert.equal(r2.ageAtEvaluation, 17);

  // Over base age but within specialist band (27 years old) for RESERVE_FORCE_SPECIALIST (max 27) -> ELIGIBLE
  const r3 = evaluateAgeEligibility('RESERVE_FORCE_SPECIALIST', '1999-10-04', asOf);
  assert.equal(r3.eligible, true);
  assert.equal(r3.ageAtEvaluation, 27);
  assert.equal(r3.appliedMaxAge, 27);

  // Exceeds specialist max age (28 years old) -> INELIGIBLE
  const r4 = evaluateAgeEligibility('RESERVE_FORCE_SPECIALIST', '1998-10-04', asOf);
  assert.equal(r4.eligible, false);
  assert.equal(r4.ageAtEvaluation, 28);
});

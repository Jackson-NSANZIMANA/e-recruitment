import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAS, PERSONA_IDS } from '../src/population/personas.js';
import { isSyntheticNid, syntheticNid } from '../src/population/nid.js';
import { SYNTHETIC_PHONE_PATTERN } from '../src/population/model.js';
import { Population } from '../src/population/population.js';
import { population, REFERENCE } from './helpers.js';

test('same seed and reference date ⇒ identical population', () => {
  const a = new Population({ seed: 42, size: 200, referenceDate: REFERENCE });
  const b = new Population({ seed: 42, size: 200, referenceDate: REFERENCE });
  assert.equal(JSON.stringify(a.citizens), JSON.stringify(b.citizens));
  const c = new Population({ seed: 43, size: 200, referenceDate: REFERENCE });
  assert.notEqual(JSON.stringify(a.citizens.slice(-50)), JSON.stringify(c.citizens.slice(-50)));
});

test('every NID is in the synthetic block, every phone in the synthetic range', () => {
  for (const c of population(500).citizens) {
    assert.ok(isSyntheticNid(c.nid), c.key);
    assert.ok(SYNTHETIC_PHONE_PATTERN.test(c.phone), c.key);
    assert.equal(c.nid.slice(1, 5), c.dateOfBirth.slice(0, 4), `${c.key}: NID carries the birth year`);
    assert.equal(c.nid.charAt(5), c.sex === 'MALE' ? '8' : '7', `${c.key}: sex digit`);
  }
});

test('persona ids are unique and stable; legacy fixtures keep their documented NIDs', () => {
  assert.equal(new Set(PERSONA_IDS).size, PERSONA_IDS.length);
  const pop = population();
  // The fixture migration table (old hash-keyed mock → synthetic block).
  const expected: Record<string, string> = {
    'L-01': '1200389990001000', 'L-02': '1200279990002000', 'L-03': '1199989990003000', 'L-04': '1199089990004000',
    'L-05': '1200589990005000', 'L-06': '1200489990006000', 'L-07': '1200179990007000',
  };
  for (const [id, nid] of Object.entries(expected)) assert.equal(pop.persona(id).nid, nid, id);
  assert.equal(pop.persona('L-01').nesa?.studentIndexNumber, '990301PCM0012024');
  assert.equal(pop.persona('L-07').nesa?.studentIndexNumber, '990601HEG0022024');
  assert.equal(syntheticNid(2003, 'MALE', 8), '1200389990008000');
});

test('relative ages hold against the reference date', () => {
  const pop = population();
  assert.equal(pop.persona('P-OVER-AGE-1D').dateOfBirth, '2000-10-24'); // 26th birthday yesterday
  assert.equal(pop.persona('P-AT-CAP-25').dateOfBirth, '2000-10-26'); // turns 26 tomorrow
  assert.equal(pop.persona('P-UNDER-AGE').dateOfBirth, '2008-10-26'); // turns 18 tomorrow
});

test('binding personas carry the quirks they promise', () => {
  const pop = population();
  assert.notEqual(pop.persona('P-NESA-NAME-MISMATCH').nesa?.studentNames, `${pop.persona('P-NESA-NAME-MISMATCH').surname} ${pop.persona('P-NESA-NAME-MISMATCH').forename}`);
  assert.equal(pop.persona('P-NESA-UNPUBLISHED').nesa?.published, false);
  assert.equal(pop.persona('P-NESA-MALPRACTICE').nesa?.malpractice, true);
  assert.equal(pop.persona('P-TVET-A2').nesa?.combinationLevelType, 'TVET');
  assert.equal(pop.persona('P-S3-ONLY').nesa?.combinationLevelType, 'O_LEVEL');
  assert.equal(pop.persona('P-UR-SCI-69').nesa?.weightedPercent, 69);
  assert.ok(pop.persona('P-ID-EXPIRED').dateOfExpiry < '2026-10-25');
  assert.equal(PERSONAS.length, PERSONA_IDS.length);
});

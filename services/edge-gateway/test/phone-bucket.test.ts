import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phoneBucketTarget } from '../src/adapters/http/applicant-auth.controller.js';

test('every spelling of one handset shares ONE rate-limit bucket', () => {
  const spellings = ['0788123456', '0788 123 456', '078-812-3456', '+250788123456', '250 788 123 456', '+250 78 812 3456'];
  assert.equal(new Set(spellings.map(phoneBucketTarget)).size, 1);
  assert.equal(phoneBucketTarget('0788123456'), '788123456');
});

test('different handsets stay in different buckets', () => {
  assert.notEqual(phoneBucketTarget('0788123456'), phoneBucketTarget('0788123457'));
  assert.notEqual(phoneBucketTarget('0788123456'), phoneBucketTarget('0728123456'));
});

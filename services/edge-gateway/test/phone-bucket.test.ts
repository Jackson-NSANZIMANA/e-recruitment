import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phoneBucketTarget } from '../src/adapters/http/applicant-auth.controller.js';

test('every spelling of one handset shares ONE rate-limit bucket', () => {
  const spellings = ['0788000456', '0788 000 456', '078-800-0456', '+250788000456', '250 788 000 456', '+250 78 800 0456'];
  assert.equal(new Set(spellings.map(phoneBucketTarget)).size, 1);
  assert.equal(phoneBucketTarget('0788000456'), '788000456');
});

test('different handsets stay in different buckets', () => {
  assert.notEqual(phoneBucketTarget('0788000456'), phoneBucketTarget('0788000457'));
  assert.notEqual(phoneBucketTarget('0788000456'), phoneBucketTarget('0728000456'));
});

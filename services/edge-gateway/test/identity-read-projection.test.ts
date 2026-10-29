// ADR-049: the identity read projection is an allowlist. Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectMyIdentity } from '../src/adapters/http/identity-read.controller.js';

const ok = { fullName: 'TEST Person', sex: 'FEMALE', dateOfBirth: '2005-03-04', homeDistrict: 'GASABO', homeProvince: 'KIGALI_CITY' };

test('only the allowlisted fields leave, whatever the upstream sends', () => {
  const view = projectMyIdentity({ ...ok, photo: 'AAAA', signature: 'BBBB', fatherName: 'X', motherName: 'Y', nationalId: '1199980000000000', applicantId: 'z' });
  assert.deepEqual(Object.keys(view ?? {}).sort(), ['dateOfBirth', 'fullName', 'homeDistrict', 'homeProvince', 'nationality', 'placeOfBirth', 'sex']);
  assert.equal(view?.placeOfBirth, null);
  assert.equal(view?.nationality, null);
  assert.doesNotMatch(JSON.stringify(view), /AAAA|BBBB|1199980000000000/);
});

test('a malformed upstream body is a contract mismatch, never a partial view', () => {
  for (const patch of [{ fullName: '' }, { sex: 'X' }, { dateOfBirth: '04/03/2005' }, { homeDistrict: 1 }, { homeProvince: undefined }]) {
    assert.equal(projectMyIdentity({ ...ok, ...patch }), null);
  }
  assert.equal(projectMyIdentity(null), null);
  assert.equal(projectMyIdentity('x'), null);
});

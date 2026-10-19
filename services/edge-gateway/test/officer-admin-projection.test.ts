import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectCredentialIssue,
  projectOfficer,
  projectOfficerChange,
  projectOfficerList,
} from '../src/adapters/http/officer-admin.controller.js';

const OFFICER = {
  officerId: '7a010f35-7018-4d7a-9c64-10a91a9e29d9',
  loginHandle: 'rdf.gate.gasabo',
  posts: ['reviewer', 'screening_officer'],
  status: 'pending',
  createdAt: '2026-10-18T08:45:46.265Z',
  activatedAt: null,
  lastLoginAt: null,
  activationExpiresAt: '2026-10-19T08:45:46.265Z',
};
const LEAKS = { credential: 'scrypt$16384$8$1$leak-1', codeHash: 'leak-2', code_hash: 'leak-3', agency: 'RNP', password: 'leak-4' };

test('an officer row crosses with exactly the allowlisted fields — never a credential or code hash', () => {
  const projected = projectOfficer({ ...OFFICER, ...LEAKS });
  assert.deepEqual(projected, OFFICER);
  assert.ok(!JSON.stringify(projected).includes('leak-'));
});

test('the list is all-or-nothing: one off-contract row is a contract fault, never a partial relay', () => {
  const ok = projectOfficerList({ officers: [{ ...OFFICER, ...LEAKS }, { ...OFFICER, status: 'active', activationExpiresAt: null }] });
  assert.ok(ok !== null);
  assert.equal(ok.status, 200);
  assert.ok(!JSON.stringify(ok.body).includes('leak-'));
  assert.equal(projectOfficerList({ officers: [OFFICER, { ...OFFICER, status: 'superadmin' }] }), null);
  assert.equal(projectOfficerList({ officers: [{ ...OFFICER, officerId: 'not-a-uuid' }] }), null);
  assert.equal(projectOfficerList({ officers: [{ ...OFFICER, posts: ['Robert; DROP'] }] }), null);
  assert.equal(projectOfficerList({}), null);
});

test('create/reissue pass the officer and the one-time code only', () => {
  const body = { outcome: 'CREATED', officer: { ...OFFICER, ...LEAKS }, activation: { code: 'BQMX3-BPRPQ-THZGX-A2R59', expiresAt: '2026-10-19T08:45:46.265Z', codeHash: 'leak-5' }, extra: 'leak-6' };
  const r = projectCredentialIssue(201, body, 201);
  assert.ok(r !== null);
  assert.deepEqual(r.body, { outcome: 'CREATED', officer: OFFICER, activation: { code: 'BQMX3-BPRPQ-THZGX-A2R59', expiresAt: '2026-10-19T08:45:46.265Z' } });
  assert.equal(projectCredentialIssue(201, { ...body, activation: { code: 'password123', expiresAt: body.activation.expiresAt } }, 201), null,
    'anything not shaped like an activation code is refused');
  assert.equal(projectCredentialIssue(200, { ...body, outcome: 'CREATED' }, 200), null, 'a reissue must say REISSUED');
  const reissued = projectCredentialIssue(200, { ...body, outcome: 'REISSUED' }, 200);
  assert.equal(reissued?.status, 200);
});

test('every documented refusal crosses with its own status and nothing else; an unknown one is a fault', () => {
  const cases: [number, string][] = [
    [422, 'INVALID_HANDLE'], [422, 'INVALID_POSTS'], [422, 'UNKNOWN_POST'], [422, 'INVALID_REASON'],
    [403, 'AGENCY_ADMIN_NOT_ASSIGNABLE'], [403, 'SELF_MODIFICATION'], [404, 'NOT_FOUND'],
    [409, 'HANDLE_TAKEN'], [409, 'LAST_ACTIVE_ADMIN'], [409, 'NOT_PENDING_ACTIVATION'],
  ];
  for (const [status, error] of cases) {
    assert.deepEqual(projectOfficerChange(status, { error, otherAdmin: 'leak' })?.body, { error });
    assert.deepEqual(projectCredentialIssue(status, { error }, 201)?.body, { error });
  }
  assert.equal(projectOfficerChange(409, { error: 'NOT_FOUND' }), null, 'a refusal on the wrong status is off-contract');
  assert.equal(projectOfficerChange(409, { error: 'SOMETHING_NEW' }), null);
  assert.equal(projectOfficerChange(500, { error: 'INTERNAL_ERROR' }), null);
});

test('a change result is rebuilt; a bad outcome or count is a fault', () => {
  const ok = projectOfficerChange(200, { outcome: 'DISABLED', officer: { ...OFFICER, status: 'disabled', ...LEAKS }, sessionsRevoked: 2, revokedSessionIds: ['leak-7'] });
  assert.ok(ok !== null);
  assert.deepEqual(ok.body, { outcome: 'DISABLED', officer: { ...OFFICER, status: 'disabled' }, sessionsRevoked: 2 });
  assert.equal(projectOfficerChange(200, { outcome: 'DELETED', officer: OFFICER, sessionsRevoked: 0 }), null);
  assert.equal(projectOfficerChange(200, { outcome: 'DISABLED', officer: OFFICER, sessionsRevoked: -1 }), null);
  assert.equal(projectOfficerChange(200, { outcome: 'DISABLED', officer: OFFICER }), null);
});

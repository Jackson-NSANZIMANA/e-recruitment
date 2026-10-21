// Gate admission front door — over a real socket, no infrastructure (ADR-034).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';
import type { AuthVerifier, Principal } from '@usrp/shared-auth';
import { hashNationalId } from '@usrp/shared-security';
import { gateAdmissionRoutes } from '../src/adapters/http/gate-admission.controller.js';
import { projectGateAdmission } from '../src/domain/gate-admission-relay.js';
import { UpstreamUnavailableError } from '../src/domain/identity.errors.js';
import type { GateAdmissionGateway, GateAdmissionRequest } from '../src/ports/gate-admission-gateway.js';

const KEY = 'k'.repeat(48);
const NID = '1199880012345678';
const APP = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = { applicationId: APP, processingCode: 'RDF-90001', category: 'GENERAL_ENLISTMENT' };

const officer = (roles: string[]): Principal => ({ kind: 'officer', subjectId: '33333333-3333-4333-8333-333333333333', agency: 'RDF', roles });
const PRINCIPALS: Record<string, Principal> = {
  'gate-officer': officer(['screening_officer']),
  'medical-officer': officer(['medical_officer']),
  system: { kind: 'system', subjectId: 'svc' },
};
const verify: AuthVerifier = (headers) => {
  const m = /^Bearer (\S+)$/.exec(headers.authorization ?? '');
  return m ? (PRINCIPALS[m[1] ?? ''] ?? null) : null;
};

const calls: { bearer: string; request: GateAdmissionRequest; correlationId: string }[] = [];
let reply: { status: number; body: unknown } | 'down' = { status: 200, body: {} };
const gateway: GateAdmissionGateway = {
  admit: (bearer, request, correlationId) => {
    calls.push({ bearer, request, correlationId });
    if (reply === 'down') return Promise.reject(new UpstreamUnavailableError('down'));
    return Promise.resolve(reply);
  },
};

let server: HttpServer;
before(async () => {
  server = await startHttpServer({
    serviceName: 'identity-gate-test',
    port: 0,
    routes: gateAdmissionRoutes(gateway, KEY, verify),
    readiness: () => Promise.resolve(true),
  });
});
after(async () => {
  await server.stop();
});

async function post(body: unknown, bearer: string | null = 'gate-officer') {
  const res = await fetch(`${server.url}/v1/gate/admissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

const VALID = { qrToken: 'USRP-SLOT.v1.abc.def', nationalId: NID, gateVenueName: 'ULK Stadium' };
const ADMITTED = {
  outcome: 'ADMITTED', candidate: CANDIDATE, venueName: 'ULK Stadium', examDate: '2026-12-01',
  reportingTimeHour: 8, admittedAt: '2026-12-01T06:01:00.000Z', statusAdvanced: true,
  identityMethod: 'NATIONAL_ID_CARD+CARD_PORTRAIT',
};

test('hashes the card number, forwards the HASH under the officer\'s own token, never the number', async () => {
  calls.length = 0;
  reply = { status: 200, body: { ...ADMITTED, internalNote: 'must not leak' } };
  const r = await post(VALID);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, ADMITTED, 'rebuilt from the allowlist; extra upstream fields dropped');
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.bearer, 'gate-officer', 'the officer credential is forwarded verbatim');
  assert.deepEqual(call.request, { qrToken: VALID.qrToken, gateVenueName: 'ULK Stadium', nationalIdHash: hashNationalId(NID, KEY) });
  assert.ok(!JSON.stringify(call.request).includes(NID), 'the raw national ID never leaves identity-service');
  assert.ok(!r.text.includes(NID), 'nor appears in the response');
});

test('only the gate post may call it; no system token, no anonymous caller', async () => {
  calls.length = 0;
  assert.equal((await post(VALID, 'medical-officer')).status, 403);
  assert.equal((await post(VALID, 'system')).status, 403);
  assert.equal((await post(VALID, null)).status, 401);
  assert.equal(calls.length, 0, 'nothing reached application-service');
});

test('a malformed card number is refused before any upstream call', async () => {
  calls.length = 0;
  const r = await post({ ...VALID, nationalId: '12345' });
  assert.equal(r.status, 400);
  assert.equal(r.json['error'], 'INVALID_NATIONAL_ID');
  assert.equal((await post({ ...VALID, qrToken: '' })).status, 400);
  assert.equal((await post({ ...VALID, gateVenueName: '' })).status, 400);
  assert.equal(calls.length, 0);
});

test('refusals relay with their allowlisted detail', async () => {
  reply = { status: 409, body: { error: 'ALREADY_ADMITTED', candidate: CANDIDATE, admittedAt: '2026-12-01T06:01:00.000Z', venueName: 'ULK Stadium', admittedBySelf: false, secret: 1 } };
  const dup = await post(VALID);
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.json, { error: 'ALREADY_ADMITTED', candidate: CANDIDATE, admittedAt: '2026-12-01T06:01:00.000Z', venueName: 'ULK Stadium', admittedBySelf: false });

  reply = { status: 422, body: { error: 'INVALID_TICKET', reason: 'TICKET_NOT_ISSUED' } };
  assert.deepEqual((await post(VALID)).json, { error: 'INVALID_TICKET', reason: 'TICKET_NOT_ISSUED' });
});

test('an off-contract or failing upstream is never relayed raw', async () => {
  reply = { status: 200, body: { outcome: 'ADMITTED' } };
  assert.equal((await post(VALID)).status, 502);
  reply = { status: 409, body: { error: 'SOMETHING_NEW' } };
  assert.equal((await post(VALID)).status, 502);
  reply = { status: 500, body: { error: 'APPLICATION_PERSISTENCE_ERROR' } };
  assert.equal((await post(VALID)).status, 503);
  reply = 'down';
  assert.equal((await post(VALID)).status, 503);
  reply = { status: 403, body: { error: 'PERMISSION_DENIED' } };
  assert.equal((await post(VALID)).status, 403);
});

test('projection: every documented conflict shape passes, nothing else does', () => {
  assert.equal(projectGateAdmission(409, { error: 'WRONG_VENUE', ticketVenueName: 'Amahoro' })?.status, 409);
  assert.equal(projectGateAdmission(409, { error: 'TOO_EARLY', examDate: '2026-12-01' })?.status, 409);
  assert.equal(projectGateAdmission(409, { error: 'EXPIRED', examDate: '2026-12-01' })?.status, 409);
  assert.equal(projectGateAdmission(409, { error: 'IDENTITY_MISMATCH', candidate: CANDIDATE })?.status, 409);
  assert.deepEqual(projectGateAdmission(409, { error: 'MANUAL_IDENTITY_REQUIRED', candidate: CANDIDATE, evidenceIds: ['x'] })?.body,
    { error: 'MANUAL_IDENTITY_REQUIRED', candidate: CANDIDATE }, 'ADR-037: relayed with the candidate only');
  assert.equal(projectGateAdmission(200, { ...ADMITTED, identityMethod: 'FACE_ONLY' }), null, 'ADR-037: unknown identity method');
  assert.equal(projectGateAdmission(409, { error: 'NOT_ADMISSIBLE', candidate: CANDIDATE, currentStatus: 'WITHDRAWN' })?.status, 409);
  assert.equal(projectGateAdmission(409, { error: 'IDENTITY_MISMATCH' }), null, 'missing candidate');
  assert.equal(projectGateAdmission(422, { error: 'INVALID_TICKET', reason: 'ANYTHING' }), null);
  assert.equal(projectGateAdmission(201, ADMITTED), null);
});

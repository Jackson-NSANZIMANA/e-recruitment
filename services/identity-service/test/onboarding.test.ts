// Onboarding (NID + DOB → phone → OTP) — pure unit proof, no infrastructure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryEventBus } from '@usrp/shared-events';
import type { SmsChannel, OutboundSms } from '@usrp/shared-sms';
import { ApplicantAuthService } from '../src/application/applicant-auth.service.js';
import type { ApplicantAuthRepository, OtpChallengeRecord } from '../src/ports/applicant-auth.repository.js';
import type { NidaGateway } from '../src/ports/nida.gateway.js';
import { normalizeRwandanMsisdn } from '../src/domain/rwanda-phone.js';
import { issueOnboardingToken, verifyOnboardingToken } from '../src/domain/onboarding-token.js';

const KEY = 'unit_test_national_id_hmac_key_32_chars!!';
const NID = '1200380123456789';
const DOB = '2002-05-14';
const APPLICANT = '11111111-1111-4111-8111-111111111111';

function citizen(over: Partial<{ dateOfBirth: string; citizenshipStatus: string }> = {}) {
  return {
    status: 'FOUND' as const,
    nidaRequestId: 'req-1',
    nidaLookupHash: 'h',
    matchConfidence: null,
    citizen: {
      fullName: 'Test Citizen',
      dateOfBirth: over.dateOfBirth ?? DOB,
      gender: 'MALE' as const,
      homeDistrict: 'Gasabo',
      homeProvince: 'Kigali City',
      citizenshipStatus: over.citizenshipStatus ?? 'RWANDAN_CITIZEN',
    },
  };
}

function harness(
  nidaResult: Awaited<ReturnType<NidaGateway['lookupCitizen']>>,
  verifiedApplicant: string | null = APPLICANT,
) {
  const sent: OutboundSms[] = [];
  const challenges: (OtpChallengeRecord & { consumed: boolean })[] = [];
  const stamped: { applicantId: string; phoneHash: string; phone: string }[] = [];
  const sessions: string[] = [];
  let clock = new Date('2026-10-13T10:00:00Z');
  let failures = 0;
  let lock: Date | null = null;
  let nidaCalls = 0;

  const repository: ApplicantAuthRepository = {
    findOnboardingLock: (_h, now) => Promise.resolve(lock !== null && lock > now ? lock : null),
    recordOnboardingFailure: (i) => {
      failures += 1;
      if (failures >= i.maxFailures) lock = new Date(i.now.getTime() + i.lockSeconds * 1000);
      return Promise.resolve();
    },
    clearOnboardingFailures: () => { failures = 0; lock = null; return Promise.resolve(); },
    findVerifiedApplicantByNidHash: () => Promise.resolve(verifiedApplicant),
    createChallenge: (i) => {
      challenges.push({ id: `c${String(challenges.length)}`, applicantId: i.applicantId, otpHash: i.otpHash, expiresAt: i.expiresAt, attempts: 0, consumed: false });
      return Promise.resolve();
    },
    findLiveChallenge: () => {
      const live = challenges.filter((c) => !c.consumed && c.expiresAt > clock).at(-1);
      return Promise.resolve(live ?? null);
    },
    recordFailedAttempt: (id) => {
      const c = challenges.find((x) => x.id === id);
      if (c) (c as { attempts: number }).attempts += 1;
      return Promise.resolve(c?.attempts ?? 0);
    },
    consumeChallenge: (id) => {
      const c = challenges.find((x) => x.id === id);
      if (!c || c.consumed) return Promise.resolve(false);
      c.consumed = true;
      return Promise.resolve(true);
    },
    createSession: (i) => { sessions.push(i.sessionToken); return Promise.resolve(); },
    findLiveSession: () => Promise.resolve(null),
    terminateSession: () => Promise.resolve(),
    stampPhoneVerified: (applicantId, phoneHash, phone) => { stamped.push({ applicantId, phoneHash, phone }); return Promise.resolve(); },
  };
  const sms: SmsChannel = { send: (m) => { sent.push(m); return Promise.resolve({ status: 'SENT' } as never); } };
  const service = new ApplicantAuthService({
    repository,
    nida: { lookupCitizen: () => { nidaCalls += 1; return Promise.resolve(nidaResult); } },
    identity: { verify: () => Promise.resolve({ kind: 'CREATED', applicantId: APPLICANT, nationalIdHash: 'x' } as never) },
    sms,
    eventBus: new InMemoryEventBus(),
    nationalIdHmacKey: KEY,
    config: { otpTtlSeconds: 300, otpMaxAttempts: 5, sessionTtlSeconds: 1800, onboardingMaxFailures: 5, onboardingFailureWindowSeconds: 3600, onboardingLockSeconds: 3600 },
    now: () => clock,
  });
  return { service, sent, stamped, sessions, nidaCalls: (): number => nidaCalls, lockedUntil: (): Date | null => lock, tick: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

const codeOf = (sms: OutboundSms | undefined): string => /code: (\d{6})/.exec(sms?.body ?? '')?.[1] ?? '';

test('phone normalisation accepts MTN/Airtel spellings and rejects the rest', () => {
  for (const ok of ['0781234567', '250781234567', '+250 781 234 567', '079-123-4567', '0721234567', '0731234567']) {
    assert.match(normalizeRwandanMsisdn(ok) ?? '', /^\+250(72|73|78|79)\d{7}$/, ok);
  }
  for (const bad of ['0711234567', '078123456', '+254712345678', 'abc', '', '07812345678']) {
    assert.equal(normalizeRwandanMsisdn(bad), null, bad);
  }
});

test('onboarding token: round-trips, expires, and resists tampering', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  const { token } = issueOnboardingToken(KEY, APPLICANT, now, 60);
  assert.equal(verifyOnboardingToken(KEY, token, now), APPLICANT);
  assert.equal(verifyOnboardingToken(KEY, token, new Date(now.getTime() + 61_000)), null);
  assert.equal(verifyOnboardingToken('another_key_another_key_another_key_!!', token, now), null);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, sub: 'someone-else', exp: 9_999_999_999 })).toString('base64url');
  assert.equal(verifyOnboardingToken(KEY, `${forged}.${mac ?? ''}`, now), null);
  assert.equal(verifyOnboardingToken(KEY, `${body ?? ''}`, now), null);
});

test('DOB mismatch, unknown NID and non-citizen are one indistinguishable outcome', async () => {
  const mismatch = await harness(citizen()).service.beginOnboarding({ rawNationalId: NID, dateOfBirth: '1999-01-01', channel: 'WEB' });
  const unknown = await harness({ status: 'NOT_FOUND', nidaRequestId: 'r' }).service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  const foreign = await harness(citizen({ citizenshipStatus: 'FOREIGN_RESIDENT' })).service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  assert.deepEqual(mismatch, { kind: 'NOT_CONFIRMED' });
  assert.deepEqual(unknown, mismatch);
  assert.deepEqual(foreign, mismatch);
});

test('full flow: NID+DOB → phone → OTP sent to the STATED number → session, contact stamped', async () => {
  const h = harness(citizen());
  const begun = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  assert.equal(begun.kind, 'READY');
  if (begun.kind !== 'READY') return;

  const req = await h.service.requestOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0788 000 111', channel: 'WEB' });
  assert.deepEqual(req, { kind: 'CHALLENGED' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.destination, '+250788000111');

  const out = await h.service.verifyOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '+250788000111', otp: codeOf(h.sent[0]), channel: 'WEB' });
  assert.equal(out.kind, 'AUTHENTICATED');
  assert.equal(h.stamped[0]?.phone, '+250788000111');
  assert.equal(h.sessions.length, 1);
});

test('a code sent to one number cannot verify another', async () => {
  const h = harness(citizen());
  const begun = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  if (begun.kind !== 'READY') throw new Error('setup');
  await h.service.requestOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0788000111', channel: 'WEB' });
  const stolen = await h.service.verifyOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0799999999', otp: codeOf(h.sent[0]), channel: 'WEB' });
  assert.deepEqual(stolen, { kind: 'INVALID_OTP' });
  assert.equal(h.stamped.length, 0);
});

test('the code is single use, and expiry of the onboarding token is refused', async () => {
  const h = harness(citizen());
  const begun = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  if (begun.kind !== 'READY') throw new Error('setup');
  await h.service.requestOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0788000111', channel: 'WEB' });
  const otp = codeOf(h.sent[0]);
  const first = await h.service.verifyOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0788000111', otp, channel: 'WEB' });
  const replay = await h.service.verifyOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0788000111', otp, channel: 'WEB' });
  assert.equal(first.kind, 'AUTHENTICATED');
  assert.deepEqual(replay, { kind: 'INVALID_OTP' });

  h.tick(16 * 60_000);
  const late = await h.service.requestOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0788000111', channel: 'WEB' });
  assert.deepEqual(late, { kind: 'ONBOARDING_INVALID' });
});

test('an undeliverable phone sends nothing', async () => {
  const h = harness(citizen());
  const begun = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  if (begun.kind !== 'READY') throw new Error('setup');
  const out = await h.service.requestOtp({ onboardingToken: begun.onboardingToken, rawPhoneNumber: '0711111111', channel: 'WEB' });
  assert.deepEqual(out, { kind: 'PHONE_INVALID' });
  assert.equal(h.sent.length, 0);
});

test('five DOB mismatches lock the NID; the lock holds even for the correct DOB and skips NIDA', async () => {
  const h = harness(citizen());
  for (let i = 0; i < 5; i += 1) {
    const r = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: `1990-01-0${String(i + 1)}`, channel: 'WEB' });
    assert.deepEqual(r, { kind: 'NOT_CONFIRMED' });
  }
  assert.notEqual(h.lockedUntil(), null);
  const callsBefore = h.nidaCalls();
  const correct = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  assert.deepEqual(correct, { kind: 'NOT_CONFIRMED' });
  assert.equal(h.nidaCalls(), callsBefore, 'a locked NID must not reach NIDA');

  h.tick(61 * 60_000);
  const after = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  assert.equal(after.kind, 'READY');
});

test('an unknown NID is never counted toward the lockout table', async () => {
  const h = harness({ status: 'NOT_FOUND', nidaRequestId: 'r' });
  for (let i = 0; i < 8; i += 1) {
    await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  }
  assert.equal(h.lockedUntil(), null);
});

test('an existing identity that is not VERIFIED is never issued a token', async () => {
  const h = harness(citizen(), null); // the row exists (ALREADY_EXISTS) but is PENDING/FAILED/EXPIRED
  const r = await h.service.beginOnboarding({ rawNationalId: NID, dateOfBirth: DOB, channel: 'WEB' });
  assert.deepEqual(r, { kind: 'NOT_CONFIRMED' });
});

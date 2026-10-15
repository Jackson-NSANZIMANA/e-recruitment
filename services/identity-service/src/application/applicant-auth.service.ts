// ══════════════════════════════════════════════════════════════════
// identity-service — Applicant authentication (use case, ADR-018)
//
// The citizen door, in THREE steps (NID → phone → OTP):
//
//   1. beginOnboarding — National ID + date of birth are checked against NIDA.
//      Only a Rwandan citizen whose DOB matches proceeds; an identity row is
//      created or reused and a signed, short-lived onboarding token returned.
//   2. requestOtp — the citizen states a phone number (NIDA does not hold one;
//      SIM registration lives with the operators) and the OTP is sent THERE.
//   3. verifyOtp — the code, bound to that exact number, is consumed once and
//      an opaque, revocable DB session (owner D5) is issued.
//
// The OTP proves control of a phone, NOT that the phone belongs to the NID's
// owner. That binding comes from the DOB factor at step 1 and, at the venue,
// from the face match against the NIDA record. PII discipline throughout:
//   • the raw NID is request-only (hashed before any I/O, exactly like
//     identity verification);
//   • the raw phone is citizen-supplied, lives in memory between the request
//     and the SMS send — never logged, never on the bus. The OTP digest is
//     bound to the phone's HMAC, so a code sent to one number cannot verify
//     another; the stored contact is written only after verification;
//   • the DOB is request-only and compared to NIDA's, never stored or echoed;
//   • the plaintext code exists only inside the SMS body — the store holds
//     a scrypt digest;
//   • Step 1 answers one uniform NOT_CONFIRMED for an unknown NID, a
//     non-citizen, and a DOB mismatch — a probe learns nothing it did not
//     already have to know. Whether a NID is registered with USRP is not
//     observable; only "these details did not match NIDA" is;
//   • SINGLE USE IS ENFORCED, NOT ASSUMED: a session is issued only to the
//     verifier whose compare-and-set consumed the challenge. Two concurrent
//     requests carrying the same valid code yield exactly one session.
//
// A citizen who cannot receive an SMS has the walk-in lane (ADR-012), where a
// field officer establishes identity in person. Documented in ADR-018.
// ══════════════════════════════════════════════════════════════════

import { randomBytes, randomInt } from 'node:crypto';
import {
  hashNationalId,
  hashPassword,
  hashPhoneNumber,
  sha256Hex,
  timingSafeEqualHex,
  verifyPassword,
} from '@usrp/shared-security';
import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { ApplicationChannel, AuditEvent } from '@usrp/shared-types';
import type { NidaGateway } from '../ports/nida.gateway.js';
import type { ApplicantAuthRepository } from '../ports/applicant-auth.repository.js';
import type { SmsChannel } from '@usrp/shared-sms';
import type { VerifyIdentityService } from './verify-identity.service.js';
import { RWANDAN_CITIZEN } from '../domain/nida.types.js';
import { normalizeRwandanMsisdn } from '../domain/rwanda-phone.js';
import { issueOnboardingToken, verifyOnboardingToken } from '../domain/onboarding-token.js';

export interface BeginOnboardingCommand {
  readonly rawNationalId: string;
  /** ISO calendar date, YYYY-MM-DD — validated by the caller's shape check. */
  readonly dateOfBirth: string;
  readonly channel: ApplicationChannel;
  readonly context?: EventContext;
}

export type BeginOnboardingOutcome =
  | { readonly kind: 'READY'; readonly onboardingToken: string; readonly expiresAt: string }
  /** Uniform: unknown NID, non-citizen, and DOB mismatch are indistinguishable. */
  | { readonly kind: 'NOT_CONFIRMED' };

export interface RequestOtpCommand {
  readonly onboardingToken: string;
  readonly rawPhoneNumber: string;
  readonly channel: ApplicationChannel;
  readonly context?: EventContext;
}

export type RequestOtpOutcome =
  | { readonly kind: 'CHALLENGED' }
  | { readonly kind: 'ONBOARDING_INVALID' }
  | { readonly kind: 'PHONE_INVALID' };

export interface VerifyOtpCommand {
  readonly onboardingToken: string;
  readonly rawPhoneNumber: string;
  readonly otp: string;
  readonly channel: ApplicationChannel;
  readonly context?: EventContext;
}

export type VerifyOtpOutcome =
  | { readonly kind: 'AUTHENTICATED'; readonly sessionToken: string; readonly expiresAt: string }
  | { readonly kind: 'INVALID_OTP' };

export interface ApplicantAuthConfig {
  /** OTP lifetime in seconds (default policy: 5 minutes). */
  readonly otpTtlSeconds: number;
  /** Failed guesses before the challenge locks (default policy: 5). */
  readonly otpMaxAttempts: number;
  /** Session lifetime in seconds (default policy: 30 minutes). */
  readonly sessionTtlSeconds: number;
  /** DOB mismatches inside the window before the NID locks (ADR-029). */
  readonly onboardingMaxFailures: number;
  readonly onboardingFailureWindowSeconds: number;
  readonly onboardingLockSeconds: number;
}

export interface ApplicantAuthDeps {
  readonly repository: ApplicantAuthRepository;
  readonly nida: NidaGateway;
  /** Creates or reuses the identity row once NID + DOB have matched NIDA. */
  readonly identity: Pick<VerifyIdentityService, 'verify'>;
  readonly sms: SmsChannel;
  readonly eventBus: EventBus;
  readonly nationalIdHmacKey: string;
  readonly config: ApplicantAuthConfig;
  readonly now?: () => Date;
}

export class ApplicantAuthService {
  readonly #now: () => Date;

  constructor(private readonly deps: ApplicantAuthDeps) {
    this.#now = deps.now ?? ((): Date => new Date());
  }

  /** Step 1 — NID + DOB against NIDA; identity created/reused; token issued. */
  async beginOnboarding(command: BeginOnboardingCommand): Promise<BeginOnboardingOutcome> {
    // Malformed NID throws (→ 400) — a shape error, not a signal.
    const nationalIdHash = hashNationalId(command.rawNationalId, this.deps.nationalIdHmacKey);
    const context = command.context ?? newCorrelationContext();
    const now = this.#now();

    // A locked NID answers the uniform outcome WITHOUT consulting NIDA — and
    // does so even for the correct DOB, so the lock itself is not a signal.
    if ((await this.deps.repository.findOnboardingLock(nationalIdHash, now)) !== null) {
      return { kind: 'NOT_CONFIRMED' };
    }

    const lookup = await this.deps.nida.lookupCitizen(command.rawNationalId);
    if (lookup.status !== 'FOUND') return { kind: 'NOT_CONFIRMED' };
    if (lookup.citizen.citizenshipStatus !== RWANDAN_CITIZEN) return { kind: 'NOT_CONFIRMED' };
    if (!sameDate(lookup.citizen.dateOfBirth, command.dateOfBirth)) {
      // Only a REAL citizen's mismatch is counted, so unknown NIDs cannot
      // be used to grow the lockout table.
      await this.deps.repository.recordOnboardingFailure({
        nationalIdHash,
        now,
        windowSeconds: this.deps.config.onboardingFailureWindowSeconds,
        maxFailures: this.deps.config.onboardingMaxFailures,
        lockSeconds: this.deps.config.onboardingLockSeconds,
      });
      return { kind: 'NOT_CONFIRMED' };
    }
    await this.deps.repository.clearOnboardingFailures(nationalIdHash);

    const identity = await this.deps.identity.verify({
      rawNationalId: command.rawNationalId,
      registrationChannel: command.channel,
      context,
    });
    if (identity.kind !== 'CREATED' && identity.kind !== 'ALREADY_EXISTS') {
      return { kind: 'NOT_CONFIRMED' };
    }
    // ALREADY_EXISTS says nothing about the row's status. Only a VERIFIED
    // identity may be issued a token — the same bar the pre-ADR-029 login held
    // (a PENDING / FAILED / EXPIRED identity gets the uniform answer).
    const verifiedId = await this.deps.repository.findVerifiedApplicantByNidHash(nationalIdHash);
    if (verifiedId !== identity.applicantId) return { kind: 'NOT_CONFIRMED' };

    const issued = issueOnboardingToken(
      this.deps.nationalIdHmacKey,
      identity.applicantId,
      this.#now(),
    );
    await this.#audit(identity.applicantId, 'APPLICANT_ONBOARDING_CONFIRMED', command.channel, context);
    return {
      kind: 'READY',
      onboardingToken: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  /** Step 2 — send the OTP to the phone the citizen stated. */
  async requestOtp(command: RequestOtpCommand): Promise<RequestOtpOutcome> {
    const applicantId = verifyOnboardingToken(
      this.deps.nationalIdHmacKey,
      command.onboardingToken,
      this.#now(),
    );
    if (applicantId === null) return { kind: 'ONBOARDING_INVALID' };

    const phone = normalizeRwandanMsisdn(command.rawPhoneNumber);
    if (phone === null) return { kind: 'PHONE_INVALID' };
    const context = command.context ?? newCorrelationContext();

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(this.#now().getTime() + this.deps.config.otpTtlSeconds * 1000);
    await this.deps.repository.createChallenge({
      applicantId,
      otpHash: hashPassword(this.#otpSecret(otp, phone)),
      expiresAt,
    });

    // The ONLY component that sees the raw destination is the channel.
    await this.deps.sms.send({
      destination: phone,
      body: `USRP verification code: ${otp}. Valid ${String(Math.round(this.deps.config.otpTtlSeconds / 60))} minutes. Never share this code.`,
    });

    await this.#audit(applicantId, 'APPLICANT_OTP_ISSUED', command.channel, context);
    return { kind: 'CHALLENGED' };
  }

  /** Step 3 — consume the code (bound to the phone) once; issue the session. */
  async verifyOtp(command: VerifyOtpCommand): Promise<VerifyOtpOutcome> {
    const applicantId = verifyOnboardingToken(
      this.deps.nationalIdHmacKey,
      command.onboardingToken,
      this.#now(),
    );
    if (applicantId === null) return { kind: 'INVALID_OTP' };
    const phone = normalizeRwandanMsisdn(command.rawPhoneNumber);
    if (phone === null) return { kind: 'INVALID_OTP' };
    const context = command.context ?? newCorrelationContext();

    const challenge = await this.deps.repository.findLiveChallenge(applicantId);
    if (challenge === null) return { kind: 'INVALID_OTP' };

    // Locked challenges never verify — even with the right code.
    if (challenge.attempts >= this.deps.config.otpMaxAttempts) {
      return { kind: 'INVALID_OTP' };
    }
    if (!verifyPassword(this.#otpSecret(command.otp, phone), challenge.otpHash)) {
      await this.deps.repository.recordFailedAttempt(challenge.id);
      return { kind: 'INVALID_OTP' };
    }

    // Single use is decided HERE, by the database, not by the read above. A
    // concurrent verifier that read the same live challenge and the same
    // correct code loses the compare-and-set and is refused — indistinguishable
    // from a wrong code, so the race is not even observable as a signal.
    const consumed = await this.deps.repository.consumeChallenge(challenge.id);
    if (!consumed) return { kind: 'INVALID_OTP' };

    // The number is now PROVEN controlled. It becomes the stored contact
    // (ADR-021) before the session is issued: a login that cannot record the
    // contact notification-service delivers to is a half-onboarded citizen.
    await this.deps.repository.stampPhoneVerified(
      applicantId,
      hashPhoneNumber(phone, this.deps.nationalIdHmacKey),
      phone,
    );

    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.#now().getTime() + this.deps.config.sessionTtlSeconds * 1000);
    await this.deps.repository.createSession({
      applicantId,
      sessionToken,
      channel: command.channel,
      expiresAt,
    });

    await this.#audit(applicantId, 'APPLICANT_SESSION_ISSUED', command.channel, context);
    return { kind: 'AUTHENTICATED', sessionToken, expiresAt: expiresAt.toISOString() };
  }

  /**
   * What the stored digest is computed over: code AND phone. A code sent to
   * one number therefore cannot verify a request that names another.
   */
  #otpSecret(otp: string, normalizedPhone: string): string {
    return `${otp}|${hashPhoneNumber(normalizedPhone, this.deps.nationalIdHmacKey)}`;
  }

  /** The applicant behind a live session token; null for anything else. */
  async authenticateSession(sessionToken: string): Promise<string | null> {
    if (sessionToken.length === 0 || sessionToken.length > 256) return null;
    const session = await this.deps.repository.findLiveSession(sessionToken);
    return session?.applicantId ?? null;
  }

  /** Revoke a session (logout). Idempotent; reveals nothing. */
  async logout(sessionToken: string): Promise<void> {
    if (sessionToken.length === 0 || sessionToken.length > 256) return;
    await this.deps.repository.terminateSession(sessionToken);
  }

  /** PII-free audit of a genuine issuance (never emitted for the silent paths). */
  async #audit(
    applicantId: string,
    action: 'APPLICANT_ONBOARDING_CONFIRMED' | 'APPLICANT_OTP_ISSUED' | 'APPLICANT_SESSION_ISSUED',
    channel: ApplicationChannel,
    context: EventContext,
  ): Promise<void> {
    const event: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: applicantId,
      action,
      performedBy: 'identity-service',
      agency: 'SYSTEM',
      metadata: { channel },
    };
    await this.deps.eventBus.publish(event);
  }
}

/** Constant-time equality of two ISO dates (digest compare, no early exit). */
function sameDate(a: string, b: string): boolean {
  return timingSafeEqualHex(sha256Hex(a), sha256Hex(b));
}

// ══════════════════════════════════════════════════════════════════
// identity-service — Applicant authentication (use case, ADR-018)
//
// The citizen door: OTP to the NIDA-registered phone → opaque, revocable
// DB session (owner D5). PII discipline throughout:
//   • the raw NID is request-only (hashed before any I/O, exactly like
//     identity verification);
//   • the raw phone comes from the LIVE NIDA lookup and exists only in
//     memory between that lookup and the SMS send — never stored, never
//     logged, never on the bus (only its HMAC lands, post-verification);
//   • the plaintext code exists only inside the SMS body — the store holds
//     a scrypt digest;
//   • NO ENUMERATION: an unknown NID, an unverified identity, a missing
//     NIDA record, and a phoneless record all return the SAME 'CHALLENGED'
//     outcome as a real send. Whether a NID is registered with USRP is not
//     observable from this endpoint.
//
// A citizen whose NIDA-registered phone is stale/absent cannot pass here —
// their path is the walk-in lane (ADR-012), where a field officer
// establishes identity in person. Documented in ADR-018.
// ══════════════════════════════════════════════════════════════════

import { randomBytes, randomInt } from 'node:crypto';
import { hashNationalId, hashPassword, hashPhoneNumber, verifyPassword } from '@usrp/shared-security';
import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { ApplicationChannel, AuditEvent } from '@usrp/shared-types';
import type { NidaGateway } from '../ports/nida.gateway.js';
import type { ApplicantAuthRepository } from '../ports/applicant-auth.repository.js';
import type { SmsChannel } from '../ports/sms-channel.js';

export interface RequestOtpCommand {
  readonly rawNationalId: string;
  readonly channel: ApplicationChannel;
  readonly context?: EventContext;
}

/** Uniform by design — the caller learns nothing about the NID's status. */
export type RequestOtpOutcome = { readonly kind: 'CHALLENGED' };

export interface VerifyOtpCommand {
  readonly rawNationalId: string;
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
}

export interface ApplicantAuthDeps {
  readonly repository: ApplicantAuthRepository;
  readonly nida: NidaGateway;
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

  async requestOtp(command: RequestOtpCommand): Promise<RequestOtpOutcome> {
    // Malformed NID throws (→ 400 at the edge) — a shape error, not a signal.
    const nationalIdHash = hashNationalId(command.rawNationalId, this.deps.nationalIdHmacKey);
    const context = command.context ?? newCorrelationContext();

    const applicantId = await this.deps.repository.findVerifiedApplicantByNidHash(nationalIdHash);
    if (applicantId === null) return { kind: 'CHALLENGED' }; // no enumeration

    // LIVE NIDA lookup for the registered phone — the binding that makes the
    // OTP mean "the person NIDA knows controls this NID's phone".
    const lookup = await this.deps.nida.lookupCitizen(command.rawNationalId);
    if (lookup.status !== 'FOUND' || lookup.citizen.registeredPhoneNumber === null) {
      return { kind: 'CHALLENGED' }; // phoneless/stale NIDA record → walk-in lane
    }

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(this.#now().getTime() + this.deps.config.otpTtlSeconds * 1000);
    await this.deps.repository.createChallenge({
      applicantId,
      otpHash: hashPassword(otp),
      expiresAt,
    });

    // The ONLY component that sees the raw destination is the channel.
    await this.deps.sms.send({
      destination: lookup.citizen.registeredPhoneNumber,
      body: `USRP verification code: ${otp}. Valid ${Math.round(this.deps.config.otpTtlSeconds / 60)} minutes. Never share this code.`,
    });

    await this.#audit(applicantId, 'APPLICANT_OTP_ISSUED', command.channel, context);
    return { kind: 'CHALLENGED' };
  }

  async verifyOtp(command: VerifyOtpCommand): Promise<VerifyOtpOutcome> {
    const nationalIdHash = hashNationalId(command.rawNationalId, this.deps.nationalIdHmacKey);
    const context = command.context ?? newCorrelationContext();

    const applicantId = await this.deps.repository.findVerifiedApplicantByNidHash(nationalIdHash);
    if (applicantId === null) return { kind: 'INVALID_OTP' };

    const challenge = await this.deps.repository.findLiveChallenge(applicantId);
    if (challenge === null) return { kind: 'INVALID_OTP' };

    // Locked challenges never verify — even with the right code.
    if (challenge.attempts >= this.deps.config.otpMaxAttempts) {
      return { kind: 'INVALID_OTP' };
    }
    if (!verifyPassword(command.otp, challenge.otpHash)) {
      await this.deps.repository.recordFailedAttempt(challenge.id);
      return { kind: 'INVALID_OTP' };
    }

    await this.deps.repository.consumeChallenge(challenge.id);

    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.#now().getTime() + this.deps.config.sessionTtlSeconds * 1000);
    await this.deps.repository.createSession({
      applicantId,
      sessionToken,
      channel: command.channel,
      expiresAt,
    });

    // Best-effort bookkeeping: re-resolve the NIDA phone to stamp its HMAC +
    // phone_verified_at. The session is already earned — a NIDA hiccup here
    // must not fail the login, so faults are swallowed (the stamp lands on
    // the next successful login instead).
    try {
      const lookup = await this.deps.nida.lookupCitizen(command.rawNationalId);
      if (lookup.status === 'FOUND' && lookup.citizen.registeredPhoneNumber !== null) {
        await this.deps.repository.stampPhoneVerified(
          applicantId,
          hashPhoneNumber(lookup.citizen.registeredPhoneNumber, this.deps.nationalIdHmacKey),
        );
      }
    } catch {
      // deliberately swallowed — see above
    }

    await this.#audit(applicantId, 'APPLICANT_SESSION_ISSUED', command.channel, context);
    return { kind: 'AUTHENTICATED', sessionToken, expiresAt: expiresAt.toISOString() };
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
    action: 'APPLICANT_OTP_ISSUED' | 'APPLICANT_SESSION_ISSUED',
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

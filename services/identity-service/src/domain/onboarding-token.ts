// ══════════════════════════════════════════════════════════════════
// identity-service — Onboarding token
//
// Step 1 of onboarding (National ID + date of birth, checked against NIDA)
// yields this token; steps 2 and 3 (phone, OTP) must present it. It is the
// server's statement "this caller proved knowledge of a NIDA-matching
// NID + DOB a moment ago", so the NID never has to be re-sent or re-looked-up.
//
// STATELESS, SIGNED, SHORT-LIVED:
//   • payload = { v, sub: applicantId, exp } — no NID, no DOB, no PII;
//   • HMAC-SHA256 under a key DERIVED from the national-ID HMAC key with a
//     purpose label, so a token can never be confused with another HMAC use;
//   • verified in constant time; expiry enforced against the injected clock.
//
// It is NOT a session. It authorises exactly one thing: requesting an OTP for
// a phone number and verifying it. Possession of it proves nothing about the
// phone — that is the OTP's job.
// ══════════════════════════════════════════════════════════════════

import { timingSafeEqualHex, hmacSha256Hex } from '@usrp/shared-security';

export const ONBOARDING_TOKEN_TTL_SECONDS = 15 * 60;

const PURPOSE = 'usrp:onboarding-token:v1';
const VERSION = 1;

interface Payload {
  readonly v: number;
  readonly sub: string;
  readonly exp: number;
}

function signingKey(rootKey: string): string {
  return hmacSha256Hex(rootKey, PURPOSE);
}

export function issueOnboardingToken(
  rootKey: string,
  applicantId: string,
  now: Date,
  ttlSeconds: number = ONBOARDING_TOKEN_TTL_SECONDS,
): { readonly token: string; readonly expiresAt: Date } {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const payload: Payload = { v: VERSION, sub: applicantId, exp };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = hmacSha256Hex(signingKey(rootKey), body);
  return { token: `${body}.${mac}`, expiresAt: new Date(exp * 1000) };
}

/** The applicant id the token was issued for, or null for anything invalid/expired. */
export function verifyOnboardingToken(rootKey: string, token: string, now: Date): string | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqualHex(hmacSha256Hex(signingKey(rootKey), body), mac)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Partial<Payload>;
  if (p.v !== VERSION || typeof p.sub !== 'string' || typeof p.exp !== 'number') return null;
  if (Math.floor(now.getTime() / 1000) >= p.exp) return null;
  return p.sub;
}

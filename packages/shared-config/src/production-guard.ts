// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — PRODUCTION BOOT GUARD
//
// .env.example ships well-known dev key material ON PURPOSE, so a fresh
// clone boots, and setup-dev.sh copies it verbatim. The file says those
// values "are worthless outside localhost" — but that sentence is a
// COMMENT, and a comment is not a control. This module is the control.
//
// Same failure class as the PORT_* map before c6fecea: a promise written in
// a template that no code read. The fix is the same shape — make the
// promise load-bearing at boot.
//
// EVERY RULE HERE IS INERT UNLESS NODE_ENV=production. Development, test
// and every one of the 39 proofs are completely unaffected — and that
// inertness is itself asserted, in both directions, by
// selfcheck/verify-production-guard.ts.
//
// DESIGN CONSTRAINTS INHERITED FROM env.ts
//   * Fail fast, fail LOUD — a service must not boot with a bad config.
//   * AGGREGATE every issue into a single throw, so an operator fixes all
//     of them in one pass instead of one redeploy at a time.
//   * Secret VALUES are never echoed. Only key names and reasons.
//   * No runtime dependencies. node:crypto is a Node builtin, not a
//     package, so the zero-dependency supply-chain posture holds.
// ══════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import { EnvValidationError, type EnvSource } from './env.js';

// ── Rule 1: the committed dev secrets, as digests ──────────────────
//
// SHA-256 of each secret literal committed in .env.example AND in
// scripts/run-selfchecks.sh, NOT the literals themselves. Two reasons, both
// load-bearing:
//
//   1. Storing the values here would make this file a SECOND committed copy
//      of the dev key material. A secret scanner that flags one would then
//      flag two, and the guard against leaked keys would itself be a leak.
//   2. A digest set is self-maintaining in the right direction:
//      `pnpm generate:env` mints fresh keypairs, which match nothing here
//      and pass silently. Only the UNROTATED committed value trips.
//
// To add a value: sha256 the exact string as the shell exports it, i.e.
// AFTER stripping the surrounding single quotes in .env.example.
const COMMITTED_DEV_SECRET_DIGESTS: ReadonlySet<string> = new Set([
  // .env.example
  '17425a1a967a33ed0e749ef69a1873dba7e775cb9193d8e994dfaf08ce97947c', // NATIONAL_ID_HMAC_KEY
  '91d86fc27a608db1c783e0c6fd224fb9621b8a526db4bac4cca32fd56c95d1d3', // PII_ENCRYPTION_KEY
  '666f7c1bd7da75da8b23e1946b68a5153ef3ee23a430ce15cd97a2d9ddc3e73f', // AUTH_JWT_PUBLIC_KEY_B64
  'd20685172cc005dd074e34aef61270fcb07c30a4e2c825176d9eafc98ea03b67', // AUTH_JWT_PRIVATE_KEY_B64
  'ba413216d708548ab6addae96715b87a47bb92cfa9ada3ba7fcc2d9e744782c3', // QR_SIGNING_PRIVATE_KEY_B64
  '0ce25e91efa78029597132e1cbe17914f8b712c2d7a758cdf7ac562a8e7c453d', // QR_INVITATION_PUBLIC_KEY_B64
  '941dbe652fb884249013c4ff6602eb68e70c40a56a7c9a9b30f5e5c92e352e31', // QR_SIGNING_KEY_ID (dev-qr-key-1)
  '574eda7e21079e734e49702b11cf8ee295a06b9e4341421b5cbbccf83441f434', // IDENTITY_CLIENT_SECRET
  'ae26ad99c36887a173e7ec3e34db294e68a64f8cdfbaa7ae0817e47e0addeae6', // NIDA_HMAC_SECRET
  '6516de28c9824c741876f2d491409aefb9dc807137d26f76b7b6c85f81a15d28', // NESA_HMAC_SECRET
  '23720aa976419b1519215a41a1999473fd711e6e0dadcbb40a19b61c76df4510', // RIB_HMAC_SECRET
  'abd260d3f2a95a2a51aa9f8706f685bc1ee337dea4cc64657a99b5af574e7cae', // HEC_HMAC_SECRET
  '71fa84b5054fffe642a9387ca35fc47e619168b10ad0eff874c01f2e7908469a', // POSTGRES_PASSWORD
  '106c7f317376e17c9786d5768793f20a00d3c939c227a8047d3944a2ff5dfa79', // MINIO_ROOT_PASSWORD
  'b64cab6f9f985bdb3d61108e136051a5193401935c51acc67ec5092e64112a24', // MINIO_ENCRYPTION_KEY
  '526304aae91f72133f1f53223829ff5bb1bc5b918b27d9dedb717410df5344ad', // EDGE_SESSION_HMAC_KEY
  // scripts/run-selfchecks.sh — a committed file, so its exported values are
  // published dev material exactly like the template's.
  '9036a1ea2c9d3f06a263e4463abeb26bcba9ceea7a60c83f8daade5d56fe5771', // QR_SIGNING_KEY_ID (selfcheck-qr-key-1)
]);

/**
 * Every variable that carries key material, a credential, or a shared
 * secret. Explicit rather than name-pattern-matched: a closed list is
 * auditable, and a regex over `*_KEY|*_SECRET` would quietly stop covering
 * a variable the day someone names one `..._TOKEN`.
 */
const SECRET_KEYS: readonly string[] = [
  'NATIONAL_ID_HMAC_KEY',
  'PII_ENCRYPTION_KEY',
  'AUTH_JWT_PUBLIC_KEY_B64',
  'AUTH_JWT_PRIVATE_KEY_B64',
  'QR_SIGNING_PRIVATE_KEY_B64',
  'QR_INVITATION_PUBLIC_KEY_B64',
  'QR_SIGNING_KEY_ID',
  'IDENTITY_CLIENT_SECRET',
  'MINIO_ENCRYPTION_KEY',
  'MINIO_ROOT_PASSWORD',
  'EDGE_SESSION_HMAC_KEY',
  'POSTGRES_PASSWORD',
  'NIDA_HMAC_SECRET',
  'NESA_HMAC_SECRET',
  'RIB_HMAC_SECRET',
  'HEC_HMAC_SECRET',
  'NIDA_API_KEY',
  'NESA_API_KEY',
  'RIB_API_KEY',
  'HEC_API_KEY',
  'MTN_SMS_API_KEY',
  'AIRTEL_SMS_API_KEY',
  'GRAFANA_ADMIN_PASSWORD',
  'SMTP_PASS',
  'USSD_PASSWORD',
];

// ── Rule 2: placeholders ───────────────────────────────────────────
//
// 'CHANGE_ME_32_CHAR_MIN_AES256_KEY' is EXACTLY 32 characters, so it clears
// the minLength(32) floor in loadSecurityConfig / loadEdgeSessionConfig and
// boots. A placeholder that WORKS is the worst kind: it reads as a control
// while providing no secrecy at all.
const PLACEHOLDER_PATTERN = /CHANGE_ME|REPLACE_ME|INSERT_YOUR|YOUR_[A-Z0-9_]*_HERE|^TODO$/i;

// ── Rule 3: endpoints that must leave the developer's machine ──────
//
// Every one of these defaults to localhost in the template. A production
// pod that keeps the default does not fail cleanly: it talks to itself, or
// to whatever sidecar happens to answer that port.
const NETWORK_ENDPOINT_KEYS: readonly string[] = [
  'DATABASE_URL',
  'KAFKA_BROKERS',
  'IAM_BASE_URL',
  'APPLICATION_SERVICE_BASE_URL',
  'NIDA_BASE_URL',
  'NESA_BASE_URL',
  'RIB_BASE_URL',
  'HEC_BASE_URL',
  'MINIO_ENDPOINT',
  'CLAMAV_HOST',
];

// ANCHORED, never a substring test. A bare `includes('localhost')` would
// refuse the legitimate hostname 'notlocalhostish.gov.rw'; a guard with
// false positives gets switched off, and then it guards nothing.
const LOOPBACK_PATTERN = /(^|[/@:])(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|host\.docker\.internal)([:/]|$)/i;

// ── Rule 4: toggles that are safe on localhost and not in production ──
//
// The mock flags are the severe ones. FEATURE_USE_RIB_MOCK=true in
// production means background vetting returns FIXTURES — every applicant
// clears a criminal-record check that no real authority ever performed,
// and the audit trail records a clean verdict indistinguishable from a
// genuine one.
interface ForbiddenToggle {
  readonly key: string;
  readonly forbidden: 'true' | 'false';
  readonly why: string;
}

const FORBIDDEN_TOGGLES: readonly ForbiddenToggle[] = [
  {
    key: 'FEATURE_USE_NIDA_MOCK',
    forbidden: 'true',
    why: 'identity verification would return fixtures, not NIDA answers',
  },
  {
    key: 'FEATURE_USE_NESA_MOCK',
    forbidden: 'true',
    why: 'academic eligibility would be decided against fixtures',
  },
  {
    key: 'FEATURE_USE_RIB_MOCK',
    forbidden: 'true',
    why: 'background vetting would clear every applicant against fixtures',
  },
  {
    key: 'FEATURE_USE_HEC_MOCK',
    forbidden: 'true',
    why: 'higher-education verification would be decided against fixtures',
  },
  {
    key: 'KAFKA_SSL',
    forbidden: 'false',
    why: 'the event backbone carries applicant PII between services',
  },
  {
    key: 'MINIO_USE_SSL',
    forbidden: 'false',
    why: 'scanned identity documents would cross the network in the clear',
  },
  {
    key: 'EDGE_COOKIE_SECURE',
    forbidden: 'false',
    why: 'browsers SILENTLY DROP a __Host- cookie that is not Secure, so every session breaks',
  },
];

// ── Implementation ────────────────────────────────────────────────

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const present = (raw: string | undefined): raw is string =>
  raw !== undefined && raw.trim() !== '';

/** True when this process is running as production. */
export function isProduction(source: EnvSource = process.env): boolean {
  return (source['NODE_ENV'] ?? '').trim().toLowerCase() === 'production';
}

/**
 * Refuse to boot a production process that is still carrying development
 * key material, placeholder secrets, loopback endpoints, or mock
 * integrations.
 *
 * Call this FIRST in `main()` — before any other config loader — so the
 * process dies before it opens a socket, a database pool or a consumer
 * group. A no-op unless NODE_ENV=production.
 *
 * A MISSING variable is deliberately NOT this function's business: that
 * belongs to the loader that owns it, and duplicating the responsibility
 * would produce two different error messages for one condition.
 *
 * @throws {EnvValidationError} listing every violation at once.
 */
export function assertProductionSecrets(source: EnvSource = process.env): void {
  if (!isProduction(source)) return;

  const issues: string[] = [];

  // Rule 1 + 2 — secret-bearing variables.
  for (const key of SECRET_KEYS) {
    const raw = source[key];
    if (!present(raw)) continue; // absence is the individual loader's business

    if (COMMITTED_DEV_SECRET_DIGESTS.has(sha256(raw))) {
      issues.push(
        `${key} is still the well-known DEVELOPMENT value committed in the repository — ` +
          `it is public in git history. Supply the production value from HSM/KMS.`,
      );
      continue;
    }

    if (PLACEHOLDER_PATTERN.test(raw)) {
      issues.push(
        `${key} is still an unreplaced placeholder. It may satisfy a length floor ` +
          `while providing no secrecy at all.`,
      );
    }
  }

  // Rule 3 — endpoints.
  for (const key of NETWORK_ENDPOINT_KEYS) {
    const raw = source[key];
    if (!present(raw)) continue;
    if (LOOPBACK_PATTERN.test(raw)) {
      issues.push(
        `${key} still points at a loopback/dev address. In production this resolves ` +
          `to the pod itself, so the dependency is silently absent rather than loudly broken.`,
      );
    }
  }

  // Rule 4 — toggles.
  for (const toggle of FORBIDDEN_TOGGLES) {
    const raw = source[toggle.key];
    if (!present(raw)) continue;
    const normalized = raw.trim().toLowerCase();
    const isTrue = normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    const isFalse = normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
    const violates = toggle.forbidden === 'true' ? isTrue : isFalse;
    if (violates) {
      issues.push(`${toggle.key}=${toggle.forbidden} is forbidden in production — ${toggle.why}.`);
    }
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }
}

// ── Event transport resolution ─────────────────────────────────────

export type EventTransport =
  | { readonly kind: 'kafka' }
  | { readonly kind: 'in-memory'; readonly reason: string };

/**
 * Decide which event transport this process should use.
 *
 * Eleven `main.ts` files each re-implemented this as a bare
 * `process.env['KAFKA_BROKERS']` truthiness test, reaching past
 * @usrp/shared-config to do it. One rule, one place, and — critically —
 * one place to make it FAIL CLOSED.
 *
 * In development an unset broker list still degrades to the in-memory bus,
 * exactly as before, so tier1-only stacks keep working.
 *
 * In PRODUCTION it throws. audit-service is the reason: as a pure event
 * SINK on an in-memory bus it accepts every write and records NOTHING
 * durable, while /health and /ready both stay green. The append-only trail
 * that rls/0007 enforces and Law N° 058/2021 requires would be a silent
 * no-op, and the first anyone learns of it is when a rejected applicant
 * asks why their file has no history. A legal audit trail must not be able
 * to fail quietly.
 *
 * @throws {EnvValidationError} in production when KAFKA_BROKERS is unset.
 */
export function resolveEventTransport(source: EnvSource = process.env): EventTransport {
  const brokers = source['KAFKA_BROKERS'];

  if (present(brokers)) return { kind: 'kafka' };

  if (isProduction(source)) {
    throw new EnvValidationError([
      'KAFKA_BROKERS is required in production. Without it the event backbone ' +
        'silently falls back to an in-memory bus: cross-service events are never ' +
        'delivered and the immutable audit trail records nothing, while every ' +
        'healthcheck stays green.',
    ]);
  }

  return {
    kind: 'in-memory',
    reason: 'KAFKA_BROKERS unset — in-memory event bus. Nothing durable, nothing cross-service. Dev only.',
  };
}

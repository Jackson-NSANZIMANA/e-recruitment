// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — the SANDBOX profile and its two-way fences (ADR-047 §3.1)
//
// USRP_ENVIRONMENT names the runtime profile:
//
//   development  the developer's machine and CI proofs (NODE_ENV ≠ production);
//   sandbox      the production boot guard IN FULL, with documented
//                differences only: G2G and SMS base URLs may point at the
//                fenced simulators (tools/g2g-sandbox), the stack may be
//                single-host (loopback endpoints, no broker/object-store TLS),
//                and the dev SMS inbox stands in for the Twilio emulator until
//                S12b. Requires NODE_ENV=production;
//   production   everything; never a simulator.
//
// Unset, it follows NODE_ENV (production → production, else development), so
// every existing process keeps its behaviour.
//
// THE FENCES, both directions, each proven red and green by
// selfcheck/verify-sandbox-fences.ts:
//
//   1. a simulator refuses to start outside sandbox/development, and stamps
//      every response `x-usrp-sandbox: 1` (tools/g2g-sandbox);
//   2. production refuses a G2G/SMS base URL on a simulator host, and any
//      upstream response carrying `x-usrp-sandbox` (adapters call
//      isForbiddenSandboxResponse);
//   3. sandbox refuses the REAL registry hosts. The only exception, the
//      live-NESA passthrough (§3.6), lives inside the simulator process, so a
//      sandbox SERVICE never holds a real registry URL at all.
//
// Zero dependencies, values never echoed (only key names and hosts' roles).
// ══════════════════════════════════════════════════════════════════

import { EnvValidationError, type EnvSource } from './env.js';

export const USRP_ENVIRONMENTS = ['development', 'sandbox', 'production'] as const;
export type UsrpEnvironment = (typeof USRP_ENVIRONMENTS)[number];

/** The response header every simulator stamps; production refuses it. */
export const SANDBOX_RESPONSE_HEADER = 'x-usrp-sandbox';

/**
 * Every base URL that names an external authority (G2G registries and the SMS
 * operator). Append-only; S12b adds the Irembo certificate and Twilio keys.
 */
export const G2G_BASE_URL_KEYS: readonly string[] = [
  'NIDA_BASE_URL',
  'NESA_BASE_URL',
  'RIB_BASE_URL',
  'HEC_BASE_URL',
  'IREMBO_CERTIFICATES_BASE_URL',
  'SMS_BASE_URL',
  'TWILIO_BASE_URL',
];

/**
 * Simulator hosts: the compose service name (`g2g-sandbox`), its container
 * name (`usrp-g2g-sandbox`) and anything under a `g2g-sandbox` DNS label or
 * the `.sandbox.usrp.internal` zone. Loopback is refused in production by the
 * production guard's endpoint rule already.
 */
const SIMULATOR_HOST_PATTERN = /(^|\.)(usrp-)?g2g-sandbox(\.|$)|\.sandbox\.usrp\.internal$/i;

/** The real registries (ADR-047 §1) and the registry zones around them. */
const REAL_REGISTRY_HOST_PATTERN =
  /(^|\.)(irembohub\.com|irembo\.gov\.rw|sdms\.gov\.rw|nida\.gov\.rw|nesa\.gov\.rw|rib\.gov\.rw|hec\.gov\.rw)$/i;

/** Development adapters a sandbox may still wire, each with the session that retires it. */
const SANDBOX_PERMITTED_DEV_ADAPTERS: ReadonlySet<string> = new Set([
  // Retired by S12b (Twilio-compatible emulator behind SmsChannel).
  'LogSmsChannel',
]);

const present = (raw: string | undefined): raw is string => raw !== undefined && raw.trim() !== '';

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null; // a malformed URL is the owning loader's error, not this fence's
  }
}

export function isSimulatorHost(host: string): boolean {
  return SIMULATOR_HOST_PATTERN.test(host);
}

export function isRealRegistryHost(host: string): boolean {
  return REAL_REGISTRY_HOST_PATTERN.test(host);
}

/**
 * Resolve the runtime profile. Throws on an unknown value or a contradictory
 * pair (a sandbox or production profile without NODE_ENV=production, or a
 * development profile with it).
 */
export function resolveUsrpEnvironment(source: EnvSource = process.env): UsrpEnvironment {
  const nodeProduction = (source['NODE_ENV'] ?? '').trim().toLowerCase() === 'production';
  const raw = (source['USRP_ENVIRONMENT'] ?? '').trim().toLowerCase();
  if (raw === '') return nodeProduction ? 'production' : 'development';
  if (!(USRP_ENVIRONMENTS as readonly string[]).includes(raw)) {
    throw new EnvValidationError([`USRP_ENVIRONMENT must be one of ${USRP_ENVIRONMENTS.join(', ')}.`]);
  }
  const env = raw as UsrpEnvironment;
  if (env !== 'development' && !nodeProduction) {
    throw new EnvValidationError([
      `USRP_ENVIRONMENT=${env} requires NODE_ENV=production: the ${env} profile runs the production boot guard in full.`,
    ]);
  }
  if (env === 'development' && nodeProduction) {
    throw new EnvValidationError([
      'USRP_ENVIRONMENT=development contradicts NODE_ENV=production. Unset USRP_ENVIRONMENT, or name the profile.',
    ]);
  }
  return env;
}

export function isSandbox(source: EnvSource = process.env): boolean {
  return resolveUsrpEnvironment(source) === 'sandbox';
}

/**
 * The configuration half of fences 2 and 3. Returns the issues (never throws),
 * so the production guard can aggregate them with its own.
 */
export function sandboxFenceIssues(source: EnvSource = process.env): string[] {
  let env: UsrpEnvironment;
  try {
    env = resolveUsrpEnvironment(source);
  } catch (error) {
    return error instanceof EnvValidationError ? [...error.issues] : ['USRP_ENVIRONMENT could not be resolved.'];
  }
  const issues: string[] = [];
  for (const key of G2G_BASE_URL_KEYS) {
    const raw = source[key];
    if (!present(raw)) continue;
    const host = hostOf(raw);
    if (host === null) continue;
    if (env === 'production' && isSimulatorHost(host)) {
      issues.push(`${key} points at a G2G SIMULATOR host. A production process never talks to the sandbox simulators.`);
    }
    if (env === 'sandbox' && isRealRegistryHost(host)) {
      issues.push(
        `${key} points at a REAL registry host. The sandbox talks only to the fenced simulators; ` +
          'the one live exception (NESA passthrough, ADR-047 §3.6) is configured on the simulator, not here.',
      );
    }
  }
  return issues;
}

/** Throw if fences 2 (config half) or 3 are violated. A no-op in development. */
export function assertSandboxFences(source: EnvSource = process.env): void {
  const issues = sandboxFenceIssues(source);
  if (issues.length > 0) throw new EnvValidationError(issues);
}

/** Fence 1: a simulator may start only in sandbox or development. */
export function assertSimulatorAllowed(source: EnvSource = process.env): UsrpEnvironment {
  const env = resolveUsrpEnvironment(source);
  if (env === 'production') {
    throw new EnvValidationError([
      'The G2G simulators refuse to start in production. Set USRP_ENVIRONMENT=sandbox (with NODE_ENV=production) or run in development.',
    ]);
  }
  return env;
}

/** Minimal header view, satisfied by fetch's Headers and node's IncomingHttpHeaders wrappers. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Fence 2, response half: true when THIS process is production and the
 * upstream answered as a simulator. The adapter treats it as an
 * infrastructure fault (never a verdict about the citizen) and logs it.
 */
export function isForbiddenSandboxResponse(headers: HeaderReader, source: EnvSource = process.env): boolean {
  if (headers.get(SANDBOX_RESPONSE_HEADER) === null) return false;
  try {
    return resolveUsrpEnvironment(source) === 'production';
  } catch {
    return true; // an unresolvable profile is treated as the strictest one
  }
}

/** True when a development adapter is permitted in this sandbox (inert elsewhere). */
export function isSandboxPermittedDevAdapter(adapter: string, source: EnvSource = process.env): boolean {
  try {
    return resolveUsrpEnvironment(source) === 'sandbox' && SANDBOX_PERMITTED_DEV_ADAPTERS.has(adapter);
  } catch {
    return false;
  }
}

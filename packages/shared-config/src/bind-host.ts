// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — HTTP bind host (ADR-053, evaluation D9)
//
// THE DEFECT THIS EXISTS TO PREVENT. `startHttpServer` defaulted its bind host
// to '0.0.0.0' and not one service passed `host`, so `pnpm sandbox:full` put
// THIRTEEN processes — the edge, the identity door, the officer service, the
// field-sync write path — on every interface of a laptop in a café or a venue.
// Nothing announced it. Exposure was an inheritance, not a decision.
//
// AND THE TRAP IN THE OBVIOUS FIX. "Bind loopback" is correct for a laptop and
// WRONG for the pilot: M2's exam day is driven from Galaxy Tab A7–A10 over the
// venue network (ROADMAP §8.2, S08). Hard-wiring loopback would make that
// impossible, and the flag to undo it would be added quietly by whoever hit the
// wall at 2 a.m., unproven.
//
// SO THE RULE IS: loopback unless someone says otherwise, and saying so must be
// explicit, visible and refused in combination with real citizen traffic.
//
//   USRP_HTTP_BIND_HOST set      → validated IP literal, used verbatim
//   production, unset       → BOOT FAILS naming the variable (a container that
//                             binds loopback is a service nobody can call, and
//                             failing loudly beats a silent black hole)
//   otherwise               → 127.0.0.1
//
// The sandbox's LAN switch lives in the launcher (SANDBOX_EXPOSE_LAN), not here:
// it must never be expressible in a production environment.
// ══════════════════════════════════════════════════════════════════

import type { EnvSource } from './env.js';

export const BIND_HOST_VAR = 'USRP_HTTP_BIND_HOST';

/** The loopback literal every service falls back to. */
export const LOOPBACK = '127.0.0.1';

export class BindHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindHostError';
  }
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/**
 * IPv6 literal, simplified on purpose. A hostname is REFUSED: resolving one at
 * boot makes the bound interface depend on DNS, and 'localhost' would quietly
 * mean "whatever the resolver says today" — which is exactly the kind of
 * ambiguity this module exists to remove.
 */
const IPV6 = /^\[?[0-9a-fA-F:]+\]?$/;

export function isIpLiteral(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
}

export interface BindHostOptions {
  readonly serviceName: string;
  readonly env?: EnvSource;
}

/**
 * Resolve the host a service binds. Throws BindHostError when the deployment is
 * production and has not said where to listen.
 */
export function resolveHttpBindHost(options: BindHostOptions): string {
  const source = options.env ?? process.env;
  const raw = source[BIND_HOST_VAR];
  const production = source['NODE_ENV'] === 'production';
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (value === '') {
    if (production) {
      throw new BindHostError(
        `${BIND_HOST_VAR} is required in production: ${options.serviceName} would otherwise bind ${LOOPBACK}, ` +
          'which nothing outside its own container can reach. Set it to the pod/container address (or 0.0.0.0 ' +
          'behind a reverse proxy). See ADR-053.',
      );
    }
    return LOOPBACK;
  }

  if (!isIpLiteral(value)) {
    throw new BindHostError(
      `${BIND_HOST_VAR} must be an IP literal (e.g. ${LOOPBACK}, 10.0.12.4, 0.0.0.0, ::). ` +
        `Got "${value}": a hostname would make the bound interface depend on DNS. See ADR-053.`,
    );
  }
  return value;
}

/** Is this host reachable from outside the machine? Used by the boot log + proofs. */
export function isExposedHost(host: string): boolean {
  return host !== LOOPBACK && host !== '::1';
}

/**
 * The one honest log line. Every service announces where it will listen, BEFORE
 * the socket opens, so an exposed process is visible in the boot log and in
 * `sandbox:full status` rather than only in `ss -ltnp` — and so a process that
 * then fails to bind has still declared its intent.
 */
export function bindHostAnnouncement(serviceName: string, host: string, port: number): Record<string, unknown> {
  return {
    msg: 'http_bind_chosen',
    service: serviceName,
    host,
    port,
    exposure: isExposedHost(host) ? 'network' : 'loopback',
  };
}

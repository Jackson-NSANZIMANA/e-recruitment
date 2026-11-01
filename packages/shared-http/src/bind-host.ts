// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — The bind address, decided in ONE place
//
// THE DEFECT THIS CLOSES (evaluation D9). Every service binds `0.0.0.0` by
// default, and NOTHING could change it: `startHttpServer` accepted a `host`
// option that no service passed, and no environment variable fed it. So the
// sandbox published eleven credential-bearing services (and the edge, which
// holds a live upstream credential for every officer session) on every
// interface of the developer's laptop — while the same sandbox profile
// loopback-bound every container it started (127.0.0.1:4992/4993/4995 in
// docker-compose.sandbox.yml). The most sensitive processes were the only ones
// listening for the coffee shop.
//
// WHY AN ENV VAR AND NOT A PER-SERVICE OPTION. There are twelve processes and
// twelve `main.ts` files; a per-service option is twelve places to forget. The
// launcher that already owns their environment (`pnpm sandbox:up`) sets one
// variable and every process obeys, container platforms keep the default, and a
// service booted by hand in development behaves exactly as before.
//
// WHY IT FAILS CLOSED. A mistyped value must not silently fall back to every
// interface: an unrecognised host is a boot error, not a default. The accepted
// forms are deliberately narrow — the two wildcard addresses, the two loopback
// addresses, `localhost`, or an explicit IPv4 literal (a host with several
// interfaces legitimately binds one of them in production). A hostname is
// refused because resolving it here would make the bind address depend on DNS.
// ══════════════════════════════════════════════════════════════════

/** The variable every service reads. Set to 127.0.0.1 by `pnpm sandbox:up`. */
export const BIND_HOST_ENV = 'USRP_HTTP_BIND_HOST';

/** Containers and orchestrated platforms reach the process through its own network. */
export const DEFAULT_BIND_HOST = '0.0.0.0';

const WILDCARD = new Set(['0.0.0.0', '::']);
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export interface ResolveBindHostOptions {
  /** Injected for tests; defaults to process.env. */
  readonly source?: Readonly<Record<string, string | undefined>>;
}

/**
 * The address to bind, from `USRP_HTTP_BIND_HOST` when set.
 *
 * @throws {Error} on an unset-but-empty or unrecognised value — an operator who
 *   asked for a specific interface gets that interface or a refusal to boot.
 */
export function resolveBindHost(options: ResolveBindHostOptions = {}): string {
  const source = options.source ?? process.env;
  const raw = (source[BIND_HOST_ENV] ?? '').trim();
  if (raw === '') return DEFAULT_BIND_HOST;
  if (WILDCARD.has(raw) || LOOPBACK.has(raw) || IPV4.test(raw)) return raw;
  throw new Error(
    `${BIND_HOST_ENV}="${raw}" is not a bind address. Use "0.0.0.0" or "::" (all interfaces), ` +
      '"127.0.0.1", "::1" or "localhost" (loopback only), or an explicit IPv4 address of this host.',
  );
}

/** True when the resolved host listens on a loopback interface only. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

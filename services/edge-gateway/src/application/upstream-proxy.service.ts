// ══════════════════════════════════════════════════════════════════
// edge-gateway — Upstream proxy use case
//
// Generic upstream call orchestration: resolve session, forward request,
// handle errors. Used by all controllers that proxy to backend microservices.
//
// Part of hexagonal architecture refactoring - application layer.
// ══════════════════════════════════════════════════════════════════

import type { UpstreamGateway, UpstreamCallInput, UpstreamResult } from '../ports/upstream-gateway.js';
import type { EdgeSession } from '../domain/session.types.js';

export interface UpstreamProxyDeps {
  readonly upstream: UpstreamGateway;
}

/**
 * Upstream proxy use case. Provides a single abstraction for calling upstream
 * microservices with session resolution and error handling.
 *
 * Controllers use this to forward requests upstream without duplicating the
 * call logic, credential extraction, and error mapping.
 */
export class UpstreamProxyService {
  constructor(private readonly deps: UpstreamProxyDeps) {}

  /**
   * Call an upstream operation with the session's credential. Extracts the
   * upstream credential from the session and forwards it with the request.
   *
   * @param input Upstream call input (operation, query, body)
   * @param session The resolved session (for credential)
   * @returns Upstream result (status + body)
   */
  async callWithSession(
    input: Omit<UpstreamCallInput, 'credential'>,
    session: EdgeSession | null
  ): Promise<UpstreamResult> {
    const credential = session?.upstreamCredential;

    return this.deps.upstream.call({
      ...input,
      ...(credential ? { credential } : {}),
    });
  }

  /**
   * Call an upstream operation without a credential (anonymous operations).
   *
   * @param input Upstream call input (operation, query, body)
   * @returns Upstream result (status + body)
   */
  async call(input: UpstreamCallInput): Promise<UpstreamResult> {
    return this.deps.upstream.call(input);
  }
}

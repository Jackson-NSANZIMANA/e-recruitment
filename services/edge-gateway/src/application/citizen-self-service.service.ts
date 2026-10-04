// ══════════════════════════════════════════════════════════════════
// edge-gateway — Citizen self-service (application use cases)
//
// Application services orchestrating:
//   - listing own applications
//   - withdrawing own application
//   - reading and filing erasure requests (Law 058/2021)
// ══════════════════════════════════════════════════════════════════

import { UPSTREAM } from '../domain/upstream-operations.js';
import type { EdgeSession } from '../domain/session.types.js';
import type { UpstreamGateway, UpstreamResponse } from '../ports/upstream-gateway.js';

export interface CitizenSelfServiceDeps {
  readonly upstream: UpstreamGateway;
}

export class CitizenSelfService {
  constructor(private readonly deps: CitizenSelfServiceDeps) {}

  async listApplications(session: EdgeSession, correlationId: string): Promise<UpstreamResponse> {
    return this.deps.upstream.call({
      operation: UPSTREAM.myApplications,
      correlationId,
      credential: session.upstreamCredential,
    });
  }

  async withdrawApplication(
    session: EdgeSession,
    applicationId: string,
    correlationId: string,
  ): Promise<UpstreamResponse> {
    return this.deps.upstream.call({
      operation: UPSTREAM.myWithdraw,
      correlationId,
      credential: session.upstreamCredential,
      body: { applicationId },
    });
  }

  async getErasureRequest(session: EdgeSession, correlationId: string): Promise<UpstreamResponse> {
    return this.deps.upstream.call({
      operation: UPSTREAM.myErasureRequestGet,
      correlationId,
      credential: session.upstreamCredential,
    });
  }

  async fileErasureRequest(session: EdgeSession, correlationId: string): Promise<UpstreamResponse> {
    return this.deps.upstream.call({
      operation: UPSTREAM.myErasureRequestFile,
      correlationId,
      credential: session.upstreamCredential,
      body: {},
    });
  }
}

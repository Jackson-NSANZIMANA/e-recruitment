// ══════════════════════════════════════════════════════════════════
// edge-gateway — Application detail composition (application use case)
//
// The Procedural Justice view combines the application record AND the
// complete immutable decision trail in one round trip.
// ══════════════════════════════════════════════════════════════════

import { UPSTREAM } from '../domain/upstream-operations.js';
import type { EdgeSession } from '../domain/session.types.js';
import type { UpstreamGateway, UpstreamResponse } from '../ports/upstream-gateway.js';

export interface ApplicationDetailDeps {
  readonly upstream: UpstreamGateway;
}

export interface ComposedApplicationDetailResult {
  readonly record: UpstreamResponse;
  readonly history: UpstreamResponse;
}

export class ApplicationDetailService {
  constructor(private readonly deps: ApplicationDetailDeps) {}

  async getDetail(
    session: EdgeSession,
    applicationId: string,
    correlationId: string,
  ): Promise<ComposedApplicationDetailResult> {
    const [record, history] = await Promise.all([
      this.deps.upstream.call({
        operation: UPSTREAM.applicationById,
        correlationId,
        credential: session.upstreamCredential,
        query: { applicationId },
      }),
      this.deps.upstream.call({
        operation: UPSTREAM.statusHistory,
        correlationId,
        credential: session.upstreamCredential,
        query: { applicationId },
      }),
    ]);

    return { record, history };
  }
}

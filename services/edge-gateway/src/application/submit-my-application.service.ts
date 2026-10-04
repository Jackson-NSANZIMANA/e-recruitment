// ══════════════════════════════════════════════════════════════════
// edge-gateway — Submit citizen application (application use case)
//
// Encapsulates the orchestration of citizen submission (ADR-027):
//   1. Invokes the identity submit bridge through the UpstreamGateway port.
//   2. Handles responses: initial submit (201), idempotent replay (200),
//      live duplicate (409 ALREADY_APPLIED), key reuse (422 KEY_REUSED),
//      and business conflicts.
//   3. Emits required audit records for replay and key-reuse events.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationCategory } from '@usrp/shared-types';
import { UPSTREAM } from '../domain/upstream-operations.js';
import type { EdgeSession } from '../domain/session.types.js';
import type { UpstreamGateway } from '../ports/upstream-gateway.js';
import type { AuditLogger } from '../ports/audit-logger.js';

export interface SubmitMyApplicationCommand {
  readonly session: EdgeSession;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly category: ApplicationCategory;
  readonly nesaIndexNumber?: string;
  readonly hecRegistrationNumber?: string;
}

export type SubmitMyApplicationResult =
  | {
      readonly kind: 'SUBMITTED';
      readonly applicationId: string;
      readonly processingCode: string;
      readonly agency: string;
    }
  | {
      readonly kind: 'REPLAYED';
      readonly applicationId: string;
      readonly processingCode: string;
      readonly agency: string;
    }
  | {
      readonly kind: 'ALREADY_APPLIED';
      readonly applicationId: string | null;
      readonly processingCode: string | null;
      readonly agency: string | null;
    }
  | { readonly kind: 'KEY_REUSED' }
  | { readonly kind: 'CONFLICT'; readonly body: unknown }
  | { readonly kind: 'REVOKED' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'VALIDATION_FAILED'; readonly body: unknown }
  | { readonly kind: 'UPSTREAM_MISMATCH' };

export interface SubmitMyApplicationDeps {
  readonly upstream: UpstreamGateway;
  readonly audit: AuditLogger;
}

export class SubmitMyApplicationService {
  constructor(private readonly deps: SubmitMyApplicationDeps) {}

  async execute(command: SubmitMyApplicationCommand): Promise<SubmitMyApplicationResult> {
    const upstream = await this.deps.upstream.call({
      operation: UPSTREAM.mySubmit,
      correlationId: command.correlationId,
      credential: command.session.upstreamCredential,
      idempotencyKey: command.idempotencyKey,
      body: {
        category: command.category,
        ...(command.nesaIndexNumber === undefined ? {} : { nesaIndexNumber: command.nesaIndexNumber }),
        ...(command.hecRegistrationNumber === undefined ? {} : { hecRegistrationNumber: command.hecRegistrationNumber }),
      },
    });

    if (upstream.status === 401) {
      return { kind: 'REVOKED' };
    }

    if (upstream.status === 201) {
      const applicationId = field(upstream.body, 'applicationId');
      const processingCode = field(upstream.body, 'processingCode');
      const agency = field(upstream.body, 'agency');
      if (applicationId === null || processingCode === null || agency === null) {
        return { kind: 'UPSTREAM_MISMATCH' };
      }
      if (upstream.replayed === true) {
        this.deps.audit.log({
          action: 'EDGE_IDEMPOTENT_REPLAY',
          operationId: 'submitMyApplication',
          correlationId: command.correlationId,
          sessionId: command.session.sessionId,
          sessionKind: 'applicant',
        });
        return { kind: 'REPLAYED', applicationId, processingCode, agency };
      }
      return { kind: 'SUBMITTED', applicationId, processingCode, agency };
    }

    if (upstream.status === 409) {
      const upstreamStatus = field(upstream.body, 'status');
      if (upstreamStatus === 'KEY_REUSED') {
        this.deps.audit.log({
          action: 'EDGE_IDEMPOTENCY_KEY_REUSED',
          operationId: 'submitMyApplication',
          correlationId: command.correlationId,
          sessionId: command.session.sessionId,
          sessionKind: 'applicant',
        });
        return { kind: 'KEY_REUSED' };
      }
      if (upstreamStatus === 'ALREADY_APPLIED') {
        return {
          kind: 'ALREADY_APPLIED',
          applicationId: field(upstream.body, 'applicationId'),
          processingCode: field(upstream.body, 'processingCode'),
          agency: field(upstream.body, 'agency'),
        };
      }
      return { kind: 'CONFLICT', body: upstream.body };
    }

    if (upstream.status === 404) return { kind: 'NOT_FOUND' };
    if (upstream.status === 422) return { kind: 'VALIDATION_FAILED', body: upstream.body };
    if (upstream.status === 400) return { kind: 'VALIDATION_FAILED', body: { error: 'VALIDATION_FAILED' } };

    return { kind: 'UPSTREAM_MISMATCH' };
  }
}

function field(body: unknown, name: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

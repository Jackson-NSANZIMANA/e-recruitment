// ══════════════════════════════════════════════════════════════════
// edge-gateway — Citizen self-service
//
// SCOPED BY THE SESSION, NEVER BY A PARAMETER. There is no way to ask for, or
// act on, someone else's applications because there is nothing to ask with:
// the edge forwards the citizen's own opaque token and identity-service
// resolves the subject from it inside the read or write.
//
// Cross-agency by construction — which is why ApplicantSession carries no
// agency and why a UI asking a citizen to "choose your agency portal" would be
// modelling the officer's world. The agency of a NEW application is derived
// server-side from its category (agencyForCategory), never accepted as input.
//
// NO FORENSIC SIGNAL REACHES THIS SURFACE. A score handed to the person who
// uploaded the file is a forgery-tuning oracle.
//
// SUBMIT (ADR-027): the browser's write. The edge validates the body shape,
// REFUSES body `applicantId`/`channel` (the subject is the session; the
// channel is a server-side fact), requires exactly one UUID Idempotency-Key
// and forwards it — as a NARROW TYPED FIELD — to identity-service's bridge,
// which re-derives the subject and carries the key to application-service's
// ledger with its own system token. The edge never re-sends the write: the
// key is what makes the CITIZEN'S retry safe.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type RouteHandler } from '@usrp/shared-http';
import { ALL_CATEGORIES } from '@usrp/shared-types';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { field, projectMyApplications } from './projections.js';
import { NOT_FOUND, conflictResult, validationResult } from './outcomes.js';
import { withApplicantSession, type EdgeDeps } from './guards.js';
import { enforceRateLimit, sessionBucketKey } from './rate-limit.js';
import { optionalNote, readJsonBody, requireUuid } from './validation.js';

const MAX_REASON = 2_000;
/** Same bound as the walk-in lane and the identity bridge. */
const MAX_ACADEMIC_REF = 64;

/** Inbound request header carrying the citizen's retry identity (ADR-027). */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Outbound response header, set only when a stored answer was replayed. */
const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function listMyApplicationsHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'listMyApplications', async (ctx, session) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myApplications,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 401) {
      // The upstream token died before the edge handle did. Report it as an
      // ended session so the SPA re-authenticates instead of showing an error.
      return { status: 401, body: { reason: 'revoked' } };
    }
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return { status: 200, body: projectMyApplications(upstream.body) };
  });
}

/**
 * Submit the citizen's own application (ADR-027 front door).
 *
 * THE PUBLIC CONTRACT (what the SPA sees):
 *
 *   first submit  201 { status, applicationId, processingCode, agency }
 *   replay        200, same body, + Idempotency-Replayed: true
 *   live dup      409 ALREADY_APPLIED (identifiers KEPT — same shape as 201)
 *   key reuse     422 KEY_REUSED, NO identifiers
 *   shape error   400 (edge-validated; never forwarded)
 *   business      409 IDENTITY_NOT_VERIFIED / NO_OPEN_CAMPAIGN
 *   dependency    503 (fail closed, named code)
 *
 * Identifiers are consistent between 201 and 200: the replayed body is the
 * first submission's answer, byte-for-byte the same shape, so a client that
 * only reads the body behaves identically whether or not its first attempt
 * survived — the header is the only difference, and CORS exposes it.
 */
export function submitMyApplicationHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'submitMyApplication', async (ctx, session) => {
    const body = await readJsonBody(ctx);

    // REFUSED, not ignored: the subject is the session and the channel is a
    // server-side fact. An ignored authorization field is a control the
    // caller believes exists (same rule as validation.ts's forbidden set).
    if (body.applicantId !== undefined) {
      throw new HttpError(
        400,
        'FORBIDDEN_FIELD',
        'Field "applicantId" is not accepted at the browser boundary.',
      );
    }
    if (body.channel !== undefined) {
      throw new HttpError(
        400,
        'FORBIDDEN_FIELD',
        'Field "channel" is not accepted at the browser boundary.',
      );
    }

    // Shape validation BEFORE anything is charged or sent. Which academic
    // credential a category REQUIRES is application-service's domain rule;
    // the edge enforces only the wire shape.
    if (typeof body.category !== 'string' || !ALL_CATEGORIES.has(body.category)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Field "category" is not an accepted value.');
    }
    const category = body.category;
    const nesaIndexNumber = optionalBounded(body.nesaIndexNumber, 'nesaIndexNumber');
    const hecRegistrationNumber = optionalBounded(body.hecRegistrationNumber, 'hecRegistrationNumber');

    // Exactly one UUID Idempotency-Key. Duplicated headers arrive joined by
    // the transport ("k1, k2") and fail the UUID shape check — rejected
    // rather than resolved by picking one.
    const rawKey = headerValue(ctx.headers[IDEMPOTENCY_KEY_HEADER]);
    if (rawKey === undefined) {
      throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Header "Idempotency-Key" is required.');
    }
    const idempotencyKey = rawKey.trim();
    if (!UUID_RE.test(idempotencyKey)) {
      throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Header "Idempotency-Key" must be a UUID.');
    }

    // The approved applicant-session submission limit, keyed by the OPAQUE
    // edge session id — never by a raw credential. Fail-closed 503/429 comes
    // from enforceRateLimit itself.
    await enforceRateLimit(
      deps.limiter,
      sessionBucketKey(session.sessionId, 'submitMyApplication'),
      deps.config.rateLimits.applicantSubmitPerMinute,
    );

    // Forward ONLY the allowlisted fields plus the validated key (a typed
    // field on the port, never a header passthrough). The upstream subject
    // is re-derived from the session by identity-service.
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.mySubmit,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      idempotencyKey,
      body: {
        category,
        ...(nesaIndexNumber === undefined ? {} : { nesaIndexNumber }),
        ...(hecRegistrationNumber === undefined ? {} : { hecRegistrationNumber }),
      },
    });

    if (upstream.status === 401) {
      return { status: 401, body: { reason: 'revoked' } };
    }

    if (upstream.status === 201) {
      const applicationId = field(upstream.body, 'applicationId');
      const processingCode = field(upstream.body, 'processingCode');
      const agency = field(upstream.body, 'agency');
      if (applicationId === null || processingCode === null || agency === null) {
        return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
      }
      // The public replay answer: 200, the same body the 201 carried, plus
      // the header. Audited without the key ever appearing.
      if (upstream.replayed === true) {
        deps.audit.log({
          action: 'EDGE_IDEMPOTENT_REPLAY',
          operationId: 'submitMyApplication',
          correlationId: ctx.correlationId,
          sessionId: session.sessionId,
          sessionKind: 'applicant',
        });
        return {
          status: 200,
          headers: { [IDEMPOTENCY_REPLAYED_HEADER]: 'true' },
          body: { status: 'SUBMITTED', applicationId, processingCode, agency },
        };
      }
      return {
        status: 201,
        body: { status: 'SUBMITTED', applicationId, processingCode, agency },
      };
    }

    if (upstream.status === 409) {
      const upstreamStatus = field(upstream.body, 'status');
      if (upstreamStatus === 'KEY_REUSED') {
        // Identifier-free at this boundary too, and audited as the integrity
        // event it is — the key value itself is never logged (it is on the
        // adapter's redaction deny-list).
        deps.audit.log({
          action: 'EDGE_IDEMPOTENCY_KEY_REUSED',
          operationId: 'submitMyApplication',
          correlationId: ctx.correlationId,
          sessionId: session.sessionId,
          sessionKind: 'applicant',
        });
        return { status: 422, body: { error: 'KEY_REUSED' } };
      }
      if (upstreamStatus === 'ALREADY_APPLIED') {
        // Identifiers KEPT, same shape as the 201: this is the citizen's own
        // live application, and the answer exists to point them at it.
        return {
          status: 409,
          body: {
            error: 'ALREADY_APPLIED',
            applicationId: field(upstream.body, 'applicationId'),
            processingCode: field(upstream.body, 'processingCode'),
            agency: field(upstream.body, 'agency'),
          },
        };
      }
      // IDENTITY_NOT_VERIFIED / NO_OPEN_CAMPAIGN — the documented business
      // conflicts, mapped by the shared outcome vocabulary.
      return conflictResult(upstream.body);
    }

    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 422) return validationResult(upstream.body);
    if (upstream.status === 400) {
      // The edge validated the shape before forwarding, so a 400 here means
      // the edge and the bridge disagree about the contract — a wiring bug,
      // not a caller error.
      return { status: 422, body: { error: 'VALIDATION_FAILED' } };
    }
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

/** One inbound header value (Node joins duplicates into a comma string). */
function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return undefined;
}

/** An optional academic registry reference: string of sane length or absent. */
function optionalBounded(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > MAX_ACADEMIC_REF) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      `Field "${field}" must be a string of 1–${MAX_ACADEMIC_REF} characters when present.`,
    );
  }
  return value.trim();
}


/**
 * Withdraw one's own application. Ownership is enforced UPSTREAM, inside the
 * write transaction, against the session subject — not against a body field.
 *
 * `reason` is validated and NOT forwarded: the upstream route has no such field.
 */
export function withdrawMyApplicationHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'withdrawMyApplication', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    const applicationId = requireUuid(body.applicationId, 'applicationId');
    // Validated then discarded, so an over-long or NID-bearing value is still a
    // 400 rather than accepted-and-ignored.
    void optionalNote(body.reason, MAX_REASON);

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myWithdraw,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { applicationId },
    });

    if (upstream.status === 200) {
      const status = field(upstream.body, 'status');
      const agency = field(upstream.body, 'agency');
      return {
        status: 200,
        body: {
          applicationId,
          outcome: typeof status === 'string' ? status : 'WITHDRAWN',
          agency: typeof agency === 'string' ? agency : null,
          fromStatus: field(upstream.body, 'fromStatus') ?? null,
        },
      };
    }
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status === 409) return conflictResult(upstream.body);
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

/**
 * Erasure-request status (Law N° 058/2021 data-subject right). The upstream 404
 * becomes a 200 `{ exists: false }`: "you have no open request" is an ANSWER.
 */
export function getMyErasureRequestHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'getMyErasureRequest', async (ctx, session) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myErasureRequestGet,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 404) return { status: 200, body: { exists: false } };
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return {
      status: 200,
      body: {
        exists: true,
        requestId: field(upstream.body, 'requestId') ?? null,
        status: field(upstream.body, 'status') ?? null,
        filedAt: field(upstream.body, 'requestedAt') ?? null,
        decidedAt: field(upstream.body, 'decidedAt') ?? null,
        decisionNote: field(upstream.body, 'decisionNote') ?? null,
      },
    };
  });
}

/** File an erasure request. 202 both ways — erasure is adjudicated, not immediate. */
export function fileMyErasureRequestHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'fileMyErasureRequest', async (ctx, session) => {
    // The upstream intake takes no body; filing is idempotent upstream.
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myErasureRequestFile,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: {},
    });
    if (upstream.status === 202 || upstream.status === 200) {
      return {
        status: 202,
        body: { accepted: true, requestId: field(upstream.body, 'requestId') ?? null },
      };
    }
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status === 409) return { status: 409, body: { error: 'REQUEST_ALREADY_OPEN' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

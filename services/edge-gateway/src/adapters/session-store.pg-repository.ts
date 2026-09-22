// ══════════════════════════════════════════════════════════════════
// edge-gateway — Session store adapter (PostgreSQL, rls/0019)
//
// Implements the SessionRepository port using PostgreSQL. This is the adapter
// layer of hexagonal architecture: concrete implementation behind an abstract
// interface.
//
// SHARED AND DURABLE, not in-process. An in-memory map would mean every deploy
// logs out every officer mid-shift, a second replica cannot serve a session the
// first one issued, and "revoke" is a promise one process makes about itself.
// Officer JWTs are non-revocable (ADR-016), so this table IS the revocation
// mechanism for the platform's most privileged human sessions. It has to
// survive a restart.
//
// WHAT IS STORED AND WHAT IS NOT:
//
//   handle_hash        a KEYED hash (EDGE_SESSION_HMAC_KEY), never the handle.
//                      A leaked dump is therefore not a set of replayable
//                      sessions — the key lives in the process/HSM, not the row.
//   csrf_token_hash    same posture. The CSRF token is not a credential, but a
//                      stored plaintext would let a dump forge the half that
//                      double-submit relies on being unforgeable.
//   upstream_credential AES-256-GCM sealed (credential-cipher.adapter.ts).
//
// ROTATION WITH A GRACE WINDOW. Refresh mints a new handle and a new CSRF
// token; the previous pair stays valid for GRACE_MS. Without that, an SPA that
// refreshes while three fetches are in flight would 401/403 its own requests
// and the bug would be indistinguishable from a broken session store.
//
// Runs as usrp_edge_gateway — the ONLY role granted on this table, under FORCE'd
// RLS. No officer role and no system role can read live credentials, so a
// compromise of any other service does not yield officer sessions.
//
// Part of hexagonal architecture refactoring - adapter layer.
// ══════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { sql } from '@usrp/shared-database';
import { hmacSha256Hex } from '@usrp/shared-security';
import type { Agency } from '@usrp/shared-types';
import type {
  SessionRepository,
  CreateSessionInput,
  CreateSessionResult,
  SessionLookupResult,
  SessionStats,
} from '../ports/session-repository.js';
import type { EdgeSession, SessionKind } from '../domain/session.types.js';
import { csrfTokenHash, newCsrfToken } from '../security/csrf.js';

/** The CredentialCipher interface subset needed by this adapter. */
interface CredentialCipher {
  seal(plaintext: string): string;
  open(ciphertext: string): string;
}

/** The least-privilege role that alone may touch public_core.edge_sessions. */
const EDGE_DB_ROLE = 'usrp_edge_gateway';

/**
 * How long a rotated-away handle keeps working. 30s is generous for in-flight
 * SPA requests and short enough that a stolen pre-rotation handle is dead
 * almost immediately.
 */
const ROTATION_GRACE_MS = 30_000;

/**
 * Write-throttle on the sliding window. Touching the row on EVERY authenticated
 * request would make a read-heavy console generate one UPDATE per read; 60s
 * granularity on a 30-minute window is invisible to a user and removes the
 * write amplification.
 */
const TOUCH_INTERVAL_MS = 60_000;

interface SessionRow {
  readonly session_id: string;
  readonly kind: string;
  readonly subject_id: string | null;
  readonly agency: string | null;
  readonly roles: readonly string[] | null;
  readonly upstream_credential: string;
  readonly upstream_expires_at: Date | null;
  readonly csrf_token_hash: string;
  readonly previous_csrf_token_hash: string | null;
  readonly previous_valid_until: Date | null;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly last_seen_at: Date;
  readonly revoked_at: Date | null;
}

export interface SessionStoreConfig {
  readonly handleHmacKey: string;
  readonly idleTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
}

export class EdgeSessionStoreError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'EdgeSessionStoreError';
  }
}

/** A fresh opaque handle. base64url is always valid cookie-octets. */
function newHandle(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * PostgreSQL implementation of SessionRepository port.
 * Stores sessions in public_core.edge_sessions table.
 */
export class PgEdgeSessionStore implements SessionRepository {
  readonly #config: SessionStoreConfig;
  readonly #cipher: CredentialCipher;

  constructor(config: SessionStoreConfig, cipher: CredentialCipher) {
    this.#config = config;
    this.#cipher = cipher;
  }

  #handleHash(handle: string): string {
    return hmacSha256Hex(this.#config.handleHmacKey, `handle:${handle}`);
  }

  #idleDeadline(now: Date, absolute: Date): Date {
    const sliding = new Date(now.getTime() + this.#config.idleTtlSeconds * 1_000);
    // The idle window can never outlive the absolute ceiling. Clamping here is
    // what makes the ceiling a ceiling rather than a suggestion.
    return sliding.getTime() > absolute.getTime() ? absolute : sliding;
  }

  #toSession(row: SessionRow, credential: string, idleExpiresAt: Date): EdgeSession {
    const graceLive =
      row.previous_valid_until !== null && row.previous_valid_until.getTime() > Date.now();
    return {
      sessionId: row.session_id,
      kind: row.kind as SessionKind,
      subjectId: row.subject_id,
      agency: row.agency === null ? null : (row.agency as Agency),
      roles: row.roles ?? [],
      upstreamCredential: credential,
      upstreamExpiresAt: row.upstream_expires_at?.toISOString() ?? null,
      csrfTokenHash: row.csrf_token_hash,
      previousCsrfTokenHash: graceLive ? row.previous_csrf_token_hash : null,
      idleExpiresAt,
      absoluteExpiresAt: row.absolute_expires_at,
    };
  }

  async create(input: CreateSessionInput, now: Date = new Date()): Promise<CreateSessionResult> {
    if (input.kind === 'officer' && (input.agency === null || input.subjectId === null)) {
      throw new EdgeSessionStoreError('An officer session requires both an agency and a subject id.');
    }
    if (input.kind === 'applicant' && input.agency !== null) {
      // Not defensive noise: a citizen carrying an agency is the modelling error
      // ADR-021 §2.1 rejects, and it would silently narrow a cross-agency read.
      throw new EdgeSessionStoreError('An applicant session must not carry an agency.');
    }

    const handle = newHandle();
    const csrfToken = newCsrfToken();
    const absoluteExpiresAt = new Date(now.getTime() + this.#config.absoluteTtlSeconds * 1_000);
    const idleExpiresAt = this.#idleDeadline(now, absoluteExpiresAt);
    const sealed = this.#cipher.seal(input.upstreamCredential);

    try {
      const row = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        const rows = await tx<SessionRow[]>`
          INSERT INTO public_core.edge_sessions (
            handle_hash, csrf_token_hash, kind, subject_id, agency, roles,
            upstream_credential, upstream_expires_at,
            issued_at, idle_expires_at, absolute_expires_at, last_seen_at
          ) VALUES (
            ${this.#handleHash(handle)},
            ${csrfTokenHash(this.#config.handleHmacKey, csrfToken)},
            ${input.kind},
            ${input.subjectId},
            ${input.agency},
            ${[...input.roles]}::text[],
            ${sealed},
            ${input.upstreamExpiresAt},
            ${now},
            ${idleExpiresAt},
            ${absoluteExpiresAt},
            ${now}
          )
          RETURNING session_id, kind, subject_id, agency, roles, upstream_credential,
                    upstream_expires_at, csrf_token_hash, previous_csrf_token_hash,
                    previous_valid_until, idle_expires_at, absolute_expires_at,
                    last_seen_at, revoked_at
        `;
        const inserted = rows[0];
        if (inserted === undefined) {
          throw new EdgeSessionStoreError('Session insert returned no row.');
        }
        return inserted;
      });
      return {
        handle,
        csrfToken,
        session: this.#toSession(row, input.upstreamCredential, idleExpiresAt),
      };
    } catch (err) {
      if (err instanceof EdgeSessionStoreError) throw err;
      throw new EdgeSessionStoreError('Failed to create an edge session.', { cause: err });
    }
  }

  /**
   * Look up a session by handle. Returns ACTIVE if the session exists and has
   * not expired; ENDED if it exists but is expired or revoked; UNKNOWN if no
   * such handle.
   *
   * The expired row is read rather than filtered out on purpose: `idle` earns
   * "you were away too long", `absolute` earns "sessions end after 12 hours",
   * `revoked` earns "this session was ended". Telling a user the wrong one makes
   * the product look broken. An UNKNOWN handle is reported to the caller with
   * the same body as a revoked one — the distinction stays server-side.
   */
  async findByHandle(handle: string, now: Date = new Date()): Promise<SessionLookupResult> {
    const hash = this.#handleHash(handle);
    try {
      const row = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        const rows = await tx<SessionRow[]>`
          SELECT session_id, kind, subject_id, agency, roles, upstream_credential,
                 upstream_expires_at, csrf_token_hash, previous_csrf_token_hash,
                 previous_valid_until, idle_expires_at, absolute_expires_at,
                 last_seen_at, revoked_at
          FROM public_core.edge_sessions
          WHERE handle_hash = ${hash}
             OR (previous_handle_hash = ${hash}
                 AND previous_valid_until IS NOT NULL
                 AND previous_valid_until > ${now})
          LIMIT 1
        `;
        return rows[0] ?? null;
      });

      if (row === null) return { kind: 'UNKNOWN' };
      if (row.revoked_at !== null) return { kind: 'ENDED', reason: 'revoked' };
      // Absolute is checked FIRST: a session that has hit the hard ceiling is
      // over for that reason, even if it also happens to be idle.
      if (row.absolute_expires_at.getTime() <= now.getTime()) {
        return { kind: 'ENDED', reason: 'absolute' };
      }
      if (row.idle_expires_at.getTime() <= now.getTime()) {
        return { kind: 'ENDED', reason: 'idle' };
      }

      let credential: string;
      try {
        credential = this.#cipher.open(row.upstream_credential);
      } catch (err) {
        // A row that will not decrypt is unusable and suspicious (wrong key, or
        // tampering GCM caught). Fail as ENDED rather than 500: the browser's
        // correct next move is to log in again either way.
        console.error(
          JSON.stringify({ msg: 'edge_session_credential_undecryptable', sessionId: row.session_id }),
          err,
        );
        return { kind: 'ENDED', reason: 'revoked' };
      }

      const idleExpiresAt = await this.#touchIfStale(row, now);
      return { kind: 'ACTIVE', session: this.#toSession(row, credential, idleExpiresAt) };
    } catch (err) {
      throw new EdgeSessionStoreError('Failed to resolve an edge session.', { cause: err });
    }
  }

  /** Advance the sliding window, at most once per TOUCH_INTERVAL_MS. */
  async #touchIfStale(row: SessionRow, now: Date): Promise<Date> {
    if (now.getTime() - row.last_seen_at.getTime() < TOUCH_INTERVAL_MS) {
      return row.idle_expires_at;
    }
    const next = this.#idleDeadline(now, row.absolute_expires_at);
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
      await tx`
        UPDATE public_core.edge_sessions
        SET idle_expires_at = ${next}, last_seen_at = ${now}
        WHERE session_id = ${row.session_id} AND revoked_at IS NULL
      `;
    });
    return next;
  }

  /**
   * Advance the session's idle TTL (lastActivityAt and idleExpiresAt). Called
   * on every authenticated request to keep active sessions alive.
   *
   * Port interface method: touch(sessionId, now)
   */
  async touch(sessionId: string, now: Date = new Date()): Promise<void> {
    const next = new Date(now.getTime() + this.#config.idleTtlSeconds * 1_000);
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        await tx`
          UPDATE public_core.edge_sessions
          SET idle_expires_at = LEAST(${next}, absolute_expires_at),
              last_seen_at = ${now}
          WHERE session_id = ${sessionId} AND revoked_at IS NULL
        `;
      });
    } catch (err) {
      throw new EdgeSessionStoreError('Failed to touch edge session.', { cause: err });
    }
  }

  /**
   * Destroy a session. Idempotent — revoking an already-revoked or unknown
   * session is not an error, because a client retrying a logout must never be
   * told it failed.
   *
   * The sealed credential is BLANKED, not merely marked revoked. A revoked row
   * that still holds a decryptable officer JWT is a copy of a live,
   * non-revocable credential sitting in a table for the retention window.
   */
  async revoke(sessionId: string, reason: string, now: Date = new Date()): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        await tx`
          UPDATE public_core.edge_sessions
          SET revoked_at = ${now},
              revoked_reason = ${reason.slice(0, 32)},
              upstream_credential = '',
              previous_handle_hash = NULL,
              previous_csrf_token_hash = NULL,
              previous_valid_until = NULL
          WHERE session_id = ${sessionId} AND revoked_at IS NULL
        `;
      });
    } catch (err) {
      throw new EdgeSessionStoreError('Failed to revoke an edge session.', { cause: err });
    }
  }

  /**
   * Delete rows that are past every deadline. Session rows are personal data
   * (they tie an officer id to a time window), so they do not linger: the store
   * is a working set, not a log. The audit trail lives in audit-service.
   */
  async deleteExpired(olderThan: Date): Promise<number> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        const rows = await tx<{ readonly session_id: string }[]>`
          DELETE FROM public_core.edge_sessions
          WHERE absolute_expires_at < ${olderThan}
             OR (revoked_at IS NOT NULL AND revoked_at < ${olderThan})
          RETURNING session_id
        `;
        return rows.length;
      });
    } catch (err) {
      throw new EdgeSessionStoreError('Failed to sweep expired edge sessions.', { cause: err });
    }
  }

  /** Aggregate counts only — the store must be observable without being readable. */
  async stats(now: Date = new Date()): Promise<SessionStats> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_DB_ROLE)}`;
        const rows = await tx<
          {
            readonly active_officer: string;
            readonly active_applicant: string;
            readonly revoked: string;
            readonly expired: string;
          }[]
        >`
          SELECT
            COUNT(*) FILTER (WHERE revoked_at IS NULL AND kind = 'officer'
                             AND idle_expires_at > ${now} AND absolute_expires_at > ${now})
              AS active_officer,
            COUNT(*) FILTER (WHERE revoked_at IS NULL AND kind = 'applicant'
                             AND idle_expires_at > ${now} AND absolute_expires_at > ${now})
              AS active_applicant,
            COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked,
            COUNT(*) FILTER (WHERE revoked_at IS NULL
                             AND (idle_expires_at <= ${now} OR absolute_expires_at <= ${now}))
              AS expired
          FROM public_core.edge_sessions
        `;
        const row = rows[0];
        return {
          activeOfficer: Number(row?.active_officer ?? 0),
          activeApplicant: Number(row?.active_applicant ?? 0),
          revoked: Number(row?.revoked ?? 0),
          expired: Number(row?.expired ?? 0),
        };
      });
    } catch (err) {
      throw new EdgeSessionStoreError('Failed to read edge session stats.', { cause: err });
    }
  }
}

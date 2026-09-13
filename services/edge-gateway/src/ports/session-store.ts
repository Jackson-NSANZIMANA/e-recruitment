// ══════════════════════════════════════════════════════════════════
// edge-gateway — EdgeSessionStore port
//
// The store is addressed by the RAW handle; every implementation is
// responsible for never persisting it (a keyed hash is stored instead), so a
// leaked database dump is not a set of replayable sessions.
// ══════════════════════════════════════════════════════════════════

import type { EdgeSession, SessionEndedReason } from '../domain/session.js';

/** What a lookup found. `ENDED` carries the reason the UI needs to explain. */
export type SessionLookup =
  | { readonly kind: 'LIVE'; readonly session: EdgeSession }
  | { readonly kind: 'ENDED'; readonly reason: SessionEndedReason }
  | { readonly kind: 'NONE' };

export interface EdgeSessionStore {
  /** Persist a new session and return nothing — the caller minted the handle. */
  create(handle: string, session: EdgeSession): Promise<void>;
  /**
   * Resolve a handle AND slide its idle window in one statement (no
   * read-then-write race). Never slides the absolute ceiling.
   */
  touch(handle: string): Promise<SessionLookup>;
  /** Resolve without sliding — for reads that must not extend a session. */
  peek(handle: string): Promise<SessionLookup>;
  /** Destroy a session. Idempotent: destroying nothing is success. */
  destroy(handle: string): Promise<void>;
  /** Backs `GET /ready` — false when the store cannot serve. */
  healthy(): Promise<boolean>;
}

// ══════════════════════════════════════════════════════════════════
// identity-service — Retention repository port (ADR-019)
//
// Discovery + hygiene for the retention sweep. Two identity classes are
// DISCOVERED here but erased through the existing ErasureRepository (the
// terminal-only gate is re-checked inside that transaction — the sweep
// can never bypass it); the session/challenge purge is a plain hard
// delete of dead rows past their grace window.
// ══════════════════════════════════════════════════════════════════

export interface RetentionRepository {
  /** Identities with ZERO applications anywhere, created before `cutoff`,
   * not yet erased (retention class: never-applied, D7 12 months). */
  findNeverApplied(cutoff: Date): Promise<readonly string[]>;

  /** Identities whose EVERY application is negative-terminal (REJECTED /
   * WITHDRAWN / WALK_IN_REJECTED — never ACCEPTED) with no application
   * touched since `cutoff`, not yet erased (class: all-negative-terminal,
   * D7 24 months). */
  findNegativeTerminal(cutoff: Date): Promise<readonly string[]>;

  /** Count sessions dead (terminated or expired) since before `cutoff`. */
  countPurgeableSessions(cutoff: Date): Promise<number>;

  /** Count OTP challenges dead (consumed or expired) since before `cutoff`. */
  countPurgeableChallenges(cutoff: Date): Promise<number>;

  /** Hard-delete dead sessions past the grace window; returns rows removed. */
  purgeSessions(cutoff: Date): Promise<number>;

  /** Hard-delete dead OTP challenges past the grace window; returns rows removed. */
  purgeChallenges(cutoff: Date): Promise<number>;
}

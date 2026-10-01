// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — the transaction handle type
//
// The `tx` that `sql.begin(async (tx) => …)` hands its callback. Exported so a
// helper that must write INSIDE a caller's transaction (the outbox stager is
// the first) can say so in its signature, instead of every adapter inlining
// the same INSERT to dodge the type. Type-only: no runtime footprint.
// ══════════════════════════════════════════════════════════════════

import type postgres from 'postgres';

export type SqlTransaction = postgres.TransactionSql;

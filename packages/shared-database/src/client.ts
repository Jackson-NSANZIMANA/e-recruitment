// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — PostgreSQL Connection Client
// Uses postgres.js (not pg) — better performance, native async
//
// LAZY BY CONTRACT. Importing this module has NO side effects: it does not
// read configuration, does not throw, and does not open a socket.
//
// It used to do all three at module scope, and that was the single defect
// behind every `pnpm dev` failure in the nine DB-backed services. Because
// index.ts re-exports the row TYPES from here, `import type
// { RdfApplication } from '@usrp/shared-database'` was enough to construct a
// 20-connection pool. Worse, a missing DATABASE_URL threw during ESM
// evaluation — BEFORE any service's main() ran — so the whole config layer
// (@usrp/shared-config, which aggregates every missing variable into one
// readable EnvValidationError) was bypassed. Nine services reported a bare
// stack trace naming one variable; background-vetting and biometric, which
// reach loadEnv properly, reported every missing variable at once. Two
// failure idioms in one repo, and the worse one won because the import
// graph beats main().
//
// Now the pool is built on FIRST USE. Each service's config.ts already
// calls loadDatabaseConfig(), so that validation now runs first and the
// aggregated all-issues-at-once error is the normal failure mode.
//
// `db` and `sql` remain live bindings via a lazy proxy, so no call site
// changed. New code should prefer getDb() / getSql(); a composition root
// should call configureDatabase(config.database) to hand over the config it
// has ALREADY validated rather than letting this module re-read process.env.
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as publicCoreSchema from './schemas/public-core.schema.js';
import * as rdfOpsSchema from './schemas/rdf-ops.schema.js';
import * as rnpOpsSchema from './schemas/rnp-ops.schema.js';
import * as rcsOpsSchema from './schemas/rcs-ops.schema.js';
import * as auditLogSchema from './schemas/audit-log.schema.js';

const schema = {
  ...publicCoreSchema,
  ...rdfOpsSchema,
  ...rnpOpsSchema,
  ...rcsOpsSchema,
  ...auditLogSchema,
};

export type DatabaseSchema = typeof schema;
export type Database = PostgresJsDatabase<DatabaseSchema>;

/** The postgres.js client type, taken from the factory so it cannot drift. */
type SqlClient = ReturnType<typeof postgres>;

/**
 * The type postgres.js's `sql.json(value)` / `tx.json(value)` accepts.
 *
 * Use `sql.json(value)` (or `tx.json(value)` inside a transaction) for every
 * jsonb/json column write — never `JSON.stringify(value)` interpolated next
 * to a `::jsonb` cast. postgres.js already serializes the value you hand it;
 * pre-stringifying it yourself hands the driver a STRING, which it then
 * serializes AGAIN, so `col::jsonb` casts a JSON-encoded string literal
 * instead of a JSON document. The column ends up holding valid jsonb whose
 * entire root is a string — `jsonb_typeof(col)` reports `'string'`, not
 * `'object'`/`'array'`, and every reader downstream (this driver included)
 * correctly hands the caller back a string instead of the object they wrote.
 * That silent double-encoding was the root cause behind four separate CI
 * proof failures (audit metadata, age/academic eligibility detail, field-sync
 * vector clocks, forensics flags) — see git history on this file's siblings
 * for the incident. Application code passes its own domain types (`unknown`,
 * branded records, etc.); this alias is the one sanctioned cast between "the
 * domain knows this is JSON-safe" and "the driver requires proof of it" —
 * services should not redeclare their own.
 */
export type JsonbValue = postgres.JSONValue;

/** Assert a value is JSON-safe for `sql.json()`/`tx.json()`. See {@link JsonbValue}. */
export function asJsonb(value: unknown): JsonbValue {
  return value as JsonbValue;
}

export interface DatabaseClientOptions {
  /** Connection string. Normally `config.database.url`, already validated. */
  readonly url: string;
  /** Pool ceiling. Normally `config.database.maxConnections`. */
  readonly maxConnections?: number;
}

let configured: DatabaseClientOptions | undefined;
let pool: SqlClient | undefined;
let orm: Database | undefined;

/**
 * Supply the connection settings explicitly, from a composition root that has
 * already validated them through @usrp/shared-config. Optional — without it
 * the client falls back to reading the environment on first use, preserving
 * the historical behaviour for scripts and proofs.
 *
 * Must be called before the first database access; the pool is built once.
 */
export function configureDatabase(options: DatabaseClientOptions): void {
  if (pool !== undefined) {
    throw new Error(
      'configureDatabase() must be called before the first database access — the pool is already open.',
    );
  }
  configured = options;
}

function resolveUrl(): string {
  const url = configured?.url ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is required before the first database access. Services load it through ' +
        '@usrp/shared-config (loadDatabaseConfig), which reports every missing variable at once. ' +
        'For a local run: `pnpm generate:env` then `pnpm dev`.',
    );
  }
  return url;
}

function resolveMaxConnections(): number {
  if (configured?.maxConnections !== undefined) return configured.maxConnections;
  const raw = process.env['DATABASE_MAX_CONNECTIONS'];
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
}

/** The postgres.js pool, created on first call. */
export function getSql(): SqlClient {
  if (pool === undefined) {
    pool = postgres(resolveUrl(), {
      max: resolveMaxConnections(), // Maximum connections in pool
      idle_timeout: 20,             // Close idle connections after 20s
      connect_timeout: 10,          // Timeout connecting after 10s
      prepare: false,               // Required for transaction poolers (PgBouncer)
      onnotice: () => {},           // Suppress NOTICE messages in production
    });
  }
  return pool;
}

/** The drizzle instance, created on first call. */
export function getDb(): Database {
  if (orm === undefined) {
    orm = drizzle(getSql(), {
      schema,
      logger: process.env['NODE_ENV'] === 'development',
    });
  }
  return orm;
}

/**
 * Forward a property access to the real instance, binding methods so `this`
 * stays the underlying client (postgres.js and drizzle both rely on it).
 */
function forward(instance: object, prop: string | symbol): unknown {
  const value = (instance as Record<string | symbol, unknown>)[prop];
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(instance)
    : value;
}

// ── Back-compatible lazy bindings ─────────────────────────────────
// Deliberately proxies rather than a breaking API change: `sql` is used as a
// template tag (sql`SELECT 1`), as a function (sql('identifier')) and as an
// object (sql.begin / sql.array / sql.end) across the whole repo. A proxy
// over a callable target preserves every one of those shapes while moving
// construction to first use.

export const sql: SqlClient = new Proxy(function sqlPlaceholder(): void {} as unknown as SqlClient, {
  apply: (_target, _thisArg, args: unknown[]): unknown =>
    (getSql() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_target, prop: string | symbol): unknown => forward(getSql(), prop),
  has: (_target, prop: string | symbol): boolean => prop in (getSql() as object),
});

export const db: Database = new Proxy({} as Database, {
  get: (_target, prop: string | symbol): unknown => forward(getDb(), prop),
  has: (_target, prop: string | symbol): boolean => prop in (getDb() as object),
});

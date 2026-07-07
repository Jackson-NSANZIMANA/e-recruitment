// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — PostgreSQL Connection Client
// Uses postgres.js (not pg) — better performance, native async
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as publicCoreSchema from './schemas/public-core.schema.js';
import * as rdfOpsSchema from './schemas/rdf-ops.schema.js';
import * as rnpOpsSchema from './schemas/rnp-ops.schema.js';
import * as rcsOpsSchema from './schemas/rcs-ops.schema.js';
import * as auditLogSchema from './schemas/audit-log.schema.js';

const DATABASE_URL = process.env['DATABASE_URL'];

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Connection pool configuration
const sql = postgres(DATABASE_URL, {
  max: 20,                    // Maximum connections in pool
  idle_timeout: 20,           // Close idle connections after 20s
  connect_timeout: 10,        // Timeout connecting after 10s
  prepare: false,             // Required for transaction poolers (PgBouncer)
  onnotice: () => {},         // Suppress NOTICE messages in production
});

export const db = drizzle(sql, {
  schema: {
    ...publicCoreSchema,
    ...rdfOpsSchema,
    ...rnpOpsSchema,
    ...rcsOpsSchema,
    ...auditLogSchema,
  },
  logger: process.env['NODE_ENV'] === 'development',
});

export type Database = typeof db;

// Named exports for schema-specific access
export { sql };

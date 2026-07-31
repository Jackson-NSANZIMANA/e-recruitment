// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — Schema-drift detector (ADR-021 D13d successor)
//
// The engine-enforced replacement for the `drizzle-kit generate` MORATORIUM.
//
// USRP evolves its schema through hand-written `rls/` SQL (the system of
// record — it carries the grants, FORCE'd RLS policies, triggers and
// sequences that drizzle cannot express). The drizzle `.ts` schemas are the
// READABLE MIRROR of that truth, and `meta/0000_snapshot.json` is drizzle's
// belief about the post-bootstrap world.
//
// Three artefacts, and nothing used to hold them together: between rls/0005
// and rls/0018 the mirror silently drifted 27 statements across 7 migrations
// before a manual audit caught it. This proof makes that impossible to repeat
// by asserting BOTH edges of the triangle on every gate run:
//
//   A. .ts  ↔  snapshot   — `drizzle-kit generate` into a throwaway dir must
//      emit NOTHING. Catches a schema edit that never reached the snapshot.
//
//   B. snapshot  ↔  live DB — every table, column (name + type + NOT NULL),
//      enum (label AND order) and named idx_* index must match exactly, in
//      BOTH directions. Catches the real historical failure: a new rls/00NN
//      migration that nobody mirrored into the .ts schemas.
//
// Together they bind .ts ↔ snapshot ↔ live. Any of the three moving alone
// turns the gate red on the very next run, naming the object that drifted.
//
//   npx tsx packages/shared-database/selfcheck/verify-schema-drift.ts
// ══════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from '../src/index.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'src', 'migrations');
const SNAPSHOT_PATH = join(MIGRATIONS_DIR, 'meta', '0000_snapshot.json');
const SCHEMA_GLOB = join(PKG_ROOT, 'src', 'schemas', '*.schema.ts');
// Scratch stays INSIDE the repo on purpose: /tmp is aggressively cleaned on
// dev boxes and has eaten mid-run artefacts before.
const SCRATCH = join(PKG_ROOT, '.drift-check');
const DRIZZLE_KIT = join(PKG_ROOT, 'node_modules', '.bin', 'drizzle-kit');

const OPS_SCHEMAS = ['public_core', 'rdf_ops', 'rnp_ops', 'rcs_ops', 'audit_log'];

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Report at most `n` offending entries, so a red gate stays readable. */
function sample(items: string[], n = 8): string {
  const head = items.slice(0, n).join(', ');
  return items.length > n ? `${head} … (+${items.length - n} more)` : head;
}

console.log('schema drift — .ts ↔ snapshot ↔ live DB');

// ══════════════════════════════════════════════════════════════════
// A. .ts ↔ snapshot — generate must produce NOTHING
// ══════════════════════════════════════════════════════════════════
console.log('\n── A. drizzle .ts schemas vs committed snapshot ──');

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, 'out'), { recursive: true });
cpSync(join(MIGRATIONS_DIR, 'meta'), join(SCRATCH, 'out', 'meta'), { recursive: true });

// drizzle-kit resolves `out` relative to cwd, so the config lives in the
// scratch dir and we run from there. The real src/migrations is never a target.
writeFileSync(
  join(SCRATCH, 'drift.config.ts'),
  [
    `import { defineConfig } from 'drizzle-kit';`,
    `export default defineConfig({`,
    `  dialect: 'postgresql',`,
    `  schema: ${JSON.stringify(SCHEMA_GLOB)},`,
    `  out: 'out',`,
    `  migrations: { table: 'drizzle_migrations', schema: 'public' },`,
    `  strict: true,`,
    `});`,
    ``,
  ].join('\n'),
);

const before = new Set(readdirSync(join(SCRATCH, 'out')).filter((f) => f.endsWith('.sql')));
let generateOutput = '';
let generateFailed = false;
try {
  generateOutput = execFileSync(DRIZZLE_KIT, ['generate', '--config=drift.config.ts', '--name=drift_check'], {
    cwd: SCRATCH,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  generateFailed = true;
  generateOutput = String((err as { stdout?: string; message?: string }).stdout ?? (err as Error).message);
}

check('drizzle-kit generate ran', !generateFailed, generateOutput.slice(-400));

const emitted = readdirSync(join(SCRATCH, 'out')).filter((f) => f.endsWith('.sql') && !before.has(f));
check(
  'no catch-up migration is emitted (.ts and snapshot agree)',
  emitted.length === 0,
  emitted.length
    ? `snapshot is STALE by ${emitted.length} migration(s): ${emitted.join(', ')} — regenerate the snapshot ` +
      `or mirror the missing rls/ change into the .ts schemas`
    : '',
);

if (emitted.length > 0) {
  // Surface the actual drift so the failure is diagnosable from the gate log.
  for (const f of emitted) {
    console.error(`\n    ── drift in ${f} ──`);
    console.error(
      readFileSync(join(SCRATCH, 'out', f), 'utf8')
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
}

rmSync(SCRATCH, { recursive: true, force: true });

// ══════════════════════════════════════════════════════════════════
// B. snapshot ↔ live DB
// ══════════════════════════════════════════════════════════════════
console.log('\n── B. committed snapshot vs live database ──');

interface SnapshotColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
}
interface SnapshotTable {
  name: string;
  schema?: string;
  columns: Record<string, SnapshotColumn>;
  indexes?: Record<string, unknown>;
}
interface Snapshot {
  tables: Record<string, SnapshotTable>;
  enums: Record<string, { name: string; schema?: string; values: string[] }>;
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;

/**
 * Normalise a drizzle snapshot type to what Postgres' format_type() reports.
 * Enum types are compared unqualified (live reports them schema-qualified).
 */
function normaliseType(type: string): string {
  const t = type.replace(/"/g, '');
  if (t === 'varchar') return 'character varying';
  if (t.startsWith('varchar(')) return t.replace('varchar', 'character varying');
  if (t === 'serial') return 'integer';
  if (t === 'bigserial') return 'bigint';
  return t;
}

// ── Tables ────────────────────────────────────────────────────────
const snapTables = new Set(
  Object.values(snapshot.tables).map((t) => `${t.schema ?? 'public'}.${t.name}`),
);

// pg_class, NOT information_schema: the latter is privilege-filtered, so a
// table this connection lacks rights on would be silently invisible — and an
// unmirrored table is exactly what we are hunting. (Caught by negative test.)
const liveTableRows = await sql<{ schema: string; name: string }[]>`
  SELECT n.nspname AS schema, c.relname AS name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY(${OPS_SCHEMAS}) AND c.relkind = 'r'
`;
const liveTables = new Set(liveTableRows.map((r) => `${r.schema}.${r.name}`));

const tablesOnlyLive = [...liveTables].filter((t) => !snapTables.has(t)).sort();
const tablesOnlySnap = [...snapTables].filter((t) => !liveTables.has(t)).sort();

check(
  'every live table is mirrored in the drizzle schemas',
  tablesOnlyLive.length === 0,
  tablesOnlyLive.length ? `unmirrored (add to a .schema.ts): ${sample(tablesOnlyLive)}` : '',
);
check(
  'every mirrored table exists live',
  tablesOnlySnap.length === 0,
  tablesOnlySnap.length ? `declared but absent from the DB: ${sample(tablesOnlySnap)}` : '',
);
check('table count matches', liveTables.size === snapTables.size, `live ${liveTables.size} vs snapshot ${snapTables.size}`);

// ── Columns: name + type + NOT NULL ───────────────────────────────
const snapColumns = new Map<string, { type: string; notNull: boolean }>();
for (const t of Object.values(snapshot.tables)) {
  const schema = t.schema ?? 'public';
  for (const c of Object.values(t.columns)) {
    snapColumns.set(`${schema}.${t.name}.${c.name}`, {
      type: normaliseType(c.type),
      notNull: Boolean(c.notNull || c.primaryKey),
    });
  }
}

const liveColumnRows = await sql<{ key: string; type: string; notnull: boolean }[]>`
  SELECT n.nspname || '.' || c.relname || '.' || a.attname AS key,
         format_type(a.atttypid, a.atttypmod)              AS type,
         a.attnotnull                                      AS notnull
  FROM pg_attribute a
  JOIN pg_class c     ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY(${OPS_SCHEMAS})
    AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
`;

const qualifiedEnumPrefix = new RegExp(`^(${OPS_SCHEMAS.join('|')})\\.`);
const liveColumns = new Map<string, { type: string; notNull: boolean }>();
for (const r of liveColumnRows) {
  liveColumns.set(r.key, { type: r.type.replace(qualifiedEnumPrefix, ''), notNull: r.notnull });
}

const colsOnlyLive: string[] = [];
const colsMismatched: string[] = [];
for (const [key, live] of liveColumns) {
  const snap = snapColumns.get(key);
  if (!snap) {
    colsOnlyLive.push(key);
    continue;
  }
  if (snap.type !== live.type) colsMismatched.push(`${key} (live ${live.type} ≠ mirror ${snap.type})`);
  else if (snap.notNull !== live.notNull)
    colsMismatched.push(`${key} (NOT NULL live ${live.notNull} ≠ mirror ${snap.notNull})`);
}
const colsOnlySnap = [...snapColumns.keys()].filter((k) => !liveColumns.has(k)).sort();

check(
  'every live column is mirrored',
  colsOnlyLive.length === 0,
  colsOnlyLive.length ? `unmirrored: ${sample(colsOnlyLive.sort())}` : '',
);
check(
  'every mirrored column exists live',
  colsOnlySnap.length === 0,
  colsOnlySnap.length ? `declared but absent: ${sample(colsOnlySnap)}` : '',
);
check(
  'column types and nullability match exactly',
  colsMismatched.length === 0,
  colsMismatched.length ? sample(colsMismatched.sort()) : '',
);
console.log(`    (${liveColumns.size} live columns compared)`);

// ── Enums: labels AND order ───────────────────────────────────────
// Order matters: the lifecycle's monotonicity rests on enum rank, and
// rls/0011 inserted ADJUDICATION_REVIEW mid-sequence with ADD VALUE BEFORE.
const snapEnums = new Map<string, string>();
for (const e of Object.values(snapshot.enums)) {
  snapEnums.set(`${e.schema ?? 'public'}.${e.name}`, e.values.join(','));
}

const liveEnumRows = await sql<{ key: string; labels: string }[]>`
  SELECT n.nspname || '.' || t.typname                                   AS key,
         string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)           AS labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e      ON e.enumtypid = t.oid
  WHERE n.nspname = ANY(${OPS_SCHEMAS})
  GROUP BY n.nspname, t.typname
`;

const enumMismatched: string[] = [];
const enumsOnlyLive: string[] = [];
for (const r of liveEnumRows) {
  const snapLabels = snapEnums.get(r.key);
  if (snapLabels === undefined) enumsOnlyLive.push(r.key);
  else if (snapLabels !== r.labels) enumMismatched.push(`${r.key} (live [${r.labels}] ≠ mirror [${snapLabels}])`);
}
const liveEnumKeys = new Set(liveEnumRows.map((r) => r.key));
const enumsOnlySnap = [...snapEnums.keys()].filter((k) => !liveEnumKeys.has(k)).sort();

check('every live enum is mirrored', enumsOnlyLive.length === 0, sample(enumsOnlyLive.sort()));
check('every mirrored enum exists live', enumsOnlySnap.length === 0, sample(enumsOnlySnap));
check(
  'enum labels match in value AND order',
  enumMismatched.length === 0,
  enumMismatched.length ? sample(enumMismatched.sort(), 3) : '',
);
console.log(`    (${liveEnumRows.length} enums compared)`);

// ── Named indexes (idx_*) ─────────────────────────────────────────
// Implicit pkey/unique-constraint indexes are modelled by drizzle as
// constraints rather than indexes, so only the explicitly-named idx_* ones
// are comparable — which is exactly the set the rls/ files hand-create.
const snapIndexes = new Set<string>();
for (const t of Object.values(snapshot.tables)) {
  const schema = t.schema ?? 'public';
  for (const name of Object.keys(t.indexes ?? {})) snapIndexes.add(`${schema}.${name}`);
}

const liveIndexRows = await sql<{ key: string }[]>`
  SELECT schemaname || '.' || indexname AS key
  FROM pg_indexes
  WHERE schemaname = ANY(${OPS_SCHEMAS}) AND indexname LIKE 'idx\\_%'
`;
const liveIndexes = new Set(liveIndexRows.map((r) => r.key));

const idxOnlyLive = [...liveIndexes].filter((i) => !snapIndexes.has(i)).sort();
const idxOnlySnap = [...snapIndexes].filter((i) => !liveIndexes.has(i)).sort();

check('every live idx_* index is mirrored', idxOnlyLive.length === 0, sample(idxOnlyLive));
check('every mirrored index exists live', idxOnlySnap.length === 0, sample(idxOnlySnap));
console.log(`    (${liveIndexes.size} named indexes compared)`);

// ══════════════════════════════════════════════════════════════════
await sql.end({ timeout: 5 });

if (failures > 0) {
  console.error(`\n✗ schema drift detected — ${failures} check(s) failed`);
  console.error(
    '  The .ts schemas, meta/0000_snapshot.json and the live database have diverged.\n' +
      '  Mirror the change into the .schema.ts file, then refresh the snapshot\n' +
      '  (see docs/architecture/schema-evolution.md).',
  );
  process.exit(1);
}

console.log('\n✓ no schema drift — .ts, snapshot and live database agree');

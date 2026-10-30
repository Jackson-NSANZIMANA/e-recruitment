// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — Cross-agency column parity (evaluation D1/D12)
//
// THE DEFECT THIS EXISTS TO PREVENT, which shipped twice.
//
// Three agencies share ONE set of adapters: the same application repository,
// the same field-score store, the same document store. Each agency owns a
// schema whose tables are meant to be the same shape at that layer. When one
// schema gains a column the others lack, agency-agnostic SQL that names it is a
// `42703 undefined_column` — for two agencies and nobody else:
//
//   • D1  `sms_notification_status` existed only in rdf_ops. The invitation
//         projection wrote it in the transaction that advances an application,
//         so an RNP/RCS invitation was SENT, the transaction rolled back, the
//         row never left SLOT_ASSIGNED and the event was dead-lettered.
//   • D12 `is_walk_in` / `sync_conflict_resolution` existed only in rdf_ops and
//         were read by the agency-agnostic field-score store and the
//         physical-test projection.
//
// Both survived review for the same reason: EVERY proof that drives those paths
// is an RDF proof, and RDF is the pilot agency. A green gate proves the paths
// work for one third of the country.
//
// ── WHAT THIS PROOF ASSERTS ──
//
// A. THE LIVE DATABASE. For `applications`, `physical_test_scores` and
//    `document_records`, the column sets of rdf_ops / rnp_ops / rcs_ops must be
//    identical EXCEPT where a line in DIVERGENCES below declares the difference
//    and says why. Three consequences, all intended:
//      · an undeclared difference fails, naming the column and the schemas it
//        is missing from — the D1/D12 shape;
//      · a declaration that is no longer true also fails, so the list cannot rot
//        into a lie (fixing a divergence must delete its line);
//      · the two columns rls/0043 unified are pinned BY NAME, so re-narrowing
//        one of them to a single agency fails even if the allowlist is edited.
//
// B. THE CODE SURFACE. For every declared divergence, the service files that
//    mention the column are listed (`usage`). A NEW file mentioning it fails.
//    That is the tripwire D1 walked through: the schema difference was already
//    written down in `ports/application-read-repository.ts`, and the defect was
//    a second, agency-agnostic use appearing somewhere else. The list is not a
//    ban — it is the set of places where agency divergence is a live question,
//    so a diff that adds one has to answer it out loud.
//
//    When this fails, the two honest answers are:
//      · the use IS agency-specific → guard it on the agency, as
//        `PgFieldScoreStore.walkInFlag()` and the projection's `walkInFlag` do;
//      · the column is really platform-wide → move it to all three schemas
//        (the rls/0043 precedent) and delete its DIVERGENCES line instead.
//
// A NOTE ON COLUMN NAMES. `medical_fitness_status` exists on both
// `applications` (RDF board) and `physical_test_scores` (all three). Check B
// matches the identifier in the file, not the table it belongs to, so it can
// only ever be a conservative signal: it fails on a new FILE, never on a new
// statement inside a file already listed. That is deliberate — a proof that
// needs a SQL parser is a proof that will be wrong about SQL.
//
//   npx tsx packages/shared-database/selfcheck/verify-cross-agency-column-parity.ts
// ══════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from '../src/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVICES_DIR = join(REPO_ROOT, 'services');

const SCHEMAS = ['rdf_ops', 'rnp_ops', 'rcs_ops'] as const;
type OpsSchema = (typeof SCHEMAS)[number];
const TABLES = ['applications', 'physical_test_scores', 'document_records'] as const;
type OpsTable = (typeof TABLES)[number];

interface Divergence {
  readonly table: OpsTable;
  readonly column: string;
  /** The schemas that DO have it. One or two; three would not be a divergence. */
  readonly presentIn: readonly OpsSchema[];
  /** Why the difference is a design decision rather than an accident. */
  readonly why: string;
  /**
   * Service files that mention the column. A new one fails check B: the use
   * has to be shown to be agency-scoped, or the column has to become uniform.
   */
  readonly usage: readonly string[];
}

/**
 * THE DECLARED DIVERGENCES. Adding a line here is a design decision with a
 * reason; the proof will not let one exist silently.
 *
 * Sorted by table, then column. Empty `usage` means no service code touches the
 * column yet — if one starts to, this proof is where that gets noticed.
 */
const DIVERGENCES: readonly Divergence[] = [
  // ── applications ────────────────────────────────────────────────────
  {
    table: 'applications',
    column: 'applied_criminal_threshold',
    presentIn: ['rnp_ops'],
    why: 'RNP records WHICH sentence-length threshold produced a criminal verdict (CADET >6 months vs BASIC ≥6 months). RDF and RCS apply one rule each, so there is nothing to record. The projection appends the assignment only for RNP.',
    usage: [
      'services/application-service/src/adapters/application.pg-repository.ts',
      'services/application-service/src/ports/application-repository.ts',
    ],
  },
  {
    table: 'applications',
    column: 'declared_priority_field',
    presentIn: ['rnp_ops'],
    why: 'RNP applications ask for a declared specialist priority field; the other two agencies do not collect it. No service code writes or reads it yet.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'medical_cert_physician_name',
    presentIn: ['rnp_ops', 'rcs_ops'],
    why: 'RNP and RCS verify a government-physician CERTIFICATE and record who signed it (ADR-013). RDF runs an in-house medical board with its own columns instead.',
    usage: [
      'services/application-service/src/adapters/officer-transition.pg-repository.ts',
      'services/application-service/src/application/officer-transitions.service.ts',
    ],
  },
  {
    table: 'applications',
    column: 'medical_cert_verified',
    presentIn: ['rnp_ops', 'rcs_ops'],
    why: 'The CERTIFICATE-mode medical verdict (ADR-013). RDF is BOARD mode and has medical_reviewed_* / medical_fitness_status instead. The officer transition writes these columns only in CERTIFICATE mode, which is derived from the agency.',
    usage: [
      'services/application-service/src/adapters/officer-transition.pg-repository.ts',
      'services/application-service/src/ports/officer-transition-repository.ts',
    ],
  },
  {
    table: 'applications',
    column: 'medical_cert_verified_at',
    presentIn: ['rnp_ops', 'rcs_ops'],
    why: 'Timestamp of the CERTIFICATE-mode verdict; same ADR-013 split as medical_cert_verified.',
    usage: ['services/application-service/src/adapters/officer-transition.pg-repository.ts'],
  },
  {
    table: 'applications',
    column: 'declared_specialist_field',
    presentIn: ['rdf_ops', 'rcs_ops'],
    why: 'RDF and RCS categories include specialist streams that declare a field; RNP does not. The officer detail read emits `NULL::varchar` for RNP rather than naming the column.',
    usage: ['services/application-service/src/adapters/application-read.pg-repository.ts'],
  },
  {
    table: 'applications',
    column: 'is_walk_in',
    presentIn: ['rdf_ops'],
    why: "The walk-in lane is RDF's alone (ADR-012): WALK_IN_* statuses exist only in rdf_ops' enum. Shared reads must answer `false` for the other two schemas — see the walkInFlag helpers in application-service and field-sync-service.",
    usage: [
      'services/application-service/src/adapters/application-read.pg-repository.ts',
      'services/application-service/src/adapters/application.pg-repository.ts',
      'services/application-service/src/adapters/walk-in.pg-repository.ts',
      'services/application-service/src/ports/application-read-repository.ts',
      'services/application-service/src/ports/application-repository.ts',
      'services/application-service/src/ports/walk-in-repository.ts',
      'services/field-sync-service/src/adapters/field-score-store.pg.ts',
    ],
  },
  {
    table: 'applications',
    column: 'medical_fitness_status',
    presentIn: ['rdf_ops'],
    why: "RDF's in-house medical BOARD records a fitness verdict; RNP and RCS verify a document instead (ADR-013). The officer transition writes it only in BOARD mode.",
    usage: [
      'services/application-service/src/adapters/officer-transition.pg-repository.ts',
      'services/application-service/src/ports/officer-transition-repository.ts',
      // physical_test_scores carries the same column name for every agency; this
      // file writes THAT one. Listed so the proof stays a change-detector rather
      // than a false alarm — see the header note on column names.
      'services/field-sync-service/src/adapters/field-score-store.pg.ts',
    ],
  },
  {
    table: 'applications',
    column: 'medical_reviewed_at',
    presentIn: ['rdf_ops'],
    why: 'BOARD-mode review stamp; ADR-013 split, as medical_fitness_status.',
    usage: ['services/application-service/src/adapters/officer-transition.pg-repository.ts'],
  },
  {
    table: 'applications',
    column: 'medical_reviewed_by_id',
    presentIn: ['rdf_ops'],
    why: 'BOARD-mode reviewer identity; ADR-013 split. The IAM comment references it only to explain what it does not do.',
    usage: [
      'services/application-service/src/adapters/officer-transition.pg-repository.ts',
      'services/application-service/src/ports/officer-transition-repository.ts',
      'services/iam-service/src/application/officer-login.service.ts',
    ],
  },
  {
    table: 'applications',
    column: 'registration_dpu_district',
    presentIn: ['rnp_ops'],
    why: 'RNP registers candidates at the DPU of their district of residence; RDF and RCS use the venue assignment instead. No service code reads it yet.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'document_review_notes',
    presentIn: ['rdf_ops'],
    why: 'RDF officers record free-text notes on a document decision. Deliberately NOT read by the officer detail (it is not in the shared column intersection) — a per-agency read would be needed before exposing it for RNP/RCS.',
    usage: ['services/application-service/src/ports/application-read-repository.ts'],
  },
  {
    table: 'applications',
    column: 'birth_cert_verified',
    presentIn: ['rcs_ops'],
    why: 'RCS requires a birth certificate for its officer categories and tracks verification separately. RDF and RNP do not model it.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'birth_cert_verified_at',
    presentIn: ['rcs_ops'],
    why: 'RCS birth-certificate verification stamp; same RCS-only requirement.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'celibacy_cert_verified',
    presentIn: ['rcs_ops'],
    why: 'RCS requires a celibacy certificate for its categories. Neither other agency does.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'celibacy_cert_verified_at',
    presentIn: ['rcs_ops'],
    why: 'RCS celibacy-certificate verification stamp.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'nesa_science_percentage',
    presentIn: ['rcs_ops'],
    why: 'RCS junior/officer categories are screened on a NESA science percentage; RDF and RNP use the level/division rules alone.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'prosecution_check_performed',
    presentIn: ['rcs_ops'],
    why: 'Only RCS asks RIB for a separate prosecution check (FLAGGED_PROSECUTION exists only in its criminal_clearance_status enum).',
    usage: [],
  },
  {
    table: 'applications',
    column: 'prosecution_check_at',
    presentIn: ['rcs_ops'],
    why: 'Timestamp of the RCS-only prosecution check.',
    usage: [],
  },
  {
    table: 'applications',
    column: 'ur_program_applied',
    presentIn: ['rcs_ops'],
    why: "The University of Rwanda programme choice is an RCS officer-category field. No service code reads it yet — the category is carried instead.",
    usage: [],
  },
  // ── document_records ────────────────────────────────────────────────
  {
    table: 'document_records',
    column: 'is_notarized',
    presentIn: ['rcs_ops'],
    why: 'RCS requires notarised degree/diploma copies; RDF and RNP accept plain copies. No service code writes it yet — the requirement is advisory in the checklist model (ADR-032).',
    usage: [],
  },
  {
    table: 'document_records',
    column: 'notarization_reference',
    presentIn: ['rcs_ops'],
    why: 'The notary reference for an RCS notarised copy; RCS-only requirement, as is_notarized.',
    usage: [],
  },
  // ── physical_test_scores ────────────────────────────────────────────
  // Intentionally EMPTY. This table is the purest platform-wide surface: the
  // CRDT log and its adjudication are identical for all three agencies, which
  // is why rls/0043 moved sync_conflict_resolution to every schema rather than
  // guarding it. A line appearing here means someone decided a score field is
  // agency-specific — that decision needs an ADR, not just an allowlist entry.
];

/** The columns rls/0043 unified. Pinned by name: narrowing one fails here. */
const PLATFORM_WIDE: readonly { table: OpsTable; column: string }[] = [
  { table: 'applications', column: 'sms_notification_status' },
  { table: 'physical_test_scores', column: 'sync_conflict_resolution' },
];

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const IDENTIFIER_OCCURRENCE = (column: string): RegExp =>
  new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

/** Every .ts under a service's src/, excluding its own proofs and unit tests. */
function serviceSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test' || entry.name === 'selfcheck') continue;
      serviceSources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log('cross-agency column parity — the code that names agency-only columns, then the live schemas');

  // ── B first ─────────────────────────────────────────────────────────
  // The tripwire is pure file scanning, so it runs before the database: a
  // developer without Postgres still gets the answer that matters most — "is a
  // shared, agency-agnostic adapter naming a column only one agency has?".
  checkCodeSurface();

  await checkLiveSchemas();

  console.log(`\nCROSS-AGENCY PARITY: ${String(pass)} passed, ${String(fail)} failed`);
  if (fail > 0) process.exitCode = 1;
}

function checkCodeSurface(): void {
  // ── B. the code surface ─────────────────────────────────────────────
  console.log('\n── B. declared divergences and the code that names them ──');

  const sources = serviceSources(SERVICES_DIR).map((path) => ({
    relative: path.slice(REPO_ROOT.length + 1),
    text: readFileSync(path, 'utf8'),
  }));

  for (const declared of DIVERGENCES) {
    const pattern = IDENTIFIER_OCCURRENCE(declared.column);
    const mentionedBy = sources.filter((source) => pattern.test(source.text)).map((source) => source.relative);
    const undeclared = mentionedBy.filter((file) => !declared.usage.includes(file));
    check(
      `${declared.table}.${declared.column} is named only where its divergence is documented`,
      undeclared.length === 0,
      undeclared.length === 0
        ? ''
        : `new use in ${undeclared.join(', ')}. This column exists in ${declared.presentIn.join(' + ')} only, so ` +
          'agency-agnostic SQL naming it is a 42703 for the other agencies — guard the use on the agency ' +
          '(see PgFieldScoreStore.walkInFlag) or add the file to DIVERGENCES with the reason it is safe',
    );
  }

}

async function checkLiveSchemas(): Promise<void> {
  console.log('\n── A. rdf_ops / rnp_ops / rcs_ops column sets ──');

  const rows = await sql<{ schema: string; table: string; column: string }[]>`
    SELECT n.nspname AS schema, c.relname AS "table", a.attname AS "column"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${[...SCHEMAS]})
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `;

  const live = new Map<string, Set<string>>();
  for (const schema of SCHEMAS) {
    for (const table of TABLES) live.set(`${schema}.${table}`, new Set());
  }
  for (const row of rows) {
    live.get(`${row.schema}.${row.table}`)?.add(row.column);
  }
  for (const table of TABLES) {
    const missing = SCHEMAS.filter((schema) => (live.get(`${schema}.${table}`)?.size ?? 0) === 0);
    check(`${table} exists in all three schemas`, missing.length === 0, `absent from: ${missing.join(', ')}`);
  }

  for (const table of TABLES) {
    const sets = SCHEMAS.map((schema) => live.get(`${schema}.${table}`) ?? new Set<string>());
    const allColumns = new Set<string>(sets.flatMap((set) => [...set]));
    for (const column of [...allColumns].sort()) {
      const presentIn = SCHEMAS.filter((_, index) => sets[index]?.has(column) === true);
      const declared = DIVERGENCES.find((d) => d.table === table && d.column === column);

      if (presentIn.length === SCHEMAS.length) {
        if (declared !== undefined) {
          check(
            `${table}.${column} is no longer divergent — delete its DIVERGENCES line`,
            false,
            `present in all three schemas; the allowlist entry ("${declared.why.slice(0, 40)}…") is now a lie`,
          );
        }
        continue;
      }

      if (declared === undefined) {
        const absentFrom = SCHEMAS.filter((schema) => !presentIn.includes(schema));
        check(
          `${table}.${column} is either uniform or declared`,
          false,
          `present in ${presentIn.join(' + ')} only, absent from ${absentFrom.join(', ')} — ` +
            'if it is platform-wide, move it to every schema (rls/0043 is the precedent); ' +
            'if it is a genuine agency difference, declare it in DIVERGENCES with a reason',
        );
        continue;
      }

      check(
        `${table}.${column} — declared ${declared.presentIn.join(' + ')}`,
        declared.presentIn.length === presentIn.length && declared.presentIn.every((s) => presentIn.includes(s)),
        `live: ${presentIn.join(' + ')}`,
      );
    }
  }

  // A declaration naming a column that no longer exists at all.
  for (const declared of DIVERGENCES) {
    const exists = SCHEMAS.some((schema) => live.get(`${schema}.${declared.table}`)?.has(declared.column) === true);
    check(
      `DIVERGENCES entry ${declared.table}.${declared.column} still exists`,
      exists,
      'column is gone from every schema — delete the entry',
    );
  }

  // The D1/D12 repair, pinned by name.
  for (const pinned of PLATFORM_WIDE) {
    const absentFrom = SCHEMAS.filter((schema) => live.get(`${schema}.${pinned.table}`)?.has(pinned.column) !== true);
    check(
      `${pinned.table}.${pinned.column} exists in all three schemas (rls/0043)`,
      absentFrom.length === 0,
      `absent from: ${absentFrom.join(', ')} — a shared, agency-agnostic adapter writes or reads this column, ` +
        'so an agency without it is a 42703 that only that agency sees',
    );
  }

}

main()
  .catch((error: unknown) => {
    console.error('CROSS-AGENCY PARITY PROOF FAILED:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void sql.end({ timeout: 5 });
  });

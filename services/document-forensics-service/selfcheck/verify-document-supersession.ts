// ══════════════════════════════════════════════════════════════════
// document-forensics-service — DOCUMENT SUPERSESSION PROOF (D8, zero infrastructure)
//
// THE DEFECT (evaluation 2026-10-29, D8). A second upload of the same document
// type silently became an UPDATE: same documentId, no revision, no digest, and
// `human_reviewed_*` untouched. So a citizen could upload a certificate, have an
// officer review it CLEAR, then replace the bytes — the row kept the approval
// stamp while the file behind it changed. Evidence tampering with the platform's
// own stamp on it, and "which bytes did the officer approve?" was unanswerable.
//
// WHAT THIS PROVES, in the order the defect hides:
//
//   1. THE DECISION IS TOTAL AND EXHAUSTIVE. Every combination of
//      (case status × review stamp × digest × slot exists) is decided by one
//      pure function, so the SQL adapter has no branch of its own to drift.
//   2. A REFUSAL TOUCHES NOTHING. The refusal paths return before the object
//      write is ever invoked, which is what makes 409 real rather than cosmetic:
//      the reviewed bytes are still at rest.
//   3. A RETRY IS NOT A REVISION. Identical bytes keep the revision count, so a
//      flaky network cannot make a reviewer read "replaced three times".
//   4. THE CASE ADVANCEMENT RULE USES THE CANONICAL ORDER, not a hand-written
//      status list (that is how the two disagree the first time a status lands).
//   5. THE WIRE SAYS `revision` AND NOTHING MORE — no lane, no score, no flags
//      (a verdict handed to the uploader is a forgery-tuning oracle), and the
//      refusal is the shared `DOCUMENT_REVIEW_CLOSED` code at 409.
//
// §1–§4 are pure and exhaustive. §5 reads the shipped source for the two things
// a fake cannot show: that the object write happens INSIDE the transaction and
// AFTER the gate, and that the wire is shaped as described. The live SQL apply
// is the owner's (`pnpm verify`); nothing here claims to have run a database.
// ══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_STATUSES } from '@usrp/shared-types';
import {
  LAST_REPLACEABLE_STATUS,
  decideSupersession,
  isRefusal,
  type SlotState,
} from '../src/domain/supersession.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const SRC = join(HERE, '..', 'src');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}
function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

const HMAC_A = 'a'.repeat(64);
const HMAC_B = 'b'.repeat(64);

const slot = (over: Partial<SlotState> = {}): SlotState => ({
  caseStatus: 'DOCUMENT_REVIEW_GREEN',
  humanReviewed: false,
  storedHmac: HMAC_A,
  exists: true,
  ...over,
});

// ── 1. The decision is total and exhaustive ────────────────────────
section('1. One pure function decides every case');
check(
  'the lock begins at DOCUMENT_REVIEW_AMBER and no further',
  LAST_REPLACEABLE_STATUS === 'DOCUMENT_REVIEW_AMBER',
);
check('first upload into an empty slot → CREATE, revision 1', decideSupersession(slot({ exists: false, storedHmac: null }), HMAC_A, 1).kind === 'CREATE');
check(
  'different bytes, unreviewed, case in review → SUPERSEDE at n+1',
  JSON.stringify(decideSupersession(slot(), HMAC_B, 3)) === JSON.stringify({ kind: 'SUPERSEDE', revision: 4 }),
);
check(
  'the same bytes again → RETRY, same revision (a retry is not a revision)',
  JSON.stringify(decideSupersession(slot(), HMAC_A, 3)) === JSON.stringify({ kind: 'RETRY', revision: 3 }),
);
check(
  'a human stamp refuses even when the case is still in review',
  decideSupersession(slot({ humanReviewed: true }), HMAC_B, 2).kind === 'CLOSED_HUMAN_REVIEW',
);
check(
  'the human stamp OUTRANKS case advancement (the stronger fact first)',
  decideSupersession(slot({ humanReviewed: true, caseStatus: 'ACCEPTED' }), HMAC_B, 2).kind === 'CLOSED_HUMAN_REVIEW',
);
check(
  'an advanced case refuses a NEW slot too (no adding documents to a decided case)',
  decideSupersession(slot({ exists: false, storedHmac: null, caseStatus: 'SLOT_ASSIGNED' }), HMAC_A, 1).kind ===
    'CLOSED_CASE_ADVANCED',
);
check(
  'a refusal is reported as a refusal, never as a revision',
  isRefusal(decideSupersession(slot({ humanReviewed: true }), HMAC_B, 1)) &&
    !isRefusal(decideSupersession(slot(), HMAC_B, 1)) &&
    !isRefusal(decideSupersession(slot(), HMAC_A, 1)) &&
    !isRefusal(decideSupersession(slot({ exists: false }), HMAC_A, 1)),
);

// Exhaustive sweep: no input combination is undecided, and no refusal writes.
let combos = 0;
let undecided = 0;
for (const caseStatus of APPLICATION_STATUSES) {
  for (const humanReviewed of [false, true]) {
    for (const exists of [false, true]) {
      for (const storedHmac of [null, HMAC_A]) {
        for (const incoming of [HMAC_A, HMAC_B]) {
          combos += 1;
          const d = decideSupersession({ caseStatus, humanReviewed, storedHmac, exists }, incoming, 7);
          const known = ['CREATE', 'SUPERSEDE', 'RETRY', 'CLOSED_HUMAN_REVIEW', 'CLOSED_CASE_ADVANCED'];
          if (!known.includes(d.kind)) undecided += 1;
          // A refusal never carries a revision, and an accepted decision does.
          if (isRefusal(d)) {
            if ('revision' in d) undecided += 1;
          } else if (d.kind === 'SUPERSEDE' && d.revision !== 8) {
            undecided += 1;
          }
        }
      }
    }
  }
}
check(
  `every combination is decided with a coherent shape (${String(combos)} combinations)`,
  undecided === 0,
  `${String(undecided)} incoherent`,
);

// ── 2. A refusal touches nothing ───────────────────────────────────
section('2. A refusal cannot destroy the reviewed bytes');
const store = readFileSync(join(SRC, 'adapters/document-record.pg-store.ts'), 'utf8');
const refusalsBeforeWrite =
  store.indexOf("return { kind: 'REVIEW_CLOSED', reason: 'HUMAN_REVIEWED' }") < store.indexOf('await input.writeObject()') &&
  store.indexOf("return { kind: 'REVIEW_CLOSED', reason: 'CASE_ADVANCED' }") < store.indexOf('await input.writeObject()');
check(
  'both refusal paths return BEFORE the object write (the bytes survive)',
  refusalsBeforeWrite,
);
check(
  'the adapter has no status/review branch of its own — it executes the pure decision',
  /const decision = decideSupersession\(/.test(store) &&
    !/indexOf\('DOCUMENT_REVIEW_AMBER'\)/.test(store),
);
check(
  'the gate and the revision bump share ONE transaction (FOR UPDATE on the slot)',
  /FOR UPDATE/.test(store) && /sql\.begin/.test(store),
);
const upload = readFileSync(join(SRC, 'application/upload-document.service.ts'), 'utf8');
check(
  'the use case no longer writes the object itself — only through the store callback',
  upload.slice(0, upload.indexOf('writeObject: async () =>')).includes('putObject') === false &&
    /writeObject: async \(\) => \{\s*await this\.#deps\.objectWriter\.putObject/.test(upload),
);
check(
  'a REVIEW_CLOSED upload is an audited refusal naming no internals',
  /DOCUMENT_REUPLOAD_REFUSED/.test(upload),
);

// ── 3. The digest is keyed, and it stays home ──────────────────────
section('3. The digest is keyed and never leaves the service');
check(
  'the content digest is an HMAC, not a bare hash',
  /hmacSha256Hex\(this\.#deps\.contentHmacKey/.test(upload),
);
check(
  'the HMAC key is required configuration (a store of national IDs must not boot without it)',
  /FORENSICS_CONTENT_HMAC_KEY: string\(\{ minLength: 32, secret: true \}\)/.test(
    readFileSync(join(SRC, 'config.ts'), 'utf8'),
  ),
);
const controller = readFileSync(join(SRC, 'adapters/http/upload-document.controller.ts'), 'utf8');
check(
  'the citizen response carries revision and NOT the lane/score/flags',
  /revision: outcome\.revision/.test(controller) &&
    !/lane: outcome\.verdict/.test(controller) &&
    !/forensicsScore:/.test(controller),
);
check(
  'the digest never enters the response or an audit event',
  !/contentHmac/.test(controller),
);
const auditBlock = upload.slice(upload.indexOf('DOCUMENT_UPLOADED'));
check(
  'the audit trail carries the revision and the supersession flag, not the digest',
  /revision: recorded\.revision/.test(auditBlock) &&
    /superseded: recorded\.superseded/.test(auditBlock) &&
    !/contentHmac/.test(auditBlock),
);

// ── 4. The trail exists, in all three schemas ──────────────────────
section('4. The revision trail is append-only, in every agency schema');
const migration = readFileSync(join(REPO, 'packages/shared-database/src/rls/0046_document_revisions.sql'), 'utf8');
check(
  'rls/0046 covers all three ops schemas in one migration (no D1-class divergence)',
  /ARRAY\['rdf_ops', 'rnp_ops', 'rcs_ops'\]/.test(migration),
);
check(
  'document_records gains revision and a KEYED digest column',
  /ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1/.test(migration) &&
    /content_hmac varchar\(64\)/.test(migration),
);
check(
  'document_revisions is unique per (document, revision) — no skipped or duplicated number',
  /UNIQUE \(document_id, revision\)/.test(migration),
);
check(
  'append-only is enforced by grant AND trigger (owner and superuser included)',
  /REVOKE UPDATE, DELETE, TRUNCATE ON %I\.document_revisions/.test(migration) &&
    /BEFORE UPDATE ON %I\.document_revisions/.test(migration) &&
    /BEFORE DELETE ON %I\.document_revisions/.test(migration),
);
check(
  'the bootstrap applies it (a migration nobody runs closes nothing)',
  /0046_document_revisions\.sql/.test(readFileSync(join(REPO, 'scripts/bootstrap-db.sh'), 'utf8')),
);
const schemas = ['rdf', 'rnp', 'rcs'].map((s) =>
  readFileSync(join(REPO, `packages/shared-database/src/schemas/${s}-ops.schema.ts`), 'utf8'),
);
check(
  'the drizzle model carries the same two columns in all three schemas',
  schemas.every((s) => /contentHmac: varchar\('content_hmac'/.test(s) && /revision: integer\('revision'\)/.test(s)),
);

// ── 5. The wire ────────────────────────────────────────────────────
section('5. The refusal is a shared code at the status the table declares');
const door = readFileSync(join(REPO, 'packages/shared-types/src/document-door.types.ts'), 'utf8');
check(
  'DOCUMENT_REVIEW_CLOSED is 409 in the one vocabulary (D7’s table)',
  /DOCUMENT_REVIEW_CLOSED: \{ status: 409/.test(door),
);
check(
  'the upload controller answers it from the table, with a closed reason',
  /case 'REVIEW_CLOSED':[\s\S]{0,400}doorResult\('DOCUMENT_REVIEW_CLOSED', \{ reason: outcome\.reason \}\)/.test(controller),
);
check(
  'analyze/ refuses to re-verdict a reviewed slot too (no second door into the same stamp)',
  /case 'REVIEW_CLOSED':[\s\S]{0,200}409/.test(
    readFileSync(join(SRC, 'adapters/http/analyze-document.controller.ts'), 'utf8'),
  ),
);

// ── Verdict ────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\u001b[0;32m' : '\u001b[0;31m'}${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
if (fail > 0) {
  console.error(`\nDOCUMENT SUPERSESSION FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\u001b[0;32mDOCUMENT SUPERSESSION OK\u001b[0m');

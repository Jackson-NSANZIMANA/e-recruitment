#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
// check-workspace-build.mjs — is the workspace BUILT, and built from THIS source?
//
// WHY THIS EXISTS. Each @usrp/* package's `exports` map resolves TYPES to
// ./src/index.ts and RUNTIME to ./dist/index.js. Two consequences:
//
//   • `pnpm typecheck` can be green while every proof fails at runtime —
//     the compiler never looks at dist.
//   • dist/ is gitignored, so it is developer-local state. Switch branch or
//     pull, and you keep a build from ANOTHER commit. The symptom is a
//     SyntaxError inside whichever proof first imports a symbol that was added
//     since that build:
//       "The requested module '@usrp/shared-database' does not provide an
//        export named 'stageOutboxEvents'"
//     That is not a code defect and not an environment defect; it is a stale
//     artefact, and it is invisible until a proof happens to need the symbol.
//
// WHAT IT ASSERTS (semantically, never by mtime — turbo correctly leaves
// unchanged outputs untouched on a cache hit, so timestamps lie):
//   for each workspace package/service that ships a src/index.ts, every VALUE
//   name that index explicitly re-exports must exist in the imported dist
//   module namespace. `export * from '...'` cannot be enumerated statically and
//   is skipped — the explicit lists are what regress in practice.
//
// Exit 0 = build present and in agreement with src. Exit 1 = stale/missing,
// with the fix. Wired into scripts/run-selfchecks.sh, so the gate refuses to
// run 40 proofs against an artefact that cannot represent the source.
// ══════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOTS = ['packages', 'services'];
const problems = [];
let checked = 0;

/**
 * Value names explicitly re-exported by an index file (`type X` entries excluded).
 *
 * Both spellings occur in this repo — `export { type A, b } from './x.js'` (inline)
 * and `export type { A } from './x.js'` (clause-level) — so both are skipped for
 * their type-only entries.
 */
function declaredValueExports(src) {
  const names = new Set();
  // export { a, b as c, type T } from './x.js'   AND   export { a, b };
  // `export type { ... }` (clause-level) is matched too and filtered below.
  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s*['"][^'"]+['"])?/g)) {
    const clauseIsTypeOnly = m[1] !== undefined;
    for (const raw of m[2].split(',')) {
      const entry = raw.trim();
      if (entry === '') continue;
      if (clauseIsTypeOnly || /^type\s+/.test(entry)) continue; // erased at runtime
      const parts = entry.split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // export const/function/class NAME  (types/interfaces are erased at runtime)
  for (const m of src.matchAll(
    /^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Names visible in the emitted DECLARATIONS (dist/index.d.ts).
 *
 * A name that src declares, that the runtime namespace lacks, but that the .d.ts
 * carries is a TYPE (erased on purpose) — not staleness. A stale artifact lacks
 * the name in BOTH .js and .d.ts, which is the case this check exists to catch.
 * (Without this distinction the check false-positives on every `type` re-export:
 * AUTH_NS is a value, AuthTokenClaims is a type, and neither is missing.)
 */
function namesInDeclarations(dts) {
  const names = new Set();
  for (const m of dts.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const entry = raw.trim().replace(/^type\s+/, '');
      if (entry === '') continue;
      const parts = entry.split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of dts.matchAll(
    /^declare\s+(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of dts.matchAll(/^export\s+(?:declare\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  return names;
}

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    const pkgPath = join(dir, 'package.json');
    const srcIndex = join(dir, 'src', 'index.ts');
    if (!existsSync(pkgPath) || !existsSync(srcIndex)) continue;

    const distIndex = join(dir, 'dist', 'index.js');
    if (!existsSync(distIndex)) {
      problems.push(`${dir} — never built (no dist/index.js)`);
      continue;
    }

    const declared = declaredValueExports(readFileSync(srcIndex, 'utf8'));
    if (declared.size === 0) continue;

    let mod;
    try {
      mod = await import(pathToFileURL(distIndex).href);
    } catch (error) {
      problems.push(`${dir} — dist/index.js failed to import: ${error.message}`);
      continue;
    }

    checked += 1;
    const dtsIndex = join(dir, 'dist', 'index.d.ts');
    const inDts = existsSync(dtsIndex) ? namesInDeclarations(readFileSync(dtsIndex, 'utf8')) : new Set();
    // Missing at runtime AND absent from the declarations file ⇒ genuinely not
    // built. Missing only at runtime ⇒ a type, which is supposed to be absent.
    const missing = [...declared].filter((name) => !(name in mod) && !inDts.has(name));
    if (missing.length > 0) {
      problems.push(`${dir} — dist is STALE; missing ${missing.length} export(s): ${missing.join(', ')}`);
    }
  }
}

if (problems.length > 0) {
  console.error('\u001b[1;31m✗ workspace build is missing or stale — proofs would fail on a module import, not on the invariant they prove.\u001b[0m');
  for (const p of problems) console.error(`    ${p}`);
  console.error('  Fix: \u001b[0;36mpnpm build\u001b[0m   (or: pnpm turbo run build --force; a cache hit usually makes this seconds)');
  process.exit(1);
}

console.log(`\u001b[0;32m✓ workspace build present — ${checked} package(s) export exactly what src/index.ts declares\u001b[0m`);

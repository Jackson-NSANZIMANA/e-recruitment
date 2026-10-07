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
//
// A missing dist/index.js has TWO causes and they need different commands, so
// they are reported separately: the tree was never installed (`pnpm install`;
// the build then dies with `tsc: not found` before writing anything — the
// normal state right after a pull that adds a package), or it was installed but
// never built (`pnpm build`). Reporting the second when the first is true sends
// the reader to a command that cannot succeed.
// ══════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOTS = ['packages', 'services'];
const problems = [];
const importFailures = [];
const notInstalled = [];
let checked = 0;

/**
 * Does this workspace package have a dependency tree in THIS checkout?
 *
 * A branch that adds a package (or a package that only exists after a pull)
 * lands src/ and package.json immediately, but node_modules/ is created by
 * `pnpm install` alone. `turbo run build` then tries to run the build tool from
 * `node_modules/.bin` and dies with `sh: 1: tsc: not found` / `spawn ENOENT`
 * BEFORE dist/ is ever written — which the missing-dist branch below would
 * otherwise report as "never built", sending the reader to `pnpm build`, which
 * cannot succeed. The two defects need different commands, so they are named
 * differently.
 *
 * Signal: every package in this workspace declares at least one dependency, so
 * an absent node_modules/ directory is unambiguous. A package that legitimately
 * declares none is never reported.
 */
function hasDependencyTree(dir, pkg) {
  let declared;
  try {
    declared = JSON.parse(readFileSync(pkg, 'utf8'));
  } catch {
    return true; // unreadable package.json is not this check's business
  }
  const deps = [
    ...Object.keys(declared.dependencies ?? {}),
    ...Object.keys(declared.devDependencies ?? {}),
    ...Object.keys(declared.peerDependencies ?? {}),
  ];
  if (deps.length === 0) return true;
  return existsSync(join(dir, 'node_modules'));
}

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

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    const pkgPath = join(dir, 'package.json');
    const srcIndex = join(dir, 'src', 'index.ts');
    if (!existsSync(pkgPath) || !existsSync(srcIndex)) continue;

    const distIndex = join(dir, 'dist', 'index.js');
    if (!existsSync(distIndex)) {
      if (!hasDependencyTree(dir, pkgPath)) {
        notInstalled.push(dir);
        problems.push(
          `${dir} — dependencies NOT INSTALLED (no node_modules; 'pnpm build' fails here with 'tsc: not found')`,
        );
      } else {
        problems.push(`${dir} — never built (no dist/index.js)`);
      }
      continue;
    }

    const declared = declaredValueExports(readFileSync(srcIndex, 'utf8'));
    if (declared.size === 0) continue;

    let mod;
    try {
      mod = await import(pathToFileURL(distIndex).href);
    } catch (error) {
      // A consequence, not a cause: this dist exists and was importable until
      // something it depends on lost its dist/. Printed after the root causes
      // so one missing build does not bury its own diagnosis in a cascade.
      importFailures.push(`${dir} — dist/index.js failed to import: ${error.message}`);
      continue;
    }

    checked += 1;
    // Strict: every name src declares as a VALUE must exist in the runtime
    // namespace. Types are excluded at the source (see declaredValueExports),
    // which is the only place the distinction is trustworthy — the emitted
    // .d.ts keeps the same markers, but a .d.ts entry surviving while the value
    // is missing from .js is itself an inconsistency worth failing on.
    const missing = [...declared].filter((name) => !(name in mod));
    if (missing.length > 0) {
      problems.push(`${dir} — dist is STALE; missing ${missing.length} export(s): ${missing.join(', ')}`);
    }
  }
}

if (problems.length + importFailures.length > 0) {
  console.error('\u001b[1;31m✗ workspace build is missing or stale — proofs would fail on a module import, not on the invariant they prove.\u001b[0m');
  for (const p of [...problems, ...importFailures]) console.error(`    ${p}`);
  if (notInstalled.length > 0) {
    console.error(
      `  Fix: \u001b[0;36mpnpm install\u001b[0m   (${notInstalled.length} package(s) above have no dependency tree in this checkout — a branch that adds a package needs an install before it can build)`,
    );
  }
  console.error('  Fix: \u001b[0;36mpnpm build\u001b[0m   (or: pnpm turbo run build --force; a cache hit usually makes this seconds)');
  process.exit(1);
}

console.log(`\u001b[0;32m✓ workspace build present — ${checked} package(s) export exactly what src/index.ts declares\u001b[0m`);

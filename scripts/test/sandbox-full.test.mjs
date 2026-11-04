// Proof for infrastructure/sandbox/full.sh's frontend phase: the sandbox runs the FRONTEND's own build and
// preview, and never a second build of its own.
//
// The real full.sh runs inside a throwaway repository with every outside command stubbed on PATH (docker,
// pnpm, curl, ss, free) and the backend steps replaced, so the test needs no Docker, no ports and no
// frontend checkout. The pnpm stub records each call (directory, arguments, the VITE_* environment) and
// plays the part of the frontend: `run build` writes the app's dist/index.html, `run preview` becomes a
// sleeping process whose port the curl stub then reports as 200.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FULL = join(ROOT, 'infrastructure/sandbox/full.sh');
const APPS = { 'applicant-portal': 4930, 'officer-console': 4931, 'field-station': 4932 };

const STUBS = {
  pnpm: `#!/usr/bin/env bash
printf '%s|%s|EDGE=%s|SANDBOX=%s|FIELD=%s|ANCHOR=%s\\n' "$PWD" "$*" "\${VITE_EDGE_URL:-}" "\${VITE_USRP_SANDBOX:-}" \\
  "\${VITE_FIELD_STATION_URL:-}" "\${VITE_SLOT_TRUST_ANCHOR_B64:-}" >> "$STUB_LOG"
if [ "$PWD" = "$STUB_UI" ] && [ "$1" = install ] && [ -n "\${STUB_FAIL_UI_INSTALL:-}" ]; then echo "ERR_PNPM_OUTDATED_LOCKFILE"; exit 1; fi
if [ "$PWD" = "$STUB_UI" ] && [ "$1 $2" = "run build" ]; then
  pkg="\${3#--filter=}"; pkg="\${pkg%...}"; app="\${pkg#@usrp/}"
  [ "$app" = "\${STUB_FAIL_BUILD:-}" ] && { echo "error TS2322: probe"; exit 2; }
  mkdir -p "apps/$app/dist" && echo "<!doctype html>" > "apps/$app/dist/index.html"
  echo "Cached:    0 cached, 1 total"; exit 0
fi
if [ "$1 $2" = "run preview" ]; then touch "$STUB_STATE/up-$4"; exec sleep 300; fi
exit 0
`,
  curl: `#!/usr/bin/env bash
url="\${*: -1}"; port="\${url#http://localhost:}"; port="\${port%%/*}"
[ -f "$STUB_STATE/up-$port" ] && printf 200 || printf 000
`,
  ss: `#!/usr/bin/env bash
port="\${*: -1}"; port="\${port##*:}"
case " \${STUB_BUSY:-} " in *" $port "*) echo "LISTEN 0 511 127.0.0.1:$port 0.0.0.0:*" ;; esac
`,
  docker: '#!/usr/bin/env bash\nexit 0\n',
  free: '#!/usr/bin/env bash\necho "               total used free shared buff/cache available"\necho "Mem: 16000 1000 14000 0 1000 8000"\n',
};

function fixture(t, { scripts = { build: 'tsc -p tsconfig.json --noEmit && vite build', preview: 'vite preview' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'usrp-sandbox-full-'));
  const repo = join(root, 'e-recruitment');
  const ui = join(root, 'ui');
  const bin = join(root, 'bin');
  const state = join(root, 'stub-state');
  for (const d of [join(repo, 'infrastructure/sandbox'), join(repo, 'scripts'), join(repo, '.sandbox'), bin, state]) mkdirSync(d, { recursive: true });
  copyFileSync(FULL, join(repo, 'infrastructure/sandbox/full.sh'));
  writeFileSync(join(repo, 'infrastructure/sandbox/up.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(repo, 'scripts/check-workspace-build.mjs'), 'process.exit(0);\n');
  writeFileSync(join(repo, '.sandbox/secrets.json'), JSON.stringify({ QR_INVITATION_PUBLIC_KEY_B64: 'cHVibGljLWtleQ==' }));
  mkdirSync(ui, { recursive: true });
  for (const f of ['package.json', 'pnpm-lock.yaml', 'turbo.json']) writeFileSync(join(ui, f), '{}\n');
  for (const app of Object.keys(APPS)) {
    mkdirSync(join(ui, 'apps', app), { recursive: true });
    writeFileSync(join(ui, 'apps', app, 'package.json'), JSON.stringify({ name: `@usrp/${app}`, scripts }));
  }
  for (const [name, body] of Object.entries(STUBS)) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const fx = { root, repo, ui, bin, state, log };
  t.after(() => { stopPreviews(fx); rmSync(root, { recursive: true, force: true }); });
  return fx;
}

function stopPreviews(fx) {
  for (const app of Object.keys(APPS)) {
    const file = join(fx.repo, '.sandbox/pids', `web-${app}`);
    if (!existsSync(file)) continue;
    try { process.kill(-Number(readFileSync(file, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
  }
}

function run(fx, args = [], env = {}) {
  const result = spawnSync('bash', [join(fx.repo, 'infrastructure/sandbox/full.sh'), ...args], {
    cwd: fx.repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      USRP_UI_DIR: fx.ui,
      STUB_UI: fx.ui,
      STUB_LOG: fx.log,
      STUB_STATE: fx.state,
      SANDBOX_EXPOSE_LAN: '',
      ...env,
    },
  });
  assert.equal(result.error, undefined);
  return { status: result.status, out: result.stdout + result.stderr, calls: readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean) };
}

const uiCalls = (fx, calls, prefix) => calls.filter((c) => c.startsWith(`${fx.ui}${prefix}`));

test('full.sh holds no frontend build of its own', () => {
  const code = readFileSync(FULL, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /vite (build|preview)/, 'vite is invoked only through the apps\' own scripts');
  assert.doesNotMatch(code, /--outDir|--emptyOutDir/, 'the build output directory belongs to the frontend');
  assert.doesNotMatch(code, /\.sandbox\/web|\$WEB\b|\.usrp-build/, 'no backend-owned bundle directory or build stamp');
});

test('each app is built by the frontend workspace build, filtered to the app and its dependencies, for its own origin', (t) => {
  const fx = fixture(t);
  const { status, out, calls } = run(fx);
  assert.equal(status, 0, out);
  const builds = uiCalls(fx, calls, '|run build');
  assert.equal(builds.length, 3, calls.join('\n'));
  for (const [app, port] of Object.entries(APPS)) {
    const call = builds.find((c) => c.includes(`--filter=@usrp/${app}...`));
    assert.ok(call, `no build for ${app}`);
    assert.match(call, /\|run build --filter=@usrp\/[a-z-]+\.\.\. --ui=stream --no-daemon\|/, 'no --force without --rebuild');
    assert.ok(call.includes(`|EDGE=http://localhost:${port}|`), `${app} is built for its own origin, not the edge: ${call}`);
    assert.ok(call.includes('|SANDBOX=1|FIELD=http://localhost:4932|ANCHOR=cHVibGljLWtleQ=='), call);
    assert.ok(existsSync(join(fx.ui, 'apps', app, 'dist/index.html')));
  }
  assert.equal(existsSync(join(fx.repo, '.sandbox/web')), false, 'no bundle directory in the backend');
  assert.ok(uiCalls(fx, calls, '|install --frozen-lockfile').length === 1, 'the frontend install runs from the frontend root');
});

test('each app is served by its own preview script with the real edge as the proxy target', (t) => {
  const fx = fixture(t);
  const { status, out, calls } = run(fx);
  assert.equal(status, 0, out);
  for (const [app, port] of Object.entries(APPS)) {
    const call = calls.find((c) => c.startsWith(`${join(fx.ui, 'apps', app)}|run preview`));
    assert.ok(call, `no preview for ${app}: ${calls.join('\n')}`);
    assert.ok(call.includes(`|run preview --port ${port} --strictPort|EDGE=http://localhost:4921|SANDBOX=|`), call);
    assert.ok(existsSync(join(fx.repo, '.sandbox/pids', `web-${app}`)), `the ${app} server is recorded`);
  }
});

test('a second start rebuilds through turbo and reuses the servers it started', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  const pids = Object.keys(APPS).map((app) => readFileSync(join(fx.repo, '.sandbox/pids', `web-${app}`), 'utf8'));
  writeFileSync(fx.log, '');
  const { status, out, calls } = run(fx);
  assert.equal(status, 0, out);
  assert.equal(uiCalls(fx, calls, '|run build').length, 3, 'turbo decides what is cached, not an HTTP 200');
  assert.equal(calls.filter((c) => c.includes('|run preview')).length, 0);
  assert.deepEqual(Object.keys(APPS).map((app) => readFileSync(join(fx.repo, '.sandbox/pids', `web-${app}`), 'utf8')), pids);
});

test('--rebuild forces the frontend build through turbo --force', (t) => {
  const fx = fixture(t);
  const { status, out, calls } = run(fx, ['--rebuild']);
  assert.equal(status, 0, out);
  const builds = uiCalls(fx, calls, '|run build');
  assert.equal(builds.length, 3);
  for (const call of builds) assert.match(call, / --ui=stream --no-daemon --force\|/);
});

test('--down stops the previews this script started', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  const pid = Number(readFileSync(join(fx.repo, '.sandbox/pids/web-officer-console'), 'utf8'));
  const { status, out } = run(fx, ['--down']);
  assert.equal(status, 0, out);
  assert.equal(existsSync(join(fx.repo, '.sandbox/pids/web-officer-console')), false);
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); spawnSync('sleep', ['0.1']); } catch { alive = false; } }
  assert.equal(alive, false, 'the recorded preview is stopped');
});

test('a port held by a server this script did not start is refused, not taken over', (t) => {
  const fx = fixture(t);
  const { status, out, calls } = run(fx, [], { STUB_BUSY: '4931' });
  assert.equal(status, 1);
  assert.match(out, /:4931 is busy with a server this script did not start; stop it first/);
  assert.equal(existsSync(join(fx.repo, '.sandbox/pids/web-officer-console')), false);
  assert.equal(calls.filter((c) => c.includes('|run preview --port 4931')).length, 0);
});

test('a missing or wrong frontend checkout fails before anything starts, with the fix', (t) => {
  const fx = fixture(t);
  let r = run(fx, [], { USRP_UI_DIR: join(fx.root, 'nowhere') });
  assert.equal(r.status, 1);
  assert.match(r.out, /USRP_UI_DIR=.*nowhere does not exist/);
  assert.equal(r.calls.length, 0, 'nothing ran');
  rmSync(join(fx.ui, 'turbo.json'));
  r = run(fx);
  assert.equal(r.status, 1);
  assert.match(r.out, /has no turbo\.json: it is not the frontend workspace; set USRP_UI_DIR/);
});

test('an app without its native preview script is named, not worked around', (t) => {
  const fx = fixture(t, { scripts: { build: 'tsc -p tsconfig.json --noEmit && vite build' } });
  const { status, out, calls } = run(fx);
  assert.equal(status, 1);
  assert.match(out, /cannot build applicant-portal: @usrp\/applicant-portal has no preview script/);
  assert.equal(calls.length, 0);
});

test('a failed frontend install or build stops the boot and points at its log', (t) => {
  const fx = fixture(t);
  let r = run(fx, [], { STUB_FAIL_UI_INSTALL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.out, /the frontend install \(pnpm install --frozen-lockfile in .*\) failed; see .*full-ui-install\.out/);
  writeFileSync(fx.log, '');
  r = run(fx, [], { STUB_FAIL_BUILD: 'officer-console' });
  assert.equal(r.status, 1);
  assert.match(r.out, /error TS2322: probe/, 'the build output is shown, not suppressed');
  assert.match(r.out, /the officer-console build failed; see .*full-build-officer-console\.out/);
  assert.equal(r.calls.filter((c) => c.includes('|run preview --port 4931')).length, 0, 'a failed build is not served');
});

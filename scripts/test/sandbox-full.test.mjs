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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FULL = join(ROOT, 'infrastructure/sandbox/full.sh');
const APPS = { 'applicant-portal': 4930, 'officer-console': 4931, 'field-station': 4932 };

const STUBS = {
  pnpm: `#!/usr/bin/env bash
tag=""; [[ " $* " == *" --dry=json "* ]] && tag="DRY"
printf '%s%s|%s|EDGE=%s|SANDBOX=%s|FIELD=%s|ANCHOR=%s\\n' "$tag" "$PWD" "$*" "\${VITE_EDGE_URL:-}" "\${VITE_USRP_SANDBOX:-}" \\
  "\${VITE_FIELD_STATION_URL:-}" "\${VITE_SLOT_TRUST_ANCHOR_B64:-}" >> "$STUB_LOG"
if [ "$PWD" = "$STUB_UI" ] && [ "$1" = install ] && [ -n "\${STUB_FAIL_UI_INSTALL:-}" ]; then echo "ERR_PNPM_OUTDATED_LOCKFILE"; exit 1; fi
[ "$1" = -s ] && shift
if [ "$PWD" = "$STUB_UI" ] && [ "$1 $2" = "run build" ]; then
  pkg="\${3#--filter=}"; pkg="\${pkg%...}"; app="\${pkg#@usrp/}"
  # The task hash: a per-app value the test can change (a source change), else one derived from the origin.
  hash="$(cat "$STUB_STATE/hash-$app" 2>/dev/null || printf 'h-%s' "\${VITE_EDGE_URL//[^a-z0-9]/}")"
  if [[ " $* " == *" --dry=json "* ]]; then
    printf '{"tasks":[{"taskId":"%s#build","hash":"%s"}]}' "$pkg" "$hash"; exit 0
  fi
  [ "$app" = "\${STUB_FAIL_BUILD:-}" ] && { echo "error TS2322: probe"; exit 2; }
  mkdir -p "apps/$app/dist" && echo "<!doctype html><!-- $hash -->" > "apps/$app/dist/index.html"
  echo "Cached:    0 cached, 1 total"; exit 0
fi
if [ "$1 $2" = "run preview" ]; then echo $$ > "$STUB_STATE/up-$4"; exec sleep 300; fi
exit 0
`,
  curl: `#!/usr/bin/env bash
url="\${*: -1}"
case "$url" in
  https://*) [[ " $* " == *" --cacert "* ]] && [ -f "$STUB_STATE/tls-up" ] && printf 200 || printf 000 ;;
  *) port="\${url#http://localhost:}"; port="\${port%%/*}"
     if [ -f "$STUB_STATE/up-$port" ] && kill -0 "$(cat "$STUB_STATE/up-$port")" 2>/dev/null; then printf 200
     elif [ -f "$STUB_STATE/foreign-$port" ]; then printf 200; else printf 000; fi ;;
esac
`,
  // A port is listened on by the stub preview while its recorded process lives (ss -p names that pid), or
  // by a "foreign" server the test declares (STUB_BUSY, or a foreign-<port> file), whose pid is 1.
  ss: `#!/usr/bin/env bash
port="\${*: -1}"; port="\${port##*:}"
if [ -f "$STUB_STATE/up-$port" ] && kill -0 "$(cat "$STUB_STATE/up-$port")" 2>/dev/null; then
  echo "LISTEN 0 511 127.0.0.1:$port 0.0.0.0:* users:((\"node\",pid=$(cat "$STUB_STATE/up-$port"),fd=3))"
fi
case " \${STUB_BUSY:-} " in *" $port "*) echo "LISTEN 0 511 127.0.0.1:$port 0.0.0.0:* users:((\"python3\",pid=1,fd=3))" ;; esac
[ -f "$STUB_STATE/foreign-$port" ] && echo "LISTEN 0 511 127.0.0.1:$port 0.0.0.0:* users:((\"python3\",pid=1,fd=3))"
exit 0
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
  // The real certificate script; a stand-in HTTPS front that records how it was started.
  copyFileSync(join(ROOT, 'infrastructure/sandbox/lan-certs.sh'), join(repo, 'infrastructure/sandbox/lan-certs.sh'));
  writeFileSync(
    join(repo, 'infrastructure/sandbox/tls-proxy.mjs'),
    `import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.STUB_LOG, 'TLS|' + process.argv.slice(2).join(' ') + '\\n');
writeFileSync(process.env.STUB_STATE + '/tls-up', '');
console.log('tls-proxy ready');
setInterval(() => {}, 1000);
`,
  );
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
  for (const app of [...Object.keys(APPS), 'tls']) {
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
      SANDBOX_LAN_ADDRESS: '',
      SANDBOX_CA_DIR: join(fx.root, 'ca'),
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

const pidOf = (fx, app) => readFileSync(join(fx.repo, '.sandbox/pids', `web-${app}`), 'utf8').trim();
const dryCalls = (fx, calls) => calls.filter((c) => c.startsWith(`DRY${fx.ui}|`));

test('a second start asks turbo for each hash and keeps a preview that serves exactly that build', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  const pids = Object.keys(APPS).map((app) => pidOf(fx, app));
  writeFileSync(fx.log, '');
  const { status, out, calls } = run(fx);
  assert.equal(status, 0, out);
  assert.equal(dryCalls(fx, calls).length, 6, 'turbo plans every app, and the closing status asks it again');
  assert.equal(uiCalls(fx, calls, '|run build').length, 0, 'nothing to build: same hash, same dist/index.html');
  assert.equal(calls.filter((c) => c.includes('|run preview')).length, 0);
  assert.deepEqual(Object.keys(APPS).map((app) => pidOf(fx, app)), pids);
  for (const app of Object.keys(APPS)) assert.match(out, new RegExp(`${app}: serving build h-httplo, current`));
});

test('a source change rebuilds only that app, with its preview stopped first and started again', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  const before = Object.fromEntries(Object.keys(APPS).map((app) => [app, pidOf(fx, app)]));
  writeFileSync(join(fx.state, 'hash-officer-console'), 'changed-source-hash');
  writeFileSync(fx.log, '');
  const { status, out, calls } = run(fx);
  assert.equal(status, 0, out);
  const builds = uiCalls(fx, calls, '|run build');
  assert.equal(builds.length, 1, calls.join('\n'));
  assert.ok(builds[0].includes('--filter=@usrp/officer-console...'));
  assert.notEqual(pidOf(fx, 'officer-console'), before['officer-console'], 'a new preview for the new build');
  assert.equal(gone(Number(before['officer-console'])), true, 'the old preview was stopped');
  assert.equal(pidOf(fx, 'applicant-portal'), before['applicant-portal']);
  assert.match(readFileSync(join(fx.repo, '.sandbox/pids/web-officer-console.build'), 'utf8'), /^hash=changed-source-hash$/m);
});

test('a dist/ rewritten outside the sandbox (a developer build) is rebuilt, not served as ours', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  writeFileSync(join(fx.ui, 'apps/field-station/dist/index.html'), '<!doctype html><!-- someone else -->');
  assert.match(run(fx, ['--status']).out, /field-station :4932 +⚠ dist\/ changed outside the sandbox/);
  writeFileSync(fx.log, '');
  const { status, calls } = run(fx);
  assert.equal(status, 0);
  assert.equal(uiCalls(fx, calls, '|run build').filter((c) => c.includes('field-station')).length, 1);
  assert.match(run(fx, ['--status']).out, /field-station :4932 +✓ serving build h-httplo, current/);
});

test('--status says when the sources have moved on from what is served', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  writeFileSync(join(fx.state, 'hash-applicant-portal'), 'newer-source');
  const { out } = run(fx, ['--status']);
  assert.match(out, /applicant-portal :4930 +⚠ serving build h-httplo; the sources now build newer-so/);
  assert.match(out, /officer-console :4931 +✓ serving build h-httplo/);
});

test('a server answering on the port is not ours just because a PID file exists', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  process.kill(-Number(pidOf(fx, 'officer-console')), 'SIGKILL');
  gone(Number(pidOf(fx, 'officer-console')));
  writeFileSync(join(fx.state, 'foreign-4931'), '');
  assert.match(run(fx, ['--status']).out, /officer-console :4931 +⚠ answering, but not a server this sandbox started/);
  const { status, out } = run(fx);
  assert.equal(status, 1);
  assert.match(out, /:4931 is busy with a server this script did not start/);
});

test('--rebuild forces the frontend build through turbo --force', (t) => {
  const fx = fixture(t);
  const { status, out, calls } = run(fx, ['--rebuild']);
  assert.equal(status, 0, out);
  const builds = uiCalls(fx, calls, '|run build');
  assert.equal(builds.length, 3);
  for (const call of builds) assert.match(call, / --ui=stream --no-daemon --force\|/);
  const pids = Object.keys(APPS).map((app) => pidOf(fx, app));
  const again = run(fx, ['--rebuild']);
  assert.equal(again.status, 0, again.out);
  assert.equal(uiCalls(fx, again.calls, '|run build').length, 6, '--rebuild builds even when nothing changed');
  for (const [i, app] of Object.keys(APPS).entries()) assert.notEqual(pidOf(fx, app), pids[i], `${app} restarted`);
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
  assert.match(r.out, /the officer-console build failed; it is not served\. See .*full-build-officer-console\.out/);
  assert.match(r.out, /not every app is served: the officer-console build failed/);
  assert.equal(r.calls.filter((c) => c.includes('|run preview --port 4931')).length, 0, 'a failed build is not served');
  assert.equal(r.calls.filter((c) => c.includes('|run preview --port 4930')).length, 1, 'the other apps still come up');
  assert.match(run(fx, ['--status']).out, /officer-console :4931 +✗ not serving: the last build failed/);
});

test('a failed rebuild stops the old preview instead of passing the previous bundle off as current', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx).status, 0);
  const old = Number(pidOf(fx, 'field-station'));
  writeFileSync(join(fx.state, 'hash-field-station'), 'broken-source');
  const r = run(fx, [], { STUB_FAIL_BUILD: 'field-station' });
  assert.equal(r.status, 1);
  assert.equal(gone(old), true, 'the preview of the previous build is stopped');
  assert.equal(existsSync(join(fx.repo, '.sandbox/pids/web-field-station')), false);
  assert.match(run(fx, ['--status']).out, /field-station :4932 +✗ not serving: the last build failed/);
  assert.equal(run(fx).status, 0, 'the next good build serves again');
  assert.match(run(fx, ['--status']).out, /field-station :4932 +✓ serving build broken-s/);
});

// ── --lan: the three apps over HTTPS on the network ─────────────────
const LAN_IP = '192.168.50.10';

test('--lan builds each app for its https LAN origin and keeps the previews and the edge on loopback', (t) => {
  const fx = fixture(t);
  const { status, out, calls } = run(fx, ['--lan'], { SANDBOX_LAN_ADDRESS: LAN_IP });
  assert.equal(status, 0, out);
  for (const [app, port] of Object.entries(APPS)) {
    const build = uiCalls(fx, calls, '|run build').find((c) => c.includes(`--filter=@usrp/${app}...`));
    assert.ok(build.includes(`|EDGE=https://${LAN_IP}:${port}|SANDBOX=1|FIELD=https://${LAN_IP}:4932|`), build);
    const preview = calls.find((c) => c.startsWith(`${join(fx.ui, 'apps', app)}|run preview`));
    assert.ok(preview.includes(`|run preview --port ${port} --strictPort|EDGE=http://localhost:4921|`), 'the preview is unchanged');
  }
  const tls = calls.find((c) => c.startsWith('TLS|'));
  assert.ok(tls, 'the HTTPS front is started');
  for (const port of Object.values(APPS)) assert.ok(tls.includes(` ${LAN_IP}:${port}=${port}`), tls);
  assert.match(tls, /--cert \S+\/\.sandbox\/tls\/server\.crt --key \S+\/\.sandbox\/tls\/server\.key --ca \S+\/ca\/ca\.crt/);
  assert.ok(existsSync(join(fx.repo, '.sandbox/pids/web-tls')));
  assert.equal(statSync(join(fx.root, 'ca/ca.key')).mode & 0o077, 0, 'the CA key is private to its owner');
  assert.match(out, new RegExp(`applicant portal +https://${LAN_IP.replaceAll('.', '\\.')}:4930`));
  assert.match(out, /SHA-256 fingerprint +([0-9A-F]{2}:){31}[0-9A-F]{2}/);
  assert.match(out, new RegExp(`http://${LAN_IP.replaceAll('.', '\\.')}:4930/usrp-sandbox-ca\\.crt`));
});

test('--lan is SANDBOX_EXPOSE_LAN=1, and the launcher never receives it (the edge stays loopback)', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.repo, 'infrastructure/sandbox/up.sh'), '#!/usr/bin/env bash\necho "UP|SANDBOX_EXPOSE_LAN=${SANDBOX_EXPOSE_LAN:-}" >> "$STUB_LOG"\n');
  const { status, out, calls } = run(fx, [], { SANDBOX_EXPOSE_LAN: '1', SANDBOX_LAN_ADDRESS: LAN_IP });
  assert.equal(status, 0, out);
  assert.ok(calls.includes('UP|SANDBOX_EXPOSE_LAN='), calls.join('\n'));
  assert.ok(calls.some((c) => c.startsWith('TLS|')));
});

test('--lan refuses real SMS, a public address, and leaves nothing started', (t) => {
  const fx = fixture(t);
  let r = run(fx, ['--lan', '--real-sms'], { SANDBOX_LAN_ADDRESS: LAN_IP });
  assert.equal(r.status, 1);
  assert.match(r.out, /cannot be combined with --real-sms \(ADR-053\)/);
  r = run(fx, ['--lan'], { SANDBOX_LAN_ADDRESS: '203.0.113.7' });
  assert.equal(r.status, 1);
  assert.match(r.out, /203\.0\.113\.7 is not a private address/);
  assert.equal(r.calls.length, 0);
});

test('a later start without --lan stops the HTTPS front and builds for localhost again; --down stops it too', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx, ['--lan'], { SANDBOX_LAN_ADDRESS: LAN_IP }).status, 0);
  const pid = Number(readFileSync(join(fx.repo, '.sandbox/pids/web-tls'), 'utf8'));
  writeFileSync(fx.log, '');
  const { status, out, calls } = run(fx);
  assert.equal(status, 0, out);
  assert.equal(existsSync(join(fx.repo, '.sandbox/pids/web-tls')), false);
  assert.equal(calls.filter((c) => c.startsWith('TLS|')).length, 0);
  assert.ok(uiCalls(fx, calls, '|run build').every((c) => /\|EDGE=http:\/\/localhost:493[0-2]\|/.test(c)));
  assert.equal(gone(pid), true, 'the HTTPS front is stopped');
  assert.equal(run(fx, ['--lan'], { SANDBOX_LAN_ADDRESS: LAN_IP }).status, 0);
  const again = Number(readFileSync(join(fx.repo, '.sandbox/pids/web-tls'), 'utf8'));
  assert.equal(run(fx, ['--down']).status, 0);
  assert.equal(gone(again), true, '--down stops the HTTPS front');
});

function gone(pid) {
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    spawnSync('sleep', ['0.1']);
  }
  return false;
}

test('the one-time document-door work runs before the timed sandbox launch, untimed and visible', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.repo, 'infrastructure/sandbox/up.sh'), '#!/usr/bin/env bash\necho "UP|" >> "$STUB_LOG"\n');
  const { status, out, calls } = run(fx);
  assert.equal(status, 0, out);
  const prepare = calls.findIndex((c) => c.includes('--filter @usrp/g2g-sandbox sandbox prepare|'));
  assert.ok(prepare >= 0, 'full.sh runs the launcher\'s prepare step itself');
  assert.ok(prepare < calls.indexOf('UP|'), 'before up.sh starts the launcher with its 5-minute window');
  assert.match(out, /document door: MinIO image and ClamAV volume \(a first boot builds MinIO from source/);
  const up = readFileSync(join(ROOT, 'infrastructure/sandbox/up.sh'), 'utf8');
  assert.ok(up.indexOf('sandbox prepare') < up.indexOf('setsid nohup pnpm sandbox'), 'up.sh prepares before the timed launch too');
});

test('--no-staging boots without staging campaigns, rehearsal staff or personas, and refuses --journeys', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.repo, 'infrastructure/sandbox/up.sh'), '#!/usr/bin/env bash\necho "UP|SANDBOX_STAGE=${SANDBOX_STAGE:-}" >> "$STUB_LOG"\n');
  const { status, out, calls } = run(fx, ['--no-staging']);
  assert.equal(status, 0, out);
  assert.ok(calls.includes('UP|SANDBOX_STAGE=0'), 'up.sh is told not to stage the campaigns');
  assert.equal(calls.filter((c) => c.includes('rehearse')).length, 0, 'no clearance matrix, no personas');
  assert.match(out, /no staging \(--no-staging\)/);
  const staged = run(fx);
  assert.ok(staged.calls.includes('UP|SANDBOX_STAGE=1'), 'a normal boot still stages');
  const r = run(fx, ['--no-staging', '--journeys']);
  assert.equal(r.status, 1);
  assert.match(r.out, /--journeys plays the staged rehearsal scenarios; it cannot run with --no-staging/);
});

test('sandbox:clean never touches a database that is not a sandbox one, not even through docker', (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'usrp-clean-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\necho "$*" >> "${join(bin, 'docker-calls')}"\nexit 0\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  for (const db of ['usrp_db', 'postgres', 'usrp_sandbox;drop', 'prod_usrp_sandbox']) {
    const r = spawnSync('bash', [join(ROOT, 'infrastructure/sandbox/clean.sh'), '--yes'], { encoding: 'utf8', env: { ...process.env, SANDBOX_DB: db, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 1, db);
    assert.match(r.stderr, /is not a sandbox database \(usrp_sandbox\*\); this tool never touches any other/, db);
  }
  assert.equal(existsSync(join(bin, 'docker-calls')), false, 'refused before any docker call');
  const unknown = spawnSync('bash', [join(ROOT, 'infrastructure/sandbox/clean.sh'), '--force'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
});

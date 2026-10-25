// ══════════════════════════════════════════════════════════════════
// g2g-sandbox selfcheck — FENCE 1, end to end (ADR-047 §3.1)
//
// Spawns the BUILT server (dist/main.js) under each profile and proves:
//   RED   production refuses to start; a sandbox without its own client
//         tokens, or with the published dev token, refuses; the live NESA
//         passthrough is refused outside the sandbox; an overlay directory
//         inside a git work tree is refused;
//   GREEN development and a correctly configured sandbox serve, and EVERY
//         response carries x-usrp-sandbox: 1, which a production process
//         then refuses (fence 2, response half).
// No infrastructure. Ports are ephemeral (SANDBOX_PORT=0).
//
//   pnpm --filter @usrp/g2g-sandbox build && tsx selfcheck/verify-simulator-fence.ts
// ══════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isForbiddenSandboxResponse } from '@usrp/shared-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, '..', 'dist', 'main.js');
const REPO = resolve(HERE, '..', '..', '..');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

interface Outcome { readonly exitCode: number | null; readonly port: number | null; readonly stderr: string; stop(): void }

/** Start the server; resolve once it listens (port) or exits (exitCode). */
function run(env: Record<string, string>, timeoutMs = 15_000): Promise<Outcome> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: process.env['PATH'] ?? '', SANDBOX_PORT: '0', SANDBOX_POPULATION_SIZE: '20', SANDBOX_LATENCY_SCALE: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (o: Omit<Outcome, 'stop' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ ...o, stderr, stop: () => { child.kill('SIGTERM'); } });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ exitCode: null, port: null }); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /"event":"sandbox_listening"[^\n]*"port":(\d+)/.exec(stdout);
      if (match?.[1] !== undefined) done({ exitCode: null, port: Number(match[1]) });
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('exit', (code) => { done({ exitCode: code, port: null }); });
  });
}

const refusedToStart = (o: Outcome): boolean => o.exitCode === 1 && o.port === null && o.stderr.includes('startup_failed');

console.log('g2g-sandbox fence 1 — the simulator starts only where it may');

console.log('\n── RED');
check('production (NODE_ENV=production, profile unset) refuses to start', refusedToStart(await run({ NODE_ENV: 'production' })));
check('production profile named explicitly refuses to start', refusedToStart(await run({ NODE_ENV: 'production', USRP_ENVIRONMENT: 'production' })));
check('sandbox without its own client tokens refuses', refusedToStart(await run({ NODE_ENV: 'production', USRP_ENVIRONMENT: 'sandbox' })));
check('sandbox with the published dev token refuses', refusedToStart(await run({ NODE_ENV: 'production', USRP_ENVIRONMENT: 'sandbox', SANDBOX_G2G_CLIENT_TOKENS: 'dev_g2g_sandbox_client_token' })));
check('live NESA passthrough refused in development (so never in CI)', refusedToStart(await run({ SANDBOX_NESA_LIVE: '1', SANDBOX_NESA_LIVE_INDEX: '990301PCM0012024' })));
check('an overlay directory inside a git work tree is refused', refusedToStart(await run({ SANDBOX_PRIVATE_PERSONA_DIR: REPO })));
const leaked = await run({ SANDBOX_PRIVATE_PERSONA_DIR: REPO });
check('...and the refusal names no path', !leaked.stderr.includes(REPO));

console.log('\n── GREEN');
for (const [label, env] of [
  ['development', {}],
  ['sandbox with its own token', { NODE_ENV: 'production', USRP_ENVIRONMENT: 'sandbox', SANDBOX_G2G_CLIENT_TOKENS: 'fence-proof-token-1f9a' }],
] as const) {
  const server = await run(env);
  check(`${label}: listens`, server.port !== null, server.stderr.slice(0, 200));
  if (server.port !== null) {
    const base = `http://127.0.0.1:${String(server.port)}`;
    const health = await fetch(`${base}/health`);
    const missing = await fetch(`${base}/no-such-path`);
    check(`${label}: /health is stamped x-usrp-sandbox: 1`, health.headers.get('x-usrp-sandbox') === '1');
    check(`${label}: a 404 is stamped too`, missing.status === 404 && missing.headers.get('x-usrp-sandbox') === '1');
    check(`${label}: a production process refuses that response`, isForbiddenSandboxResponse(health.headers, { NODE_ENV: 'production' }));
    await health.arrayBuffer();
    await missing.arrayBuffer();
    server.stop();
  }
}

if (failures > 0) {
  console.error(`\n✗ simulator fence proof FAILED — ${String(failures)} check(s)`);
  process.exit(1);
}
console.log('\n✓ simulator fence proof passed');

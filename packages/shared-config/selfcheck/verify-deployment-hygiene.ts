// ══════════════════════════════════════════════════════════════════
// DEPLOYMENT HYGIENE PROOF (zero infrastructure)
//
// Every service resolves its listening port through shared-config:
//
//     loadRuntimeConfig(name) -> PORT_<NAME> -> PORT -> 3000
//
// so `.env.example` is the canonical port map. A Dockerfile's EXPOSE is the
// SECOND, hand-written copy of that number — and a hand-written copy of a
// generated fact is exactly the kind of thing that rots silently. It rotted
// once already: three images shipped with the port triple (4003, 4004, 4005)
// rotated one position between biometric-, document-forensics- and
// background-vetting-service, so `docker run -P` published the wrong port and
// every orchestrator that reads image metadata to build a service record
// pointed at a neighbour.
//
// EXPOSE does not publish a port, which is precisely why the drift survived
// review: nothing fails loudly, the container still listens correctly, and the
// lie only surfaces in `-P` publishing, Compose/Swarm port inference, service
// meshes and k8s tooling that trusts image metadata. This proof makes the
// second copy provable against the first.
//
// It also pins the container security posture the edge-gateway image
// established and the other eleven inherited by copy: non-root, exec-form
// entrypoint (so SIGTERM reaches node and graceful shutdown runs instead of
// being swallowed by a shell), and NODE_ENV=production in the runtime stage.
// ══════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SERVICES = join(ROOT, 'services');

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
    console.error(
      `\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`,
    );
  }
}

function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

/** The exact derivation shared-config uses (config.ts: portEnvVar). */
function portEnvVar(serviceName: string): string {
  return `PORT_${serviceName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

// ── The canonical map: .env.example ───────────────────────────────
const envExamplePath = join(ROOT, '.env.example');
const envExample = readFileSync(envExamplePath, 'utf8');
const canonical = new Map<string, number>();
for (const line of envExample.split('\n')) {
  const m = /^\s*(PORT_[A-Z0-9_]+)\s*=\s*(\d+)\s*$/.exec(line);
  if (m !== null) canonical.set(m[1] as string, Number(m[2]));
}

const services = readdirSync(SERVICES)
  .filter((e) => statSync(join(SERVICES, e)).isDirectory())
  .sort();

section('Every service is deployable');
check('at least one service discovered', services.length > 0, String(services.length));
for (const name of services) {
  check(`${name}/Dockerfile exists`, existsSync(join(SERVICES, name, 'Dockerfile')));
}

section('EXPOSE matches the canonical PORT_<SERVICE> in .env.example');
const seen = new Map<number, string>();
for (const name of services) {
  const dockerfilePath = join(SERVICES, name, 'Dockerfile');
  if (!existsSync(dockerfilePath)) continue;
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const key = portEnvVar(name);
  const expected = canonical.get(key);

  check(`${key} is declared in .env.example`, expected !== undefined);
  if (expected === undefined) continue;

  const exposed = [...dockerfile.matchAll(/^EXPOSE\s+(\d+)/gm)].map((m) => Number(m[1]));
  check(`${name}: exactly one EXPOSE directive`, exposed.length === 1, `found ${String(exposed.length)}`);
  if (exposed.length !== 1) continue;

  const actual = exposed[0] as number;
  check(
    `${name}: EXPOSE ${String(actual)} === ${key}=${String(expected)}`,
    actual === expected,
    `Dockerfile says ${String(actual)}, .env.example says ${String(expected)}`,
  );

  const clash = seen.get(actual);
  check(
    `${name}: port ${String(actual)} is not already claimed`,
    clash === undefined,
    clash === undefined ? undefined : `also exposed by ${clash}`,
  );
  seen.set(actual, name);
}

section('Container security posture is uniform across every image');
for (const name of services) {
  const dockerfilePath = join(SERVICES, name, 'Dockerfile');
  if (!existsSync(dockerfilePath)) continue;
  const dockerfile = readFileSync(dockerfilePath, 'utf8');

  check(`${name}: drops root (USER node)`, /^USER\s+node\s*$/m.test(dockerfile));
  check(
    `${name}: NODE_ENV=production in the runtime stage`,
    /^ENV\s+NODE_ENV=production\s*$/m.test(dockerfile),
  );
  check(
    `${name}: exec-form CMD so SIGTERM reaches node`,
    /^CMD\s+\[\s*"node"\s*,\s*"dist\/main\.js"\s*\]/m.test(dockerfile),
    'shell-form CMD swallows signals and defeats graceful shutdown',
  );
  check(
    `${name}: installs --prod in the runtime stage (no tsx/typescript shipped)`,
    /pnpm install[^\n]*--prod/.test(dockerfile),
  );
}

// ── Supply chain and attestation (ADR-038) ─────────────────────────
// A tag is a pointer someone else can move; a digest is the bytes Trivy
// scanned and cosign signed. PORT pins the listening port to EXPOSE so a bare
// `docker run` cannot drift to the 3000 fallback. HEALTHCHECK makes Compose
// `--wait` mean "ready". The build ARGs feed GET /version.
section('Images are digest-pinned, self-describing and attest their build (ADR-038)');
const DIGEST_FROM = /^FROM\s+\S+@sha256:[0-9a-f]{64}(\s+AS\s+\S+)?\s*$/i;
for (const name of services) {
  const dockerfilePath = join(SERVICES, name, 'Dockerfile');
  if (!existsSync(dockerfilePath)) continue;
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const froms = dockerfile.split('\n').filter((line) => /^FROM\s/i.test(line));
  const unpinned = froms.filter((line) => !DIGEST_FROM.test(line.trim()));
  check(`${name}: every FROM is pinned by digest`, froms.length > 0 && unpinned.length === 0, unpinned.join(' | '));

  const key = portEnvVar(name);
  const exposed = /^EXPOSE\s+(\d+)/m.exec(dockerfile)?.[1];
  const portEnv = /^ENV\s+PORT=(\d+)\s*$/m.exec(dockerfile)?.[1];
  check(`${name}: ENV PORT equals EXPOSE`, portEnv !== undefined && portEnv === exposed, `PORT=${String(portEnv)} EXPOSE=${String(exposed)}`);
  check(
    `${name}: HEALTHCHECK probes /ready on ${key} or PORT`,
    /^HEALTHCHECK\s/m.test(dockerfile) && dockerfile.includes(`(process.env.${key}||process.env.PORT)+'/ready'`),
  );
  for (const fact of ['USRP_BUILD_SHA', 'USRP_BUILD_REF', 'USRP_BUILD_TIME']) {
    check(
      `${name}: ${fact} is a build ARG carried into the runtime ENV`,
      new RegExp(`^ARG ${fact}=`, 'm').test(dockerfile) && dockerfile.includes(`${fact}=$${fact}`),
    );
  }
  check(`${name}: runtime stage removes npm/corepack/yarn`, dockerfile.includes('rm -rf /usr/local/lib/node_modules'));
  check(`${name}: copies patches/ (package.json patches kafkajs)`, /^COPY patches \.\/patches$/m.test(dockerfile));
}
check('.dockerignore keeps .env files, .git and node_modules out of the build context', (() => {
  const path = join(ROOT, '.dockerignore');
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim());
  return ['.env', '.env.*', '**/node_modules', '.git'].every((entry) => lines.includes(entry));
})());

// ── GET /version answers on every service (ADR-038) ────────────────
// Every service serves HTTP through @usrp/shared-http, so proving the
// transport serves /version — with validated build facts — proves it for all
// twelve. The proof also checks that every service really does start through
// startHttpServer, so a service that grew its own server cannot opt out.
section('GET /version is served by the shared transport, on every service');
for (const name of services) {
  const main = join(SERVICES, name, 'src', 'main.ts');
  check(`${name}: serves through @usrp/shared-http startHttpServer`, existsSync(main) && /startHttpServer\(/.test(readFileSync(main, 'utf8')));
}
{
  // Relative import: shared-config does not depend on shared-http at runtime.
  const { startHttpServer } = await import('../../shared-http/src/index.js');
  const prior = { sha: process.env['USRP_BUILD_SHA'], ref: process.env['USRP_BUILD_REF'] };
  process.env['USRP_BUILD_SHA'] = 'abc1234';
  process.env['USRP_BUILD_REF'] = 'not a ref; rm -rf /';
  const server = await startHttpServer({ serviceName: 'hygiene-probe', port: 0, host: '127.0.0.1', routes: [], handleSignals: false, logger: () => undefined });
  try {
    const res = await fetch(`${server.url}/version`);
    const body = (await res.json()) as { service?: string; build?: { sha?: string; ref?: string } };
    check('/version answers 200', res.status === 200, String(res.status));
    check('/version names the service', body.service === 'hygiene-probe');
    check('/version reports the build SHA from the environment', body.build?.sha === 'abc1234');
    check('/version refuses to echo a malformed environment value', body.build?.ref === 'unknown', String(body.build?.ref));
  } finally {
    await server.stop();
    if (prior.sha === undefined) delete process.env['USRP_BUILD_SHA']; else process.env['USRP_BUILD_SHA'] = prior.sha;
    if (prior.ref === undefined) delete process.env['USRP_BUILD_REF']; else process.env['USRP_BUILD_REF'] = prior.ref;
  }
}

console.log(`\n\u001b[1m────────────────────────────────────────\u001b[0m`);
if (fail === 0) {
  console.log(`\u001b[1;32mDEPLOYMENT HYGIENE GREEN — ${String(pass)} checks ✓\u001b[0m`);
  process.exit(0);
}
console.error(`\u001b[0;31m${String(fail)} of ${String(pass + fail)} checks failed\u001b[0m`);
for (const label of failures) console.error(`  \u001b[0;31m✗ ${label}\u001b[0m`);
process.exit(1);

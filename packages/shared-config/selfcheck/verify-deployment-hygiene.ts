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

console.log(`\n\u001b[1m────────────────────────────────────────\u001b[0m`);
if (fail === 0) {
  console.log(`\u001b[1;32mDEPLOYMENT HYGIENE GREEN — ${String(pass)} checks ✓\u001b[0m`);
  process.exit(0);
}
console.error(`\u001b[0;31m${String(fail)} of ${String(pass + fail)} checks failed\u001b[0m`);
for (const label of failures) console.error(`  \u001b[0;31m✗ ${label}\u001b[0m`);
process.exit(1);

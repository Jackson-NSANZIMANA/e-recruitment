// ══════════════════════════════════════════════════════════════════
// shared-config — BIND HOST AND EXPOSURE PROOF (D9, ADR-053)
//
// The sandbox bound every process to 0.0.0.0 — thirteen of them — because
// `startHttpServer` had a wildcard default and no service passed a host. Nobody
// decided that; it was inherited, and nothing announced it.
//
// This proof makes the DECISION explicit and permanent. It asserts:
//
//   1. THE RESOLVER'S RULES: loopback by default, production refuses to boot
//      without USRP_HTTP_BIND_HOST, a hostname is refused (DNS must not decide which
//      interface holds citizen data), and 'localhost' is not silently accepted.
//   2. NO WILDCARD DEFAULT SURVIVES: `startHttpServer`'s host is a REQUIRED
//      option, and no service main() omits it.
//   3. CONTAINERS SAY SO: every compose file that runs a USRP service or the
//      simulator sets the variable (a loopback bind inside a container is a
//      service nobody can call — a CI failure, not a staging surprise).
//   4. THE DANGEROUS PAIR IS IMPOSSIBLE: the launcher refuses SANDBOX_EXPOSE_LAN
//      with real SMS unconditionally (the raw edge on the LAN). The full-system
//      script refuses --lan with --real-sms unless the owner acknowledges it
//      (ADR-053 §3.5), and that path exposes the applicant portal alone.
//   5. THE EDGE IS THE ONLY ESCAPE HATCH: the sandbox exposes one process, on
//      request, and prints it.
//
// It opens no socket and touches no database.
// ══════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BIND_HOST_VAR,
  BindHostError,
  LOOPBACK,
  bindHostAnnouncement,
  isExposedHost,
  isIpLiteral,
  resolveHttpBindHost,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

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

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8');
}

function throwsBindHost(fn: () => string): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof BindHostError;
  }
}

// ── 1. The resolver's rules ────────────────────────────────────────
section('The resolver: loopback by default, explicit to open');
check(
  'an unset variable in development binds loopback',
  resolveHttpBindHost({ serviceName: 'x', env: { NODE_ENV: 'development' } }) === LOOPBACK,
);
check(
  'an unset variable with no NODE_ENV binds loopback',
  resolveHttpBindHost({ serviceName: 'x', env: {} }) === LOOPBACK,
);
check(
  'production WITHOUT the variable refuses to boot',
  throwsBindHost(() => resolveHttpBindHost({ serviceName: 'edge-gateway', env: { NODE_ENV: 'production' } })),
);
check(
  'the production refusal names the variable and the service',
  (() => {
    try {
      resolveHttpBindHost({ serviceName: 'edge-gateway', env: { NODE_ENV: 'production' } });
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return message.includes(BIND_HOST_VAR) && message.includes('edge-gateway');
    }
  })(),
);
check(
  'an explicit IP literal is honoured (container / reverse proxy)',
  resolveHttpBindHost({ serviceName: 'x', env: { NODE_ENV: 'production', [BIND_HOST_VAR]: '0.0.0.0' } }) === '0.0.0.0',
);
check(
  'a hostname is refused — DNS must not choose the interface holding citizen data',
  throwsBindHost(() => resolveHttpBindHost({ serviceName: 'x', env: { [BIND_HOST_VAR]: 'localhost' } })),
);
check(
  'a malformed literal is refused',
  throwsBindHost(() => resolveHttpBindHost({ serviceName: 'x', env: { [BIND_HOST_VAR]: '256.1.1.1' } })),
);
check('isIpLiteral accepts IPv4 and the wildcard', isIpLiteral('127.0.0.1') && isIpLiteral('0.0.0.0') && isIpLiteral('10.10.4.2'));
check('isIpLiteral refuses a name', !isIpLiteral('venue.local') && !isIpLiteral(''));
check('exposure is reported honestly', isExposedHost('0.0.0.0') && isExposedHost('10.0.4.9') && !isExposedHost('127.0.0.1'));
const announcement = bindHostAnnouncement('edge-gateway', '10.0.4.9', 4921);
check(
  'the boot announcement carries exposure=network for a non-loopback host',
  announcement['exposure'] === 'network' && announcement['msg'] === 'http_bind_chosen',
  JSON.stringify(announcement),
);

// ── 2. No wildcard default survives ────────────────────────────────
section('No service can inherit exposure');
const serverSource = read('packages/shared-http/src/server.ts');
const serverTypes = read('packages/shared-http/src/types.ts');
check(
  "startHttpServer no longer defaults to '0.0.0.0'",
  !/host\s*=\s*'0\.0\.0\.0'/.test(serverSource),
  "found host = '0.0.0.0'",
);
check(
  'HttpServerOptions.host is REQUIRED (no `?`)',
  /readonly host: string;/.test(serverTypes) && !/readonly host\?: string;/.test(serverTypes),
);

const serviceDirs = readdirSync(join(REPO, 'services'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const mains = serviceDirs
  .map((svc) => ({ svc, path: join('services', svc, 'src', 'main.ts') }))
  .filter(({ path }) => {
    try {
      read(path);
      return true;
    } catch {
      return false;
    }
  });
check('every service has a main.ts', mains.length === serviceDirs.length, `${String(mains.length)}/${String(serviceDirs.length)}`);

const withoutResolver = mains.filter(({ path }) => !read(path).includes('resolveHttpBindHost('));
check(
  'every service resolves its bind host through the one resolver',
  withoutResolver.length === 0,
  withoutResolver.map((m) => m.svc).join(', '),
);
const withoutAnnouncement = mains.filter(({ path }) => !read(path).includes('bindHostAnnouncement('));
check(
  'every service announces where it will listen',
  withoutAnnouncement.length === 0,
  withoutAnnouncement.map((m) => m.svc).join(', '),
);
const withInlineWildcard = mains.filter(({ path }) => /host:\s*'0\.0\.0\.0'/.test(read(path)));
check(
  "no service hard-codes host: '0.0.0.0'",
  withInlineWildcard.length === 0,
  withInlineWildcard.map((m) => m.svc).join(', '),
);

// ── 3. Containers state their intent ───────────────────────────────
section('Compose files say where containers listen');
const rehearsal = read('infrastructure/images/docker-compose.rehearsal.yml');
check(
  'the rehearsal stack sets USRP_HTTP_BIND_HOST for its services',
  /USRP_HTTP_BIND_HOST:\s*"?0\.0\.0\.0"?/.test(rehearsal),
);
const tier1 = read('infrastructure/docker/docker-compose.tier1.yml');
check(
  'the simulator container sets SANDBOX_BIND_HOST (a loopback bind inside a container serves nobody)',
  /SANDBOX_BIND_HOST:\s*"?0\.0\.0\.0"?/.test(tier1),
);
check(
  'the simulator still keeps its HOST publish on loopback',
  /127\.0\.0\.1:3100:3100/.test(tier1),
);

// ── 4. The dangerous pair cannot be expressed ──────────────────────
section('LAN exposure and real SMS cannot coexist');
const launcher = read('tools/g2g-sandbox/scripts/sandbox.ts');
check(
  'the launcher refuses SANDBOX_EXPOSE_LAN with SANDBOX_SMS=twilio',
  launcher.includes('EXPOSE_LAN &&') && launcher.includes("=== 'twilio'") && /cannot be combined with SANDBOX_SMS=twilio/.test(launcher),
);
const full = read('infrastructure/sandbox/full.sh');
check(
  'the full-system script refuses the same pair unless it is acknowledged',
  /SANDBOX_EXPOSE_LAN[\s\S]{0,160}--real-sms/.test(full) && /ALLOW_LAN_SMS" != 1/.test(full),
);
// ADR-053 §3.5: the exception is narrow. It exists only for the app proxy, it is never implicit,
// and when taken it leaves exactly one app — the applicant portal — reachable from the network.
check(
  'the acknowledgement is explicit (--lan-real-sms / SANDBOX_I_ACCEPT_LAN_SMS), never a default',
  /ALLOW_LAN_SMS=0/.test(full) && /--lan-real-sms\) LAN=1; REAL_SMS=1; ALLOW_LAN_SMS=1/.test(full),
);
check(
  'live SMS on the LAN narrows the surface to the applicant portal alone',
  /LAN_APPS=\("applicant-portal:4930"\)/.test(full) && /maps\+=\("\$LAN_IP:\$\{a##\*:\}=\$\{a##\*:\}"\)/.test(full),
);
check(
  'the narrowed exception never reaches the launcher (the edge stays off the LAN)',
  /unset SANDBOX_EXPOSE_LAN/.test(full),
);

// ── 5. The edge is the only escape hatch ───────────────────────────
section('One process may leave loopback, on request, visibly');
check(
  'the sandbox defaults every process to loopback',
  /USRP_HTTP_BIND_HOST:\s*'127\.0\.0\.1'/.test(launcher),
);
check(
  'only the edge receives the LAN address',
  /svc === 'edge-gateway' \? \{ \.\.\.env, USRP_HTTP_BIND_HOST: exposedTo \}/.test(launcher),
);
check(
  'exposure is printed on the operator surface, not buried in a log',
  launcher.includes('EDGE EXPOSED') && launcher.includes('LOOPBACK ONLY'),
);
check(
  'the environment template documents the variable',
  /USRP_HTTP_BIND_HOST=/.test(read('.env.example')),
);

// ── Verdict ────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\u001b[0;32m' : '\u001b[0;31m'}${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
if (fail > 0) {
  console.error(`\nBIND EXPOSURE FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\u001b[0;32mBIND EXPOSURE OK\u001b[0m');

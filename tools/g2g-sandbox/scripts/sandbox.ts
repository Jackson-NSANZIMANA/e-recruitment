// ══════════════════════════════════════════════════════════════════
// pnpm sandbox — boot the USRP_ENVIRONMENT=sandbox profile (ADR-047 §3.1)
//
//   pnpm sandbox            up: own database, own broker, fresh secrets, 49xx
//   pnpm sandbox --status   what is running (ports only)
//   pnpm sandbox:down       stop the sandbox processes and broker (keeps data)
//   pnpm sandbox:reset      down + DROP DATABASE usrp_sandbox + remove state
//
// What "sandbox" means here: every service boots with NODE_ENV=production and
// USRP_ENVIRONMENT=sandbox, so the production boot guard runs in full with
// freshly minted secrets (no committed dev value boots). The documented
// sandbox differences: single-host (loopback infrastructure, no broker TLS),
// G2G base URLs on the simulator (port 4900), and the dev SMS inbox in place
// of the Twilio emulator until S12b.
//
// Isolation from the developer's own stack:
//   • database usrp_sandbox on the shared Postgres server (never usrp_db);
//   • its own Kafka (compose project usrp-sandbox, host port 4992), so no
//     consumer group is ever shared;
//   • ports 4900–4921; processes started detached in their own session and
//     stopped by process group, never by name;
//   • state (secrets, logs, SMS inbox) in <repo>/.sandbox, git-ignored, mode 0700.
//
// Not started: document-forensics-service (the sandbox has no object store of
// its own; the shared MinIO holds only committed dev credentials, which the
// guard refuses). The applicant document door answers 503 in the sandbox.
// The RIB and HEC mocks (hash-keyed, unchanged) are reused from tier1.
//
// Optional: SANDBOX_PRIVATE_PERSONA_DIR, SANDBOX_NESA_LIVE=1 +
// SANDBOX_NESA_LIVE_INDEX are passed to the simulator only. Nothing they hold
// is written by this script.
// ══════════════════════════════════════════════════════════════════

import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '@usrp/shared-security';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STATE = join(REPO, '.sandbox');
const PG_CONTAINER = process.env['PG_CONTAINER'] ?? 'usrp-postgres';
const PG_ADMIN = process.env['PG_ADMIN_USER'] ?? 'usrp_admin';
const DB = 'usrp_sandbox';
const COMPOSE = ['compose', '-p', 'usrp-sandbox', '-f', join(REPO, 'infrastructure/docker/docker-compose.sandbox.yml')];
const SIMULATOR_PORT = 4900;
const EDGE_PORT = 4921;
const SERVICE_PORTS: Readonly<Record<string, number>> = {
  'identity-service': 4901,
  'eligibility-service': 4902,
  'biometric-service': 4903,
  'background-vetting-service': 4905,
  'application-service': 4906,
  'scheduling-service': 4907,
  'notification-service': 4908,
  'field-sync-service': 4909,
  'audit-service': 4910,
  'iam-service': 4911,
  'edge-gateway': EDGE_PORT,
};
const SANDBOX_CLIENT_ID = 'sandbox.identity-portal';
const SANDBOX_CLIENT_SERVICE_ID = '66666666-6666-4666-8666-666666666666';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const fail = (message: string): never => { process.stderr.write(`✗ ${message}\n`); process.exit(1); };

function sh(cmd: string, args: readonly string[], input?: string): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
}

function psqlAdmin(database: string, sqlText: string): string {
  return sh('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_ADMIN, '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAq'], sqlText).trim();
}

function portBusy(port: number): boolean {
  try {
    return sh('ss', ['-H', '-ltn', `sport = :${String(port)}`]).trim() !== '';
  } catch {
    return false;
  }
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function freshSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Parse .env.example (literal assignments only: check-env-file.mjs guarantees it). */
function templateEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(join(REPO, '.env.example'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1);
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    env[line.slice(0, eq)] = value;
  }
  return env;
}

interface Secrets {
  readonly [key: string]: string;
}

/** Mint (or reuse) the sandbox's own secrets. Mode 0600, never printed. */
function secrets(): Secrets {
  const file = join(STATE, 'secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Secrets;
  const auth = generateKeyPairSync('ed25519');
  const qr = generateKeyPairSync('ed25519');
  const minted: Secrets = {
    NATIONAL_ID_HMAC_KEY: freshSecret(),
    PII_ENCRYPTION_KEY: freshSecret(),
    AUTH_JWT_PRIVATE_KEY_B64: b64(auth.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    AUTH_JWT_PUBLIC_KEY_B64: b64(auth.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    QR_SIGNING_PRIVATE_KEY_B64: b64(qr.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    QR_INVITATION_PUBLIC_KEY_B64: b64(qr.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    QR_SIGNING_KEY_ID: `sandbox-qr-${randomBytes(4).toString('hex')}`,
    IDENTITY_CLIENT_SECRET: freshSecret(),
    EDGE_SESSION_HMAC_KEY: freshSecret(),
    NIDA_HMAC_SECRET: freshSecret(),
    NIDA_CLIENT_TOKEN: freshSecret(),
    NESA_HMAC_SECRET: freshSecret(),
    RIB_HMAC_SECRET: freshSecret(),
    HEC_HMAC_SECRET: freshSecret(),
    MINIO_ENCRYPTION_KEY: freshSecret(),
    MINIO_ROOT_PASSWORD: freshSecret(),
  };
  writeFileSync(file, JSON.stringify(minted), { mode: 0o600 });
  return minted;
}

function serviceEnv(s: Secrets): Record<string, string> {
  const env: Record<string, string> = { ...templateEnv(), ...s };
  delete env['POSTGRES_PASSWORD']; // services connect with DATABASE_URL only
  // Template keys still holding a placeholder are reserved for integrations no
  // service consumes yet (NIDA_API_KEY, ...). The guard refuses placeholders in
  // the sandbox exactly as in production, so they are not passed at all.
  for (const [key, value] of Object.entries(env)) if (/CHANGE_ME|REPLACE_ME|INSERT_YOUR/i.test(value)) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith('FEATURE_USE_') && key.endsWith('_MOCK')) env[key] = 'false';
  const local = (port: number): string => `http://localhost:${String(port)}`;
  Object.assign(env, {
    NODE_ENV: 'production',
    USRP_ENVIRONMENT: 'sandbox',
    LOG_LEVEL: 'info',
    DATABASE_URL: `postgresql://usrp_app:app_pw@localhost:5432/${DB}`,
    KAFKA_BROKERS: 'localhost:4992',
    KAFKA_SSL: 'false',
    MINIO_USE_SSL: 'false',
    EDGE_COOKIE_SECURE: 'true',
    IDENTITY_CLIENT_ID: SANDBOX_CLIENT_ID,
    IAM_BASE_URL: local(4911),
    APPLICATION_SERVICE_BASE_URL: local(4906),
    SCHEDULING_SERVICE_BASE_URL: local(4907),
    IDENTITY_SERVICE_BASE_URL: local(4901),
    FIELD_SYNC_SERVICE_BASE_URL: local(4909),
    BIOMETRIC_SERVICE_BASE_URL: local(4903),
    NIDA_BASE_URL: local(SIMULATOR_PORT),
    NESA_BASE_URL: local(SIMULATOR_PORT),
    BIOMETRIC_MODE_RDF: 'SHADOW',
    DEV_SMS_INBOX_FILE: join(STATE, 'sms', 'inbox.jsonl'),
    CORS_ORIGINS: 'http://localhost:4930,http://localhost:4931,http://localhost:4932',
  });
  delete env['DOCUMENT_FORENSICS_BASE_URL'];
  for (const [svc, port] of Object.entries(SERVICE_PORTS)) {
    env[`PORT_${svc.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] = String(port);
  }
  return env;
}

function startDetached(name: string, args: readonly string[], env: Record<string, string>): number {
  const log = openSync(join(STATE, 'logs', `${name}.log`), 'a');
  const child = spawn(process.execPath, args, { cwd: REPO, env: { PATH: process.env['PATH'] ?? '', ...env }, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  if (child.pid === undefined) fail(`${name} did not start`);
  writeFileSync(join(STATE, 'pids', name), String(child.pid));
  return child.pid as number;
}

async function waitReady(name: string, port: number, path: string, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${String(port)}${path}`);
      if (r.ok) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${name} was not ready on :${String(port)} within ${String(timeoutMs / 1000)} s — see .sandbox/logs/${name}.log`);
}

function stopProcesses(): void {
  const dir = join(STATE, 'pids');
  if (!existsSync(dir)) return;
  for (const name of execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    const pid = Number(readFileSync(join(dir, name), 'utf8'));
    try {
      process.kill(-pid, 'SIGTERM'); // the detached child leads its own process group
    } catch {
      // already gone
    }
    rmSync(join(dir, name), { force: true });
  }
}

async function up(): Promise<void> {
  for (const svc of Object.keys(SERVICE_PORTS)) {
    if (!existsSync(join(REPO, 'services', svc, 'dist', 'main.js'))) fail(`services/${svc} is not built — run pnpm build first`);
  }
  if (!existsSync(join(REPO, 'tools/g2g-sandbox/dist/main.js'))) fail('tools/g2g-sandbox is not built — run pnpm build first');
  for (const port of [SIMULATOR_PORT, ...Object.values(SERVICE_PORTS)]) if (portBusy(port)) fail(`port ${String(port)} is in use (pnpm sandbox:down, or free it)`);
  for (const dir of ['', 'logs', 'pids', 'sms']) mkdirSync(join(STATE, dir), { recursive: true, mode: 0o700 });
  chmodSync(STATE, 0o700);
  const s = secrets();

  out('▶ broker: own Kafka (compose project usrp-sandbox, :4992)');
  sh('docker', [...COMPOSE, 'up', '-d', '--wait', 'sandbox-kafka']);
  sh('docker', [...COMPOSE, 'up', '--exit-code-from', 'sandbox-kafka-init', 'sandbox-kafka-init']);

  out(`▶ database: ${DB} (shared Postgres server, own database)`);
  if (psqlAdmin('postgres', `SELECT 1 FROM pg_database WHERE datname = '${DB}'`) !== '1') {
    psqlAdmin('postgres', `CREATE DATABASE ${DB}`);
    const adminUrl = `postgresql://${PG_ADMIN}:usrp_dev_password@localhost:5432/${DB}`;
    execFileSync('bash', [join(REPO, 'scripts/bootstrap-db.sh')], {
      cwd: REPO,
      stdio: ['ignore', openSync(join(STATE, 'logs', 'bootstrap-db.log'), 'a'), openSync(join(STATE, 'logs', 'bootstrap-db.log'), 'a')],
      // NODE_ENV=production: bootstrap skips the fixed-password dev officer seed.
      env: { ...process.env, PG_DB: DB, DATABASE_URL: adminUrl, ADMIN_DATABASE_URL: adminUrl, NODE_ENV: 'production' },
    });
  }
  // The applicant-portal machine client with the sandbox's own secret.
  const credential = hashPassword(s['IDENTITY_CLIENT_SECRET'] ?? '');
  psqlAdmin(DB, `SET ROLE usrp_iam_service; INSERT INTO public_core.service_accounts (service_id, client_id, credential, description) VALUES ('${SANDBOX_CLIENT_SERVICE_ID}', '${SANDBOX_CLIENT_ID}', '${credential.replace(/'/g, "''")}', 'G2G sandbox applicant-portal backend client (pnpm sandbox)') ON CONFLICT (client_id) DO UPDATE SET credential = EXCLUDED.credential;`);

  out(`▶ simulators: g2g-sandbox (sandbox profile) on :${String(SIMULATOR_PORT)}`);
  const simEnv: Record<string, string> = {
    NODE_ENV: 'production',
    USRP_ENVIRONMENT: 'sandbox',
    SANDBOX_PORT: String(SIMULATOR_PORT),
    SANDBOX_G2G_CLIENT_TOKENS: s['NIDA_CLIENT_TOKEN'] ?? '',
    SANDBOX_LATENCY_SCALE: process.env['SANDBOX_LATENCY_SCALE'] ?? '1',
  };
  for (const key of ['SANDBOX_PRIVATE_PERSONA_DIR', 'SANDBOX_PRIVATE_PERSONA_DISTRICT', 'SANDBOX_NESA_LIVE', 'SANDBOX_NESA_LIVE_INDEX', 'SANDBOX_SEED', 'SANDBOX_POPULATION_SIZE']) {
    const value = process.env[key];
    if (value !== undefined && value !== '') simEnv[key] = value;
  }
  startDetached('g2g-sandbox', ['tools/g2g-sandbox/dist/main.js'], simEnv);
  await waitReady('g2g-sandbox', SIMULATOR_PORT, '/health', 30_000);

  const env = serviceEnv(s);
  for (const svc of Object.keys(SERVICE_PORTS)) {
    out(`▶ ${svc} on :${String(SERVICE_PORTS[svc])}`);
    startDetached(svc, [`services/${svc}/dist/main.js`], env);
  }
  for (const [svc, port] of Object.entries(SERVICE_PORTS)) await waitReady(svc, port, '/ready');
  out('');
  out(`✓ sandbox up · edge http://localhost:${String(EDGE_PORT)} · simulators :${String(SIMULATOR_PORT)} · database ${DB} · broker :4992`);
  out('  SMS inbox: .sandbox/sms/inbox.jsonl · logs: .sandbox/logs/ · rehearse: pnpm rehearse --sandbox <scenario>');
}

function down(): void {
  stopProcesses();
  try {
    sh('docker', [...COMPOSE, 'down']);
  } catch {
    // project not running
  }
  out('✓ sandbox processes and broker stopped (database and state kept)');
}

function reset(): void {
  stopProcesses();
  try {
    sh('docker', [...COMPOSE, 'down', '-v']); // this project's own volume only
  } catch {
    // project not running
  }
  try {
    psqlAdmin('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  } catch (error) {
    fail(`could not drop ${DB}: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : 'unknown'}`);
  }
  rmSync(STATE, { recursive: true, force: true });
  out(`✓ sandbox reset: ${DB} dropped, broker volume and .sandbox/ removed`);
}

function status(): void {
  for (const [name, port] of [['g2g-sandbox', SIMULATOR_PORT] as const, ...Object.entries(SERVICE_PORTS)]) {
    out(`${portBusy(port) ? '●' : '○'} ${name} :${String(port)}`);
  }
}

const command = process.argv[2] ?? 'up';
if (command === 'up') await up();
else if (command === 'down') down();
else if (command === 'reset') reset();
else if (command === '--status' || command === 'status') status();
else fail(`unknown command ${command} (up | down | reset | status)`);

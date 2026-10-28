// ══════════════════════════════════════════════════════════════════
// shared-config selfcheck — the SANDBOX profile and its two-way fences
// (ADR-047 §3.1). Deterministic, no infrastructure. Every fence is proven RED
// (the forbidden configuration is refused) and GREEN (the permitted one boots).
//
// The simulator's own start-up fence (fence 1) is proven by
// tools/g2g-sandbox/selfcheck/verify-simulator-fence.ts, which spawns the
// real server under each profile.
//
//   pnpm --filter @usrp/shared-config exec tsx selfcheck/verify-sandbox-fences.ts
// ══════════════════════════════════════════════════════════════════

import {
  EnvValidationError,
  assertDevAdapterAllowed,
  assertProductionSecrets,
  assertSimulatorAllowed,
  isForbiddenSandboxResponse,
  resolveUsrpEnvironment,
  SANDBOX_NETWORK_ENDPOINT_KEYS,
  type EnvSource,
} from '../src/index.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function issuesOf(fn: () => unknown): readonly string[] | null {
  try {
    fn();
    return null;
  } catch (err: unknown) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
}

const refused = (fn: () => unknown, needle?: RegExp): boolean => {
  const issues = issuesOf(fn);
  return issues !== null && (needle === undefined || issues.some((i) => needle.test(i)));
};

// Production-grade values (fresh, never committed digests) on a real topology.
const PROD_ENV: EnvSource = {
  NODE_ENV: 'production',
  NATIONAL_ID_HMAC_KEY: 'hsm-issued-national-id-hmac-key-a91f3c7e',
  PII_ENCRYPTION_KEY: 'hsm-issued-pii-encryption-key-5b2d8f04',
  NIDA_HMAC_SECRET: 'hsm-issued-nida-hmac-secret-77c1',
  EDGE_SESSION_HMAC_KEY: 'kms-issued-edge-session-hmac-key-6f22',
  DATABASE_URL: 'postgresql://usrp_app:real_pw@db.usrp.internal:5432/usrp_db',
  KAFKA_BROKERS: 'kafka-0.usrp.internal:9093',
  NIDA_BASE_URL: 'https://nida.g2g.internal',
  NESA_BASE_URL: 'https://nesa.g2g.internal',
  KAFKA_SSL: 'true',
  MINIO_USE_SSL: 'true',
  EDGE_COOKIE_SECURE: 'true',
};

// The single-host sandbox `pnpm sandbox` boots: same secrets discipline, loopback
// infrastructure, simulators for every authority.
const SANDBOX_ENV: EnvSource = {
  ...PROD_ENV,
  USRP_ENVIRONMENT: 'sandbox',
  DATABASE_URL: 'postgresql://usrp_app:sandbox_pw@localhost:5432/usrp_sandbox',
  KAFKA_BROKERS: 'localhost:4992',
  NIDA_BASE_URL: 'http://localhost:4900',
  NESA_BASE_URL: 'http://g2g-sandbox:4900',
  KAFKA_SSL: 'false',
  MINIO_USE_SSL: 'false',
};

console.log('sandbox profile and fences — deterministic proof (no infrastructure)');

console.log('\n── the profile resolves, and contradictions are refused');
check('unset + NODE_ENV unset → development', resolveUsrpEnvironment({}) === 'development');
check('unset + NODE_ENV=production → production', resolveUsrpEnvironment({ NODE_ENV: 'production' }) === 'production');
check('sandbox + NODE_ENV=production → sandbox', resolveUsrpEnvironment(SANDBOX_ENV) === 'sandbox');
check('RED: sandbox without NODE_ENV=production', refused(() => resolveUsrpEnvironment({ USRP_ENVIRONMENT: 'sandbox' }), /requires NODE_ENV=production/));
check('RED: development with NODE_ENV=production', refused(() => resolveUsrpEnvironment({ USRP_ENVIRONMENT: 'development', NODE_ENV: 'production' })));
check('RED: an unknown profile name', refused(() => resolveUsrpEnvironment({ USRP_ENVIRONMENT: 'staging' })));
check('RED: the production guard reports a contradictory profile', refused(() => { assertProductionSecrets({ ...PROD_ENV, USRP_ENVIRONMENT: 'development' }); }));

console.log('\n── GREEN baselines');
check('GREEN: a correct production environment boots', issuesOf(() => { assertProductionSecrets(PROD_ENV); }) === null, String(issuesOf(() => { assertProductionSecrets(PROD_ENV); })));
check('GREEN: the single-host sandbox boots (loopback + simulator hosts, no broker TLS)', issuesOf(() => { assertProductionSecrets(SANDBOX_ENV); }) === null, String(issuesOf(() => { assertProductionSecrets(SANDBOX_ENV); })));

console.log('\n── fence 2: production refuses simulator hosts');
check('RED: production NIDA_BASE_URL on the g2g-sandbox host', refused(() => { assertProductionSecrets({ ...PROD_ENV, NIDA_BASE_URL: 'http://g2g-sandbox:4900' }); }, /SIMULATOR/));
check('RED: production NESA_BASE_URL on usrp-g2g-sandbox', refused(() => { assertProductionSecrets({ ...PROD_ENV, NESA_BASE_URL: 'https://usrp-g2g-sandbox' }); }, /SIMULATOR/));
check('RED: production on the .sandbox.usrp.internal zone', refused(() => { assertProductionSecrets({ ...PROD_ENV, NESA_BASE_URL: 'https://nesa.sandbox.usrp.internal' }); }, /SIMULATOR/));
check('RED: production on a loopback simulator (endpoint rule)', refused(() => { assertProductionSecrets({ ...PROD_ENV, NIDA_BASE_URL: 'http://localhost:4900' }); }, /loopback/));
check('GREEN: a lookalike host is not a simulator host', issuesOf(() => { assertProductionSecrets({ ...PROD_ENV, NIDA_BASE_URL: 'https://g2gsandbox-registry.gov.example' }); }) === null);

console.log('\n── sandbox: all service endpoints reject external hosts');
for (const key of SANDBOX_NETWORK_ENDPOINT_KEYS) {
  const external = key === 'DATABASE_URL'
    ? 'postgresql://usrp_app:synthetic-test-only@outside.example:5432/usrp_sandbox'
    : key === 'KAFKA_BROKERS' ? 'outside.example:9092'
      : key === 'CLAMAV_HOST' ? 'outside.example:3310'
        : 'https://outside.example:9000';
  check(`RED: sandbox ${key} rejects an external host`, refused(() => {
    assertProductionSecrets({ ...SANDBOX_ENV, [key]: external });
  }, /external hosts are refused/));
}
check('GREEN: sandbox accepts loopback and its named simulator', issuesOf(() => { assertProductionSecrets(SANDBOX_ENV); }) === null);
check('GREEN: sandbox accepts compose service names (a private network)', issuesOf(() => {
  assertProductionSecrets({ ...SANDBOX_ENV, DATABASE_URL: 'postgresql://usrp_app:synthetic-test-only@postgres:5432/usrp_sandbox', KAFKA_BROKERS: 'sandbox-kafka:9092', IAM_BASE_URL: 'http://iam-service:4011' });
}) === null);
check('RED: sandbox refuses a non-loopback IP address', refused(() => {
  assertProductionSecrets({ ...SANDBOX_ENV, IAM_BASE_URL: 'http://10.0.0.5:4011' });
}, /external hosts are refused/));

console.log('\n── fence 2: production refuses a response that carries x-usrp-sandbox');
const stamped = new Headers({ 'x-usrp-sandbox': '1' });
const clean = new Headers({ 'content-type': 'application/json' });
check('RED: production + stamped response', isForbiddenSandboxResponse(stamped, PROD_ENV));
check('GREEN: production + clean response', !isForbiddenSandboxResponse(clean, PROD_ENV));
check('GREEN: sandbox + stamped response', !isForbiddenSandboxResponse(stamped, SANDBOX_ENV));
check('GREEN: development + stamped response', !isForbiddenSandboxResponse(stamped, { NODE_ENV: 'development' }));
check('RED: an unresolvable profile is treated as production', isForbiddenSandboxResponse(stamped, { USRP_ENVIRONMENT: 'bogus' }));

console.log('\n── fence 3: sandbox refuses the real registries');
for (const [key, url] of [
  ['NIDA_BASE_URL', 'https://api.irembohub.com'],
  ['NIDA_BASE_URL', 'https://irembo.gov.rw'],
  ['NESA_BASE_URL', 'https://rne.sdms.gov.rw'],
  ['RIB_BASE_URL', 'https://g2g.rib.gov.rw'],
] as const) {
  check(`RED: sandbox ${key} → ${new URL(url).hostname}`, refused(() => { assertProductionSecrets({ ...SANDBOX_ENV, [key]: url }); }, /REAL registry/));
}
check('GREEN: production may name the real registry (cutover)', issuesOf(() => { assertProductionSecrets({ ...PROD_ENV, NESA_BASE_URL: 'https://rne.sdms.gov.rw' }); }) === null);

console.log('\n── the production guard runs IN FULL in the sandbox');
check('RED: sandbox with a committed dev secret', refused(() => { assertProductionSecrets({ ...SANDBOX_ENV, NIDA_HMAC_SECRET: 'dev_nida_hmac_secret' }); }, /DEVELOPMENT value/));
check('RED: sandbox with the published g2g dev client token', refused(() => { assertProductionSecrets({ ...SANDBOX_ENV, NIDA_CLIENT_TOKEN: 'dev_g2g_sandbox_client_token' }); }, /DEVELOPMENT value/));
check('RED: sandbox with a placeholder', refused(() => { assertProductionSecrets({ ...SANDBOX_ENV, PII_ENCRYPTION_KEY: 'CHANGE_ME_32_CHAR_MIN_AES256_KEY' }); }, /placeholder/));
check('RED: sandbox with a mock toggle', refused(() => { assertProductionSecrets({ ...SANDBOX_ENV, FEATURE_USE_NIDA_MOCK: 'true' }); }, /FEATURE_USE_NIDA_MOCK/));
check('RED: sandbox with insecure cookies', refused(() => { assertProductionSecrets({ ...SANDBOX_ENV, EDGE_COOKIE_SECURE: 'false' }); }, /EDGE_COOKIE_SECURE/));
check('RED: production still refuses KAFKA_SSL=false', refused(() => { assertProductionSecrets({ ...PROD_ENV, KAFKA_SSL: 'false' }); }, /KAFKA_SSL/));

console.log('\n── dev adapters: only the named stand-in, only in the sandbox');
check('GREEN: sandbox may keep LogSmsChannel until S12b', issuesOf(() => { assertDevAdapterAllowed('LogSmsChannel', 'x', SANDBOX_ENV); }) === null);
check('RED: sandbox refuses MockBiometricMatcher', refused(() => { assertDevAdapterAllowed('MockBiometricMatcher', 'x', SANDBOX_ENV); }));
check('RED: production refuses LogSmsChannel', refused(() => { assertDevAdapterAllowed('LogSmsChannel', 'x', PROD_ENV); }));

console.log('\n── fence 1 (configuration half): where a simulator may run');
check('GREEN: simulator in development', assertSimulatorAllowed({}) === 'development');
check('GREEN: simulator in sandbox', assertSimulatorAllowed(SANDBOX_ENV) === 'sandbox');
check('RED: simulator in production', refused(() => assertSimulatorAllowed(PROD_ENV), /refuse to start in production/));

if (failures > 0) {
  console.error(`\n✗ sandbox-fence proof FAILED — ${String(failures)} check(s)`);
  process.exit(1);
}
console.log('\n✓ sandbox-fence proof passed');

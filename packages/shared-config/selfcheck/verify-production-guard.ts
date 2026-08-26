// ══════════════════════════════════════════════════════════════════
// @usrp/shared-config — Production boot guard self-check
//
// The guard refuses to start a production process carrying dev key material,
// placeholder secrets, loopback endpoints or mock G2G integrations. This is
// its proof, and it is deliberately the CHEAPEST proof in the repo: pure
// functions over an explicit EnvSource, no Postgres, no Kafka, no MinIO, no
// docker, no sockets.
//
// EVERY RULE IS ASSERTED IN BOTH DIRECTIONS. A guard that refuses everything
// passes a one-directional test and bricks production; a guard that refuses
// nothing passes an even simpler one. So each rule gets an input that MUST
// trip it and a neighbouring input that MUST NOT.
//
// The single most important assertion is the FIRST one: with a full set of
// committed dev values and NODE_ENV=development, the guard does nothing at
// all. If that regresses, every developer's `pnpm dev` and all 38 proofs
// below this one break at once, and the guard becomes the outage instead of
// the control.
//
// NOTE ON SOUNDNESS: every call passes an EXPLICIT source object and this
// file never reads or writes process.env. Under `pnpm verify` the gate
// exports DATABASE_URL, KAFKA_BROKERS, both master keys and the auth
// keypair; a proof that read the ambient environment would be asserting
// against the gate's exports rather than against its own fixtures — the
// exact unsoundness 3b4fca8 had to fix in the dev-boot proof.
//
//   npx tsx packages/shared-config/selfcheck/verify-production-guard.ts
// ══════════════════════════════════════════════════════════════════

import {
  EnvValidationError,
  assertProductionSecrets,
  isProduction,
  resolveEventTransport,
  type EnvSource,
} from '../src/index.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  \u2713 ${label}`);
  else {
    failures += 1;
    console.error(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Run the guard and hand back the error it raised, if any. */
function capture(source: EnvSource): EnvValidationError | undefined {
  try {
    assertProductionSecrets(source);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof EnvValidationError) return err;
    throw err;
  }
}

const trips = (source: EnvSource): boolean => capture(source) !== undefined;

// ── Fixtures ────────────────────────────────────────────────────

// The exact values committed in .env.example. Kept here as fixtures, which is
// safe for the same reason it is safe in the template: they are published dev
// material, worthless outside localhost.
const DEV_NATIONAL_ID_HMAC_KEY = 'dev_national_id_hmac_key_min_32_chars!!';
const DEV_PII_ENCRYPTION_KEY = 'dev_pii_encryption_key_min_32_chars_ok!!';
const DEV_NIDA_HMAC_SECRET = 'dev_nida_hmac_secret';
const PLACEHOLDER_KEY = 'CHANGE_ME_32_CHAR_MIN_AES256_KEY';

// A full development environment, exactly as a fresh clone gets it.
const DEV_ENV: EnvSource = {
  NODE_ENV: 'development',
  NATIONAL_ID_HMAC_KEY: DEV_NATIONAL_ID_HMAC_KEY,
  PII_ENCRYPTION_KEY: DEV_PII_ENCRYPTION_KEY,
  NIDA_HMAC_SECRET: DEV_NIDA_HMAC_SECRET,
  MINIO_ENCRYPTION_KEY: PLACEHOLDER_KEY,
  EDGE_SESSION_HMAC_KEY: 'CHANGE_ME_32_CHAR_MIN_EDGE_SESSION_HMAC_KEY',
  DATABASE_URL: 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db',
  KAFKA_BROKERS: 'localhost:29092',
  IAM_BASE_URL: 'http://localhost:4011',
  NIDA_BASE_URL: 'http://localhost:3100',
  MINIO_ENDPOINT: 'localhost',
  CLAMAV_HOST: 'localhost',
  KAFKA_SSL: 'false',
  MINIO_USE_SSL: 'false',
  EDGE_COOKIE_SECURE: 'false',
  FEATURE_USE_NIDA_MOCK: 'true',
  FEATURE_USE_RIB_MOCK: 'true',
};

// The same platform, configured for production the way it is supposed to be.
const PROD_ENV: EnvSource = {
  NODE_ENV: 'production',
  NATIONAL_ID_HMAC_KEY: 'hsm-issued-national-id-hmac-key-a91f3c7e',
  PII_ENCRYPTION_KEY: 'hsm-issued-pii-encryption-key-5b2d8f04',
  NIDA_HMAC_SECRET: 'hsm-issued-nida-hmac-secret-77c1',
  MINIO_ENCRYPTION_KEY: 'kms-issued-document-envelope-key-3e9a',
  EDGE_SESSION_HMAC_KEY: 'kms-issued-edge-session-hmac-key-6f22',
  DATABASE_URL: 'postgresql://usrp_app:real_pw@db.usrp.internal:5432/usrp_db',
  KAFKA_BROKERS: 'kafka-0.usrp.internal:9093,kafka-1.usrp.internal:9093',
  IAM_BASE_URL: 'https://iam.usrp.internal',
  NIDA_BASE_URL: 'https://nida.g2g.internal',
  MINIO_ENDPOINT: 'minio.usrp.internal',
  CLAMAV_HOST: 'clamav.usrp.internal',
  KAFKA_SSL: 'true',
  MINIO_USE_SSL: 'true',
  EDGE_COOKIE_SECURE: 'true',
  FEATURE_USE_NIDA_MOCK: 'false',
  FEATURE_USE_RIB_MOCK: 'false',
};

const withProd = (overrides: Record<string, string | undefined>): EnvSource => ({
  ...PROD_ENV,
  ...overrides,
});

console.log('production boot guard — deterministic proof (no infrastructure)');

// ── 1. INERT OUTSIDE PRODUCTION — the load-bearing negative ────────────
console.log('\n── inert outside production');
check('a full committed-dev environment passes under NODE_ENV=development', !trips(DEV_ENV));
check('...and with NODE_ENV unset entirely', !trips({ ...DEV_ENV, NODE_ENV: undefined }));
check('...and under NODE_ENV=test', !trips({ ...DEV_ENV, NODE_ENV: 'test' }));
check('...and under NODE_ENV=staging', !trips({ ...DEV_ENV, NODE_ENV: 'staging' }));

// ── 2. A CORRECT PRODUCTION ENVIRONMENT IS ACCEPTED ────────────────────
console.log('\n── a correct production environment boots');
const cleanProd = capture(PROD_ENV);
check(
  'HSM/KMS-supplied production environment passes',
  cleanProd === undefined,
  cleanProd?.issues.join(' | '),
);
check(
  'a production env with ONLY NODE_ENV set passes (absence belongs to each loader)',
  !trips({ NODE_ENV: 'production' }),
);
check(
  'an empty-string secret is treated as absent, not as a bad value',
  !trips(withProd({ NATIONAL_ID_HMAC_KEY: '' })),
);

// ── 3. RULE 1 — committed dev secrets, both directions ─────────────────
console.log('\n── rule 1: committed dev key material');
const devKeyInProd = capture(withProd({ NATIONAL_ID_HMAC_KEY: DEV_NATIONAL_ID_HMAC_KEY }));
check('committed dev NATIONAL_ID_HMAC_KEY is refused in production', devKeyInProd !== undefined);
check(
  'the refusal names the variable',
  devKeyInProd?.message.includes('NATIONAL_ID_HMAC_KEY') === true,
);
check(
  'the refusal does NOT echo the secret value',
  devKeyInProd?.message.includes(DEV_NATIONAL_ID_HMAC_KEY) === false,
  'a boot error pasted into a ticket must not publish the key',
);
check('committed dev PII_ENCRYPTION_KEY is refused', trips(withProd({ PII_ENCRYPTION_KEY: DEV_PII_ENCRYPTION_KEY })));
check('committed dev NIDA_HMAC_SECRET is refused', trips(withProd({ NIDA_HMAC_SECRET: DEV_NIDA_HMAC_SECRET })));
check(
  'the dev QR_SIGNING_KEY_ID from run-selfchecks.sh is refused',
  trips(withProd({ QR_SIGNING_KEY_ID: 'selfcheck-qr-key-1' })),
);
check(
  'the dev MINIO_ENCRYPTION_KEY from run-selfchecks.sh is refused',
  trips(withProd({ MINIO_ENCRYPTION_KEY: 'dev_document_envelope_key_min_32_chars!!' })),
);
// THE OTHER DIRECTION: freshly minted material must pass, or `pnpm generate:env`
// output would be unusable in production and the guard would be routed around.
check(
  'a freshly minted key of the same shape is NOT refused',
  !trips(withProd({ NATIONAL_ID_HMAC_KEY: 'dev_national_id_hmac_key_min_32_charsXX' })),
);
check(
  'a value that merely CONTAINS a dev secret is not fingerprint-matched',
  !trips(withProd({ NATIONAL_ID_HMAC_KEY: `prefix-${DEV_NATIONAL_ID_HMAC_KEY}-suffix` })),
);

// ── 4. RULE 2 — placeholders, both directions ─────────────────────────
console.log('\n── rule 2: unreplaced placeholders');
check(
  'the placeholder is EXACTLY 32 chars — which is why a length floor cannot catch it',
  PLACEHOLDER_KEY.length === 32,
  `length was ${PLACEHOLDER_KEY.length}`,
);
const placeholderInProd = capture(withProd({ MINIO_ENCRYPTION_KEY: PLACEHOLDER_KEY }));
check('CHANGE_ME MINIO_ENCRYPTION_KEY is refused in production', placeholderInProd !== undefined);
check(
  'the refusal names MINIO_ENCRYPTION_KEY',
  placeholderInProd?.message.includes('MINIO_ENCRYPTION_KEY') === true,
);
check(
  'CHANGE_ME EDGE_SESSION_HMAC_KEY is refused',
  trips(withProd({ EDGE_SESSION_HMAC_KEY: 'CHANGE_ME_32_CHAR_MIN_EDGE_SESSION_HMAC_KEY' })),
);
check('a lower-cased change_me is still refused', trips(withProd({ SMTP_PASS: 'change_me' })));
check('REPLACE_ME is refused', trips(withProd({ NIDA_API_KEY: 'REPLACE_ME_WITH_REAL' })));
check(
  'a real secret that happens to contain the word "change" is NOT refused',
  !trips(withProd({ NIDA_API_KEY: 'exchange-rate-key-8871' })),
);

// ── 5. RULE 3 — loopback endpoints, both directions ────────────────────
console.log('\n── rule 3: loopback endpoints');
const loopbackDb = capture(withProd({ DATABASE_URL: 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db' }));
check('a localhost DATABASE_URL is refused in production', loopbackDb !== undefined);
check(
  'the loopback refusal does NOT echo the connection string (it holds a password)',
  loopbackDb?.message.includes('app_pw') === false,
);
check('localhost KAFKA_BROKERS is refused', trips(withProd({ KAFKA_BROKERS: 'localhost:29092' })));
check('127.0.0.1 is refused', trips(withProd({ NIDA_BASE_URL: 'http://127.0.0.1:3100' })));
check('a bare "localhost" host value is refused', trips(withProd({ MINIO_ENDPOINT: 'localhost' })));
check('host.docker.internal is refused', trips(withProd({ CLAMAV_HOST: 'host.docker.internal' })));
check('0.0.0.0 is refused', trips(withProd({ CLAMAV_HOST: '0.0.0.0' })));
// THE OTHER DIRECTION: the pattern is anchored, not a substring search. A guard
// with false positives gets switched off, and then it guards nothing.
check(
  'a real hostname containing "localhost" as a substring is NOT refused',
  !trips(withProd({ CLAMAV_HOST: 'notlocalhostish.gov.rw' })),
);
check(
  'a cluster-internal DNS name is NOT refused',
  !trips(withProd({ KAFKA_BROKERS: 'kafka-0.usrp.svc.cluster.local:9093' })),
);

// ── 6. RULE 4 — insecure toggles, both directions ─────────────────────
console.log('\n── rule 4: insecure toggles');
const ribMock = capture(withProd({ FEATURE_USE_RIB_MOCK: 'true' }));
check('FEATURE_USE_RIB_MOCK=true is refused in production', ribMock !== undefined);
check(
  'the refusal explains that every applicant would clear against fixtures',
  ribMock?.message.includes('fixtures') === true,
);
check('FEATURE_USE_NIDA_MOCK=true is refused', trips(withProd({ FEATURE_USE_NIDA_MOCK: 'true' })));
check('FEATURE_USE_NESA_MOCK=true is refused', trips(withProd({ FEATURE_USE_NESA_MOCK: 'true' })));
check('FEATURE_USE_HEC_MOCK=true is refused', trips(withProd({ FEATURE_USE_HEC_MOCK: 'true' })));
check('KAFKA_SSL=false is refused', trips(withProd({ KAFKA_SSL: 'false' })));
check('MINIO_USE_SSL=false is refused', trips(withProd({ MINIO_USE_SSL: 'false' })));
check('EDGE_COOKIE_SECURE=false is refused', trips(withProd({ EDGE_COOKIE_SECURE: 'false' })));
check('the boolean spelling "0" is understood as false', trips(withProd({ KAFKA_SSL: '0' })));
check('the boolean spelling "off" is understood as false', trips(withProd({ KAFKA_SSL: 'off' })));
check('the boolean spelling "yes" is understood as true', trips(withProd({ FEATURE_USE_RIB_MOCK: 'yes' })));
// THE OTHER DIRECTION.
check('FEATURE_USE_RIB_MOCK=false passes', !trips(withProd({ FEATURE_USE_RIB_MOCK: 'false' })));
check('KAFKA_SSL=true passes', !trips(withProd({ KAFKA_SSL: 'true' })));
check('EDGE_COOKIE_SECURE=true passes', !trips(withProd({ EDGE_COOKIE_SECURE: 'true' })));

// ── 7. AGGREGATION — one throw, every issue ──────────────────────────
console.log('\n── aggregation: fix every problem in one pass');
// The realistic disaster: someone set NODE_ENV=production on the dev template.
const everythingWrong = capture({ ...DEV_ENV, NODE_ENV: 'production' });
check('the dev template under NODE_ENV=production is refused', everythingWrong !== undefined);
check(
  'it reports MANY issues at once, not just the first',
  (everythingWrong?.issues.length ?? 0) >= 7,
  `got ${everythingWrong?.issues.length ?? 0}`,
);
check(
  'the aggregated message still leaks NO secret value',
  everythingWrong?.message.includes(DEV_NATIONAL_ID_HMAC_KEY) === false &&
    everythingWrong?.message.includes(DEV_PII_ENCRYPTION_KEY) === false,
);
check(
  'the issue count is reported in the message',
  everythingWrong?.message.includes(`${everythingWrong.issues.length} issue`) === true,
);

// ── 8. isProduction ──────────────────────────────────────────────
console.log('\n── isProduction');
check('"production" is production', isProduction({ NODE_ENV: 'production' }));
check('" PRODUCTION " is production (trimmed + case-insensitive)', isProduction({ NODE_ENV: ' PRODUCTION ' }));
check('"development" is not production', !isProduction({ NODE_ENV: 'development' }));
check('unset is not production', !isProduction({}));
check('"staging" is not production', !isProduction({ NODE_ENV: 'staging' }));

// ── 9. resolveEventTransport — all four quadrants ─────────────────────
console.log('\n── resolveEventTransport');
const devWithBroker = resolveEventTransport({ NODE_ENV: 'development', KAFKA_BROKERS: 'localhost:29092' });
check('dev + broker set → kafka', devWithBroker.kind === 'kafka');

const devNoBroker = resolveEventTransport({ NODE_ENV: 'development' });
check('dev + broker unset → in-memory (unchanged dev behaviour)', devNoBroker.kind === 'in-memory');
check(
  'the in-memory branch carries a reason for the log',
  devNoBroker.kind === 'in-memory' && devNoBroker.reason.length > 0,
);

const prodWithBroker = resolveEventTransport({ NODE_ENV: 'production', KAFKA_BROKERS: 'kafka-0.usrp.internal:9093' });
check('prod + broker set → kafka', prodWithBroker.kind === 'kafka');

let prodNoBrokerThrew: EnvValidationError | undefined;
try {
  resolveEventTransport({ NODE_ENV: 'production' });
} catch (err: unknown) {
  if (err instanceof EnvValidationError) prodNoBrokerThrew = err;
  else throw err;
}
check('prod + broker unset → THROWS (never a silent in-memory bus)', prodNoBrokerThrew !== undefined);
check(
  'the refusal explains that healthchecks would stay green',
  prodNoBrokerThrew?.message.includes('healthcheck') === true,
);
check(
  'an empty-string KAFKA_BROKERS is treated as unset, not as one empty broker',
  (() => {
    const t = resolveEventTransport({ NODE_ENV: 'development', KAFKA_BROKERS: '   ' });
    return t.kind === 'in-memory';
  })(),
);

// ── Summary ─────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ production-guard proof FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log('\n✓ production-guard proof passed');

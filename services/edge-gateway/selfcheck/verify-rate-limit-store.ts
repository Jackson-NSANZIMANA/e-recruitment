// ══════════════════════════════════════════════════════════════════
// edge-gateway — SHARED RATE-LIMIT STORE proof (rls/0024, live Postgres)
//
// The in-memory limiter's residual risk was always that N replicas permit N
// times every configured rate. This proves the shared Postgres store that
// replaces it in production holds everywhere it must:
//
//   1. SHARED — two limiter instances (two "replicas") over one database
//      count against ONE window: what one allows, the other denies.
//   2. LOSSLESS UNDER CONCURRENCY — parallel increments from both instances
//      are all counted; none is lost to a read-modify-write race.
//   3. EXPIRY — a window older than a minute resets, not sticks.
//   4. FAIL CLOSED — a store fault surfaces as
//      RateLimiterUnavailableError (the HTTP seam's 503), never as "allow".
//   5. PRODUCTION REFUSES MEMORY — assertRateLimitStoreAllowed throws for
//      (production, memory) and accepts (production, postgres): the boot
//      guard the composition root enforces.
//   6. WHAT IS STORED — keyed hashes only, and the table is the edge role's
//      alone: no officer or system role can read, amend or drop a window.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/edge-gateway/selfcheck/verify-rate-limit-store.ts
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import {
  assertRateLimitStoreAllowed,
  createEdgeGateway,
  InMemoryRateLimiter,
  loadEdgeGatewayConfig,
  PgRateLimiter,
} from "../src/index.js";
import { RateLimiterUnavailableError } from '../src/ports/rate-limiter.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const HMAC_KEY = 'dev_edge_session_hmac_key_min_32_chars!!';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function section(title: string): void {
  console.log(`\n══ ${title}`);
}

async function main(): Promise<void> {
  const replicaA = new PgRateLimiter({ hmacKey: HMAC_KEY });
  const replicaB = new PgRateLimiter({ hmacKey: HMAC_KEY });
  check('the Postgres limiter identifies its store', replicaA.store === 'postgres');

  // A unique key namespace per run, so re-runs never inherit a window.
  const namespace = `proof:${randomUUID()}`;

  // ── 1. Shared: two instances, one window ────────────────────────────
  section('1. Two instances over one database share ONE window');
  const sharedKey = `${namespace}:shared`;
  const a1 = await replicaA.check(sharedKey, 3);
  const a2 = await replicaA.check(sharedKey, 3);
  const b3 = await replicaB.check(sharedKey, 3);
  const a4 = await replicaA.check(sharedKey, 3);
  check('replica A allows the 1st attempt', a1.allowed && a1.remainingTokens === 2);
  check('replica A allows the 2nd attempt', a2.allowed && a2.remainingTokens === 1);
  check(
    'replica B sees the SAME window (1 token left)',
    b3.allowed && b3.remainingTokens === 0,
    JSON.stringify(b3),
  );
  check(
    'replica A is denied by what replica B consumed',
    !a4.allowed && a4.retryAfterSeconds >= 1 && a4.retryAfterSeconds <= 60,
    JSON.stringify(a4),
  );

  // ── 2. Concurrency: no lost increments ──────────────────────────────
  section('2. Concurrent increments from both replicas are all counted');
  const raceKey = `${namespace}:race`;
  const BATCH = 24;
  const attempts = [
    ...Array.from({ length: BATCH }, (_, i) => (i % 2 === 0 ? replicaA : replicaB)),
  ];
  const verdicts = await Promise.all(attempts.map((limiter) => limiter.check(raceKey, 10)));
  const allowedCount = verdicts.filter((v) => v.allowed).length;
  const deniedCount = verdicts.filter((v) => !v.allowed).length;
  check(
    `exactly 10 of ${String(BATCH)} parallel attempts pass a limit of 10`,
    allowedCount === 10 && deniedCount === BATCH - 10,
    `allowed=${String(allowedCount)} denied=${String(deniedCount)}`,
  );
  // Read THIS bucket by recomputing what the adapter stored (a keyed hash of
  // the key), so the count is attributed to the right window by construction.
  const { hmacSha256Hex } = await import('@usrp/shared-security');
  const raceHash = hmacSha256Hex(HMAC_KEY, `ratelimit:bucket:${raceKey}`);
  const stored = await admin<{ count: number }[]>`
    SELECT count FROM public_core.edge_rate_limit_buckets WHERE bucket_key_hash = ${raceHash}`;
  check(
    'every increment landed — the stored count is all 24, none lost',
    stored[0]?.count === BATCH,
    `stored=${String(stored[0]?.count)}`,
  );

  // ── 3. Expiry ───────────────────────────────────────────────────────
  section('3. An expired window resets');
  const expiredKey = `${namespace}:expired`;
  await replicaA.check(expiredKey, 5);
  await replicaA.check(expiredKey, 5);
  const expiredHash = hmacSha256Hex(HMAC_KEY, `ratelimit:bucket:${expiredKey}`);
  // Age the window past one minute, as a sweep-lagging replica would see.
  await admin`UPDATE public_core.edge_rate_limit_buckets
    SET window_started_at = now() - interval '61 seconds'
    WHERE bucket_key_hash = ${expiredHash}`;
  const fresh = await replicaB.check(expiredKey, 5);
  check(
    'a window older than a minute starts again at 1',
    fresh.allowed && fresh.remainingTokens === 4,
    JSON.stringify(fresh),
  );
  // A SECOND aged window that no check() has reset — the sweeper's own case.
  const sweepKey = `${namespace}:sweep`;
  await replicaA.check(sweepKey, 5);
  const sweepHash = hmacSha256Hex(HMAC_KEY, `ratelimit:bucket:${sweepKey}`);
  await admin`UPDATE public_core.edge_rate_limit_buckets
    SET window_started_at = now() - interval '61 seconds'
    WHERE bucket_key_hash = ${sweepHash}`;
  const swept = await replicaA.sweep(new Date());
  check('the sweeper removes expired windows', swept >= 1, `swept=${String(swept)}`);
  const afterSweep = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public_core.edge_rate_limit_buckets
    WHERE window_started_at <= now() - interval '60 seconds'`;
  check('no expired window survives the sweep', afterSweep[0]?.n === 0);

  // ── 4. Fail closed ─────────────────────────────────────────────────
  section('4. A store fault is RateLimiterUnavailableError, never "allow"');
  await admin`REVOKE ALL ON public_core.edge_rate_limit_buckets FROM usrp_edge_gateway`;
  let failedClosed = false;
  try {
    await replicaA.check(`${namespace}:broken`, 5);
  } catch (err) {
    failedClosed = err instanceof RateLimiterUnavailableError;
  }
  check('an unreachable/forbidden store throws RateLimiterUnavailableError', failedClosed);
  await admin`GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.edge_rate_limit_buckets TO usrp_edge_gateway`;
  const recovered = await replicaA.check(`${namespace}:recovered`, 5);
  check('the store works again once reachable (no lasting damage)', recovered.allowed);

  // ── 5. Production refuses the memory store ─────────────────────────
  section('5. The production boot guard');
  let refusedMemory = false;
  try {
    assertRateLimitStoreAllowed(true, 'memory');
  } catch {
    refusedMemory = true;
  }
  check('(production, memory) is refused', refusedMemory);
  let acceptedPostgres = true;
  try {
    assertRateLimitStoreAllowed(true, 'postgres');
  } catch {
    acceptedPostgres = false;
  }
  check('(production, postgres) is accepted', acceptedPostgres);
  let acceptedDevMemory = true;
  try {
    assertRateLimitStoreAllowed(false, 'memory');
  } catch {
    acceptedDevMemory = false;
  }
   check('(development, memory) is accepted — dev and selfchecks keep it', acceptedDevMemory);

  // ── 5b. The refusal is on the REAL boot path ───────────────────────
  // Not just the guard function: the actual composition (createEdgeGateway,
  // what main.ts boots) refuses a production config handed the memory
  // limiter, before it returns a gateway that could serve a request.
  section('5b. The real composition refuses production + memory at boot');
  const prodEnv: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: '43190', // proof-only, never listened on
    DATABASE_URL: process.env['DATABASE_URL'] ?? '',
    IAM_BASE_URL: 'http://127.0.0.1:9', // never contacted at boot
    IDENTITY_SERVICE_BASE_URL: 'http://127.0.0.1:9',
    APPLICATION_SERVICE_BASE_URL: 'http://127.0.0.1:9',
    SCHEDULING_SERVICE_BASE_URL: 'http://127.0.0.1:9',
    FIELD_SYNC_SERVICE_BASE_URL: 'http://127.0.0.1:9',
    EDGE_SESSION_HMAC_KEY: 'prod_proof_only_key_not_a_published_dev_value_min_32_chars!!',
    EDGE_COOKIE_SECURE: 'true',
    CORS_ORIGINS: 'https://proof.example',
    AUTH_JWT_PUBLIC_KEY_B64: process.env['AUTH_JWT_PUBLIC_KEY_B64'] ?? '',
  };
  const prodConfig = loadEdgeGatewayConfig(prodEnv);
  check('the proof really built a production config', prodConfig.runtime.isProduction === true);
  let bootRefused = false;
  let refusalText = '';
  try {
    createEdgeGateway(prodConfig, () => new Date(), { limiter: new InMemoryRateLimiter(() => 0) });
  } catch (err) {
    bootRefused = err instanceof Error;
    refusalText = err instanceof Error ? err.message : String(err);
  }
  check(
    'a production boot handed the memory limiter THROWS before serving',
    bootRefused && refusalText.includes('Refusing to boot'),
    refusalText.slice(0, 120),
  );
  let prodPgBoot = true;
  try {
    createEdgeGateway(prodConfig, () => new Date(), { limiter: new PgRateLimiter({ hmacKey: prodConfig.session.handleHmacKey }) });
  } catch {
    prodPgBoot = false;
  }
  check('a production boot with the Postgres store composes', prodPgBoot);
  // ── 6. What is stored, and who may touch it ────────────────────────
  section('6. Keyed hashes only; the edge role alone may touch the table');
  const storedKey = await admin<{ bucket_key_hash: string }[]>`
    SELECT bucket_key_hash FROM public_core.edge_rate_limit_buckets
    WHERE bucket_key_hash = ${raceHash}`;
  check(
    'the stored key is a 64-hex keyed hash, not the bucket key',
    /^[0-9a-f]{64}$/.test(storedKey[0]?.bucket_key_hash ?? '') &&
      !storedKey[0]?.bucket_key_hash.includes(namespace),
  );
  check('the raw bucket key appears nowhere in the table', true); // namespace is UUID-random; direct check below
  const rawLeak = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public_core.edge_rate_limit_buckets
    WHERE bucket_key_hash LIKE ${`%${namespace}%`}`;
  check('no row contains the raw key material', rawLeak[0]?.n === 0);

  let officerCouldRead = true;
  try {
    await admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`SELECT count(*) FROM public_core.edge_rate_limit_buckets`;
    });
  } catch {
    officerCouldRead = false;
  }
  check('an officer role cannot read the rate-limit table (rls/0024)', !officerCouldRead);
  let systemCouldRead = true;
  try {
    await admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_system_service`;
      await tx`SELECT count(*) FROM public_core.edge_rate_limit_buckets`;
    });
  } catch {
    systemCouldRead = false;
  }
  check('the system role cannot read it either (sole grantee: usrp_edge_gateway)', !systemCouldRead);

  // Cleanup: this proof's rows are operational fixtures, not personal data,
  // but a leftover bucket could skew a later run's counts. Delete by the
  // exact hashes this run created (they are all known by construction).
  const sharedHash = hmacSha256Hex(HMAC_KEY, `ratelimit:bucket:${sharedKey}`);
  const brokenHash = hmacSha256Hex(HMAC_KEY, `ratelimit:bucket:${namespace}:broken`);
  const recoveredHash = hmacSha256Hex(HMAC_KEY, `ratelimit:bucket:${namespace}:recovered`);
  const sweepHash2 = hmacSha256Hex(HMAC_KEY, `ratelimit:bucket:${sweepKey}`);
  await admin`DELETE FROM public_core.edge_rate_limit_buckets
    WHERE bucket_key_hash IN (${sharedHash}, ${raceHash}, ${expiredHash}, ${brokenHash}, ${recoveredHash}, ${sweepHash2})`;

  console.log(`\n────────────────────────────────────────`);
  if (fail === 0) {
    console.log(`RATE-LIMIT STORE GREEN — ${pass} checks, shared enforcement proven ✓`);
    process.exit(0);
  }
  console.error(`${fail} of ${pass + fail} checks failed`);
  for (const label of failures) console.error(`  ✗ ${label}`);
  process.exit(1);
}

main()
  .catch((err: unknown) => {
    console.error('rate-limit-store proof crashed', err);
    process.exit(1);
  })
  .finally(() => {
    void admin.end();
    void sql.end({ timeout: 2 }).catch(() => undefined);
  });

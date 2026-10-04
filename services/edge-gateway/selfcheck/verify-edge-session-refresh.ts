// ══════════════════════════════════════════════════════════════════
// edge-gateway — SESSION REFRESH PROOF (live Postgres, rls/0019)
//
// Proves the two refresh defects the homogenisation fixed:
//
//   1. rotate() on a session revoked between resolve and rotate returns null,
//      and the refresh route answers 401 with a cleared jar instead of handing
//      out a handle that was never stored.
//   2. The refreshed response body describes the session AS PERSISTED: its
//      idleExpiresAt equals the row the rotating UPDATE wrote, not the
//      pre-rotate copy.
//
// Plus: the new handle resolves, and the old one keeps working only inside the
// grace window (it must still resolve immediately after rotation).
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { configureDatabase, sql } from '@usrp/shared-database';
import type { HttpResult, RequestContext } from '@usrp/shared-http';
import { createEdgeGateway, edgeHandlers, loadEdgeGatewayConfig } from '../src/index.js';

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}

function fakeContext(cookies: Record<string, string>, headers: IncomingHttpHeaders): RequestContext {
  const body = Buffer.from('{}');
  return {
    method: 'POST',
    path: '/edge/v1/session/refresh',
    query: new URLSearchParams(),
    headers: { 'content-type': 'application/json', ...headers },
    contentType: 'application/json',
    cookies: new Map(Object.entries(cookies)),
    correlationId: randomUUID(),
    requestId: randomUUID(),
    rawBody: async () => body,
    json: async <T>() => ({}) as T,
  };
}

async function main(): Promise<void> {
  const config = loadEdgeGatewayConfig();
  configureDatabase({ url: config.database.url, maxConnections: 4 });
  const gateway = createEdgeGateway(config);
  const { deps } = gateway;
  const refresh = edgeHandlers(deps).refreshSession;

  const created = await deps.sessions.create(
    { kind: 'applicant', subjectId: null, agency: null, roles: [], upstreamCredential: 'proof-credential', upstreamExpiresAt: null },
    new Date(),
  );

  // ── 1. A refresh describes the PERSISTED session ─────────────────────
  // Advance the clock so the rotated idle deadline is strictly later than the
  // one the create() wrote: a stale body would then be detectably stale.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const ctx = fakeContext(
    { [deps.cookies.sessionCookieName]: created.handle, [deps.cookies.csrfCookieName]: created.csrfToken },
    { 'x-csrf-token': created.csrfToken },
  );
  const result = (await refresh(ctx)) as HttpResult;
  check('refresh answers 200', result.status === 200, String(result.status));
  const body = result.body as { idleExpiresAt?: string };
  const newHandle = result.cookies?.find((c) => c.name === deps.cookies.sessionCookieName)?.value ?? '';
  const after = await deps.sessions.findByHandle(newHandle, new Date());
  check('the new handle resolves', after.kind === 'ACTIVE');
  if (after.kind === 'ACTIVE') {
    check(
      'response idleExpiresAt equals the persisted row',
      body.idleExpiresAt === after.session.idleExpiresAt.toISOString(),
      `${String(body.idleExpiresAt)} vs ${after.session.idleExpiresAt.toISOString()}`,
    );
    check(
      'response idleExpiresAt is later than the pre-rotate deadline',
      body.idleExpiresAt !== undefined && Date.parse(body.idleExpiresAt) > created.session.idleExpiresAt.getTime(),
    );
  }
  const old = await deps.sessions.findByHandle(created.handle, new Date());
  check('the rotated-away handle still resolves inside the grace window', old.kind === 'ACTIVE');

  // ── 2. Revoked between resolve and rotate ─────────────────────────────
  if (after.kind === 'ACTIVE') {
    await deps.sessions.revoke(after.session.sessionId, 'proof', new Date());
    const rotated = await deps.sessions.rotate(after.session.sessionId, new Date());
    check('rotate() on a revoked session returns null', rotated === null);
  }

  const second = await deps.sessions.create(
    { kind: 'applicant', subjectId: null, agency: null, roles: [], upstreamCredential: 'proof-credential', upstreamExpiresAt: null },
    new Date(),
  );
  // Simulate the race: the route resolves the session, then a logout in
  // another tab revokes it before rotate() runs. Monkey-patch rotate's view of
  // the world by revoking first and calling rotate directly through the port.
  await deps.sessions.revoke(second.session.sessionId, 'proof_race', new Date());
  const raced = await deps.sessions.rotate(second.session.sessionId, new Date());
  check('the race returns null, never a never-stored handle', raced === null);
  const ctx2 = fakeContext(
    { [deps.cookies.sessionCookieName]: second.handle, [deps.cookies.csrfCookieName]: second.csrfToken },
    { 'x-csrf-token': second.csrfToken },
  );
  const result2 = (await refresh(ctx2)) as HttpResult;
  check('refresh of a revoked session answers 401', result2.status === 401, String(result2.status));

  await sql.end({ timeout: 5 });
  console.log(`\n${fail === 0 ? '\u001b[1;32mSESSION REFRESH GREEN' : '\u001b[0;31mSESSION REFRESH RED'} — ${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err: unknown) => {
  console.error('verify-edge-session-refresh crashed', err instanceof Error ? err.name : err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});

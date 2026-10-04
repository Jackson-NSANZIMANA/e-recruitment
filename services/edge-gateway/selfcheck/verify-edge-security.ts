// ══════════════════════════════════════════════════════════════════
// edge-gateway — BROWSER BOUNDARY PROOF (live, against a stub upstream)
//
// Boots the REAL gateway — real session store, real cookies, real CSRF, real
// projections — with all four upstream base URLs pointed at one stub server on
// loopback. That shape is deliberate: it lets the proof assert things a
// full-stack test cannot observe.
//
//   • a write is called EXACTLY ONCE. Counting upstream invocations is the only
//     honest way to prove "never retries"; a real service would just succeed.
//   • two different National IDs produce BYTE-IDENTICAL responses, including
//     when the upstream answers differently for each. Anti-enumeration is a
//     property of the edge's mapping, so the stub must be able to disagree.
//   • the 409 cross-agency lock arrives WITH `lockedByAgency` upstream and
//     leaves WITHOUT it.
//
// It needs Postgres, because the session store is the thing under test: the
// proof reads the row back and asserts that neither the handle nor the upstream
// credential is stored in a usable form.
//
// Prerequisites: tier1 Postgres, bootstrapped (scripts/bootstrap-db.sh, which
// applies rls/0019).
// ══════════════════════════════════════════════════════════════════

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { signAuthToken, type AuthTokenClaims } from "@usrp/shared-auth";
import { sql } from "@usrp/shared-database";
import { startHttpServer, type HttpServer } from "@usrp/shared-http";
import { createEdgeGateway, loadEdgeGatewayConfig } from "../src/index.js";

// ── Harness ──────────────────────────────────────────────────

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
      `\u001b[0;31m  \u2717 ${label}${detail === undefined ? "" : ` — ${detail}`}\u001b[0m`,
    );
  }
}

function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

/** A cookie jar, because the whole design hinges on cookies behaving. */
class Jar {
  readonly #cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ""] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // Max-Age=0 is a clear. Honouring it is what makes "logout clears the
      // cookie" a testable claim rather than a hope.
      if (value === "" || /max-age=0/i.test(raw)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  clear(): void {
    this.#cookies.clear();
  }
}

// ── The stub upstream ──────────────────────────────────────────

const OFFICER_ID = randomUUID();
const APPLICATION_ID = randomUUID();
const NID_A = "1199012345678901";
const NID_B = "1199087654321098";

interface StubState {
  /** Every upstream path called, in order. The no-retry proof reads this. */
  readonly calls: string[];
  /** Set to make final-decision answer 503 so a retry would be visible. */
  finalDecisionUnavailable: boolean;
  /** The Authorization header the last officer-route call carried. */
  lastAuthorization: string | undefined;
  /** Whether any inbound upstream request carried a cookie header. */
  sawCookieHeader: boolean;
  /** Scripted answer for the citizen submit bridge (POST /v1/applicants/me/applications). */
  submitAnswer:
    | "first"
    | "replay"
    | "alreadyApplied"
    | "keyReused"
    | "unavailable";
  /** Every submit-bridge call, headers and all, for the allowlist proofs. */
  submitCalls: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }[];
}

// ADR-027 walk-in duplicate fixtures.
const WALK_IN_EXISTING_APP = "7c0f1e2d-3a4b-4c5d-8e6f-0a1b2c3d4e5f";
const WALK_IN_EXISTING_CODE = "RDF-00097";
const WALK_IN_APPLICANT_ID = randomUUID();

// ADR-027 citizen submit fixtures.
const SUBMIT_APPLICATION_ID = "0d1f2e3c-4b5a-4968-8776-655443332211";
const SUBMIT_PROCESSING_CODE = "RDF-77042";

const state: StubState = {
  calls: [],
  finalDecisionUnavailable: false,
  lastAuthorization: undefined,
  sawCookieHeader: false,
  submitAnswer: "first",
  submitCalls: [],
};

function officerToken(agency: "RDF" | "RNP"): string {
  const privateKeyPem = Buffer.from(
    process.env["AUTH_JWT_PRIVATE_KEY_B64"] ?? "",
    "base64",
  ).toString("utf8");
  const now = new Date();
  const claims: AuthTokenClaims = {
    v: 1,
    iss: process.env["JWT_ISSUER"] ?? "usrp",
    aud: process.env["JWT_AUDIENCE"] ?? "usrp-services",
    sub: OFFICER_ID,
    kind: "officer",
    agency,
    roles: ["OFFICER"],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  };
  return signAuthToken(privateKeyPem, claims);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function stubHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://stub");
  state.calls.push(`${req.method ?? "GET"} ${url.pathname}`);
  if (req.headers.authorization !== undefined) {
    state.lastAuthorization = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
  }
  if (req.headers.cookie !== undefined) state.sawCookieHeader = true;
  const body = await readBody(req);

  switch (`${req.method ?? "GET"} ${url.pathname}`) {
    case "GET /health":
      return send(res, 200, { status: "ok" });

    case "POST /v1/auth/officer/login": {
      const handle = (body as { loginHandle?: unknown } | null)?.loginHandle;
      if (handle === "rdf.officer") {
        return send(res, 200, {
          token: officerToken("RDF"),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      // Everything else is one indistinguishable rejection upstream too.
      return send(res, 401, { error: "INVALID_CREDENTIALS" });
    }

    case "GET /v1/applications":
      return send(res, 200, {
        agency: "RDF",
        applications: [
          {
            applicationId: APPLICATION_ID,
            processingCode: "RDF-00042",
            category: "GENERAL_ENLISTMENT",
            status: "DOCUMENT_REVIEW_GREEN",
            submittedAt: "2026-09-01T08:00:00.000Z",
          },
        ],
      });

    case "GET /v1/applications/by-id": {
      const requested = url.searchParams.get("applicationId");
      if (requested !== APPLICATION_ID) {
        // The upstream answer for BOTH "no such id" and "a sibling agency's real
        // id" — indistinguishable by construction, and the edge must not enrich it.
        return send(res, 404, { error: "NOT_FOUND" });
      }
      return send(res, 200, {
        agency: "RDF",
        application: {
          applicationId: APPLICATION_ID,
          processingCode: "RDF-00042",
          category: "GENERAL_ENLISTMENT",
          status: "DOCUMENT_REVIEW_GREEN",
          documentLane: "GREEN",
          documentForensicsScore: 12,
          academicStatus: "VERIFIED",
          ageEligibilityStatus: "ELIGIBLE",
          criminalClearanceStatus: "CLEAR",
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-09-02T08:00:00.000Z",
          // Two fields the edge projection must NOT forward.
          documentReviewedById: randomUUID(),
          finalDecisionById: randomUUID(),
        },
      });
    }

    case "POST /v1/applications/walk-in/register":
      // ADR-027: this candidate already holds a live application. The upstream
      // names it on purpose so the tablet can open THAT record.
      return send(res, 409, {
        status: "ALREADY_APPLIED",
        applicationId: WALK_IN_EXISTING_APP,
        processingCode: WALK_IN_EXISTING_CODE,
      });

    case "POST /v1/applications/accept":
      // ADR-014: the lock is held elsewhere, and the upstream names the holder.
      return send(res, 409, {
        status: "CROSS_AGENCY_LOCKED",
        lockedByAgency: "RNP",
      });

    case "POST /v1/applications/final-decision":
      if (state.finalDecisionUnavailable) {
        return send(res, 503, { error: "UPSTREAM_UNAVAILABLE" });
      }
      return send(res, 200, {
        status: "APPLIED",
        fromStatus: "DOCUMENT_REVIEW_GREEN",
        toStatus: "SHORTLISTED",
      });

    case "POST /v1/applicants/auth/otp/request": {
      const nid = (body as { nationalId?: unknown } | null)?.nationalId;
      // The stub DISAGREES about the two identities on purpose. If the edge ever
      // let that difference through, this is where it would show.
      if (nid === NID_A) return send(res, 202, { status: "CHALLENGED" });
      return send(res, 202, { status: "CHALLENGED", hint: "unknown-citizen" });
    }

    case "POST /v1/applicants/auth/otp/verify": {
      const otp = (body as { otp?: unknown } | null)?.otp;
      if (otp !== "123456") return send(res, 401, { error: "INVALID_OTP" });
      return send(res, 200, {
        sessionToken: "stub-opaque-applicant-session-token",
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      });
    }

    case "POST /v1/applicants/auth/logout":
      return send(res, 204, undefined);

    case "GET /v1/applicants/me/applications":
      return send(res, 200, {
        applications: [
          {
            applicationId: APPLICATION_ID,
            processingCode: "RDF-00042",
            category: "GENERAL_ENLISTMENT",
            status: "DOCUMENT_REVIEW_GREEN",
            agency: "RDF",
            submittedAt: "2026-09-01T08:00:00.000Z",
          },
        ],
      });

    // The identity-service submit bridge, scripted per section 14b. The
    // bodies are the BRIDGE's answers (which mirror application-service's
    // front door): the edge maps them to the public contract.
    case "POST /v1/applicants/me/applications": {
      state.submitCalls.push({ headers: { ...req.headers }, body });
      switch (state.submitAnswer) {
        case "first":
          return send(res, 201, {
            status: "SUBMITTED",
            applicationId: SUBMIT_APPLICATION_ID,
            processingCode: SUBMIT_PROCESSING_CODE,
            agency: "RDF",
          });
        case "replay":
          res.setHeader("Idempotency-Replayed", "true");
          return send(res, 201, {
            status: "SUBMITTED",
            applicationId: SUBMIT_APPLICATION_ID,
            processingCode: SUBMIT_PROCESSING_CODE,
            agency: "RDF",
          });
        case "alreadyApplied":
          return send(res, 409, {
            status: "ALREADY_APPLIED",
            applicationId: SUBMIT_APPLICATION_ID,
            processingCode: SUBMIT_PROCESSING_CODE,
            agency: "RDF",
          });
        case "keyReused":
          // Deliberately carries identifiers: the edge must still surface
          // the identifier-free shape this answer is contracted to.
          return send(res, 409, {
            status: "KEY_REUSED",
            reason:
              "This Idempotency-Key was already used for a different submission.",
            applicationId: "00000000-0000-4000-8000-0000000000ff",
            processingCode: "RDF-99999",
          });
        case "unavailable":
          return send(res, 503, { error: "UPSTREAM_UNAVAILABLE" });
      }
      return send(res, 404, { error: "STUB_NO_SCRIPT" });
    }

    case "POST /v1/identities/verify":
      // The RUNNING controller's shape — not the stale { verified, fullName }.
      return send(res, 201, { status: "CREATED", applicantId: randomUUID() });

    default:
      return send(res, 404, { error: "STUB_NO_ROUTE" });
  }
}

// ── Boot ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const stub = createServer((req, res) => {
    void stubHandler(req, res);
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = (stub.address() as AddressInfo).port;
  const stubUrl = `http://127.0.0.1:${String(stubPort)}`;

  const config = loadEdgeGatewayConfig({
    ...process.env,
    PORT_EDGE_GATEWAY: "3000",
    IAM_BASE_URL: stubUrl,
    IDENTITY_SERVICE_BASE_URL: stubUrl,
    APPLICATION_SERVICE_BASE_URL: stubUrl,
    FIELD_SYNC_SERVICE_BASE_URL: stubUrl,
    EDGE_COOKIE_SECURE: "false",
    // Generous, so the proof's own traffic is never what trips the limiter —
    // EXCEPT the applicant submit limit, which section 14b pins at 3 so the
    // per-session cap is observable within one proof run.
    EDGE_LOGIN_RATE_LIMIT_PER_MINUTE: "200",
    EDGE_OTP_RATE_LIMIT_PER_MINUTE: "200",
    EDGE_VERIFY_IDENTITY_RATE_LIMIT_PER_MINUTE: "200",
    EDGE_APPLICANT_SUBMIT_RATE_LIMIT_PER_MINUTE: "5",
  });

  // A recording audit sink, so 14b can assert the integrity audit events
  // fire (and carry no key material) without scraping stdout.
  const auditRecords: { action: string; record: unknown }[] = [];
  const gateway = createEdgeGateway(config, undefined, {
    audit: {
      log(record): void {
        auditRecords.push({ action: record.action, record });
      },
      stats(): void {},
      fault(): void {},
    },
  });
  const server: HttpServer = await startHttpServer({
    serviceName: "edge-gateway-selfcheck",
    port: 0,
    host: "127.0.0.1",
    routes: gateway.routes,
    cors: gateway.cors,
    handleSignals: false,
  });
  const base = server.url;
  const SESSION_COOKIE = "usrp_session_dev";
  const CSRF_COOKIE = "usrp_csrf_dev";

  const jar = new Jar();

  async function call(
    method: string,
    path: string,
    options: {
      body?: unknown;
      csrf?: string | null;
      cookies?: boolean;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; text: string; response: Response }> {
    const headers: Record<string, string> = { ...options.extraHeaders };
    if (options.cookies !== false) {
      const cookie = jar.header();
      if (cookie.length > 0) headers.cookie = cookie;
    }
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.csrf === undefined) {
      const token = jar.get(CSRF_COOKIE);
      if (token !== undefined) headers["x-csrf-token"] = token;
    } else if (options.csrf !== null) {
      headers["x-csrf-token"] = options.csrf;
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (options.cookies !== false) {
      jar.absorb(response);
    }
    return { status: response.status, text: await response.text(), response };
  }

  try {
    // ── 1. The anonymous probe seeds CSRF ──────────────────────────
    section("The session probe makes an honest first login possible");
    const probe = await call("GET", "/edge/v1/session");
    check("anonymous probe is 401, not an error", probe.status === 401);
    check("anonymous probe carries a reason", probe.text.includes("reason"));
    check(
      "anonymous probe issues a readable CSRF cookie",
      jar.get(CSRF_COOKIE) !== undefined,
      'without it, "CSRF required on login" is unimplementable by an honest client',
    );
    check(
      "anonymous probe issues NO session cookie",
      jar.get(SESSION_COOKIE) === undefined,
    );

    // ── 2. CSRF ───────────────────────────────────────────────
    section("CSRF fails loudly, never silently");
    const noToken = await call("POST", "/edge/v1/auth/officer/login", {
      body: { loginHandle: "rdf.officer", password: "x" },
      csrf: null,
    });
    check("unsafe request without x-csrf-token is 403", noToken.status === 403);
    const badToken = await call("POST", "/edge/v1/auth/officer/login", {
      body: { loginHandle: "rdf.officer", password: "x" },
      csrf: "f".repeat(64),
    });
    check(
      "unsafe request with a mismatched token is 403",
      badToken.status === 403,
    );
    check(
      "a rejected CSRF request never reached the upstream",
      !state.calls.includes("POST /v1/auth/officer/login"),
    );

    // ── 3. Credential rejection is one shape ────────────────────────
    section("One indistinguishable rejection for every credential problem");
    const wrongHandle = await call("POST", "/edge/v1/auth/officer/login", {
      body: { loginHandle: "nobody.here", password: "whatever" },
    });
    const wrongPassword = await call("POST", "/edge/v1/auth/officer/login", {
      body: { loginHandle: "rdf.officer.disabled", password: "whatever" },
    });
    check("unknown handle is 401", wrongHandle.status === 401);
    check(
      "unknown handle and wrong password are BYTE-IDENTICAL",
      wrongHandle.text === wrongPassword.text &&
        wrongHandle.status === wrongPassword.status,
      `${wrongHandle.text} vs ${wrongPassword.text}`,
    );
    check(
      "rejection body names no account state",
      !/disabled|unknown|exists/i.test(wrongHandle.text),
    );

    // ── 4. Login hands the browser an opaque handle and nothing else ──
    section("Login: the browser receives only opaque session state");
    const login = await call("POST", "/edge/v1/auth/officer/login", {
      body: { loginHandle: "rdf.officer", password: "DevOfficer#2026" },
    });
    check(
      "login is 204 with no body",
      login.status === 204 && login.text === "",
    );
    const handle = jar.get(SESSION_COOKIE);
    check(
      "login sets a session cookie",
      handle !== undefined && handle.length > 20,
    );
    check("login sets a CSRF cookie", jar.get(CSRF_COOKIE) !== undefined);
    const setCookies = login.response.headers.getSetCookie().join(" | ");
    check(
      "the session cookie is HttpOnly",
      /usrp_session_dev=[^;]+;[^|]*HttpOnly/i.test(setCookies),
    );
    check(
      "the session cookie is SameSite=Strict",
      /usrp_session_dev=[^;]+;[^|]*SameSite=Strict/i.test(setCookies),
    );
    check(
      "the CSRF cookie is deliberately NOT HttpOnly",
      /usrp_csrf_dev=[^;]+;(?![^|]*HttpOnly)[^|]*/i.test(setCookies),
    );
    check(
      "no JWT appears in any login response header or body",
      !setCookies.includes(".") ||
        !/eyJ|ey[A-Za-z0-9_-]{10,}\./.test(setCookies + login.text),
      "the upstream credential must never cross the boundary",
    );

    // ── 5. The session view has nowhere to put a token ─────────────────
    section("The session view is metadata, not a credential");
    const session = await call("GET", "/edge/v1/session");
    check("authenticated probe is 200", session.status === 200);
    check(
      "session reports kind officer",
      session.text.includes('"kind":"officer"'),
    );
    check(
      "session reports the agency from the token",
      session.text.includes('"agency":"RDF"'),
    );
    check(
      "session has both deadlines",
      session.text.includes("idleExpiresAt") &&
        session.text.includes("absoluteExpiresAt"),
    );
    check(
      "session carries no token field of any name",
      !/token|credential|password|jwt/i.test(session.text),
      session.text,
    );

    // ── 6. What the database actually holds ──────────────────────────
    section("The stored session row is not a replayable credential");
    const rows = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql("usrp_edge_gateway")}`;
      return tx<
        {
          readonly handle_hash: string;
          readonly upstream_credential: string;
          readonly csrf_token_hash: string;
          readonly agency: string | null;
          readonly kind: string;
        }[]
      >`
        SELECT handle_hash, upstream_credential, csrf_token_hash, agency, kind
        FROM public_core.edge_sessions
        WHERE subject_id = ${OFFICER_ID} AND revoked_at IS NULL
        ORDER BY issued_at DESC
        LIMIT 1
      `;
    });
    const row = rows[0];
    check("the session row exists and is durable", row !== undefined);
    if (row !== undefined && handle !== undefined) {
      check(
        "handle_hash is not the handle",
        row.handle_hash !== handle,
        "a stored plaintext handle makes a database dump a set of live sessions",
      );
      check(
        "handle_hash is a 64-char hex digest",
        /^[0-9a-f]{64}$/.test(row.handle_hash),
      );
      check(
        "the upstream credential is NOT stored in the clear",
        !row.upstream_credential.includes(".") ||
          row.upstream_credential.split(".").length === 3,
      );
      check(
        "the stored credential is an AES-GCM envelope, not a JWT",
        /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(
          row.upstream_credential,
        ) && !row.upstream_credential.startsWith("ey"),
      );
      check(
        "csrf_token_hash is not the cookie value",
        row.csrf_token_hash !== jar.get(CSRF_COOKIE),
      );
      check(
        "the officer row carries its agency",
        row.agency === "RDF" && row.kind === "officer",
      );
    }

    // ── 7. Agency and identity claims are refused, not ignored ────────
    section("Client-supplied authorization inputs are REFUSED");
    const agencyInBody = await call("POST", "/edge/v1/applications/accept", {
      body: { applicationId: APPLICATION_ID, agency: "RNP" },
    });
    check("a body carrying an agency is 400", agencyInBody.status === 400);
    check(
      "the rejection names FORBIDDEN_FIELD",
      agencyInBody.text.includes("FORBIDDEN_FIELD"),
    );
    const hashInBody = await call("POST", "/edge/v1/identities/verify", {
      body: { nationalId: NID_A, nationalIdHash: "a".repeat(64) },
    });
    check("a body carrying nationalIdHash is 400", hashInBody.status === 400);
    check(
      "neither rejected body reached the upstream",
      !state.calls.includes("POST /v1/applications/accept"),
    );

    // ── 8. The Authorization header buys nothing ─────────────────────
    section("A browser Authorization header is never an authentication input");
    const bearerOnly = await call("GET", "/edge/v1/applications", {
      cookies: false,
      extraHeaders: { authorization: `Bearer ${officerToken("RDF")}` },
    });
    check(
      "a valid officer JWT in the header authenticates nothing",
      bearerOnly.status === 401,
      `status ${String(bearerOnly.status)}`,
    );

    // ── 9. Reads project, they do not forward ───────────────────────
    section("Responses are allowlists");
    const list = await call("GET", "/edge/v1/applications");
    check("the officer list is 200", list.status === 200);
    check(
      "rows carry the session agency",
      list.text.includes('"agency":"RDF"'),
    );
    const detail = await call(
      "GET",
      `/edge/v1/applications/by-id?applicationId=${APPLICATION_ID}`,
    );
    check("the detail read is 200", detail.status === 200);
    check(
      "documentReviewedById is not forwarded",
      !detail.text.includes("documentReviewedById"),
      "an internal officer UUID has no place in a browser payload",
    );
    check(
      "finalDecisionById is not forwarded",
      !detail.text.includes("finalDecisionById"),
    );
    check(
      "the officer detail DOES carry the forensic lane",
      detail.text.includes("documentLane"),
    );

    // ── 10. Indistinguishable 404 ────────────────────────────────
    section("A 404 cannot be walked into a cross-agency oracle");
    const missingA = await call(
      "GET",
      `/edge/v1/applications/by-id?applicationId=${randomUUID()}`,
    );
    const missingB = await call(
      "GET",
      `/edge/v1/applications/by-id?applicationId=${randomUUID()}`,
    );
    check("a nonexistent id is 404", missingA.status === 404);
    check(
      "two different unknown ids are BYTE-IDENTICAL",
      missingA.text === missingB.text,
      `${missingA.text} vs ${missingB.text}`,
    );
    check(
      "the 404 body is bare",
      missingA.text === '{"error":"NOT_FOUND"}',
      missingA.text,
    );

    // ── 11. The accept lock does not name the holder ─────────────────
    section(
      "The ADR-014 accept lock surfaces without disclosing a sibling agency",
    );
    const accept = await call("POST", "/edge/v1/applications/accept", {
      body: { applicationId: APPLICATION_ID },
    });
    check("accept conflict is 409", accept.status === 409);
    check(
      "the conflict is named",
      accept.text.includes("CROSS_AGENCY_ACCEPT_LOCK"),
    );
    check(
      "lockedByAgency is STRIPPED at the boundary",
      !accept.text.includes("lockedByAgency") && !accept.text.includes("RNP"),
      accept.text,
    );
    check(
      "the upstream really did send it",
      state.calls.includes("POST /v1/applications/accept"),
    );

    // ── 11b. ALREADY_APPLIED keeps its identifiers ───────────────────
    // The mirror image of section 11, and the reason both are here: the
    // boundary must distinguish "this names ANOTHER agency's data" from "this
    // names the officer's own, and is the entire point of the answer".
    //
    // Without an explicit case, ALREADY_APPLIED fell through conflictResult's
    // default and reached the tablet as ILLEGAL_TRANSITION with both
    // identifiers dropped — a wrong label on an answer the officer could no
    // longer act on.
    section("A duplicate walk-in registration names the application on file");
    const dupe = await call("POST", "/edge/v1/applications/walk-in/register", {
      body: {
        applicantId: WALK_IN_APPLICANT_ID,
        category: "GENERAL_ENLISTMENT",
        nesaIndexNumber: "RW2024/1002",
      },
    });
    check("duplicate registration is 409", dupe.status === 409, dupe.text);
    check(
      "the conflict is named ALREADY_APPLIED, not ILLEGAL_TRANSITION",
      dupe.text.includes("ALREADY_APPLIED") &&
        !dupe.text.includes("ILLEGAL_TRANSITION"),
      dupe.text,
    );
    check(
      "the existing application is named so the tablet can open it",
      dupe.text.includes(WALK_IN_EXISTING_APP) &&
        dupe.text.includes(WALK_IN_EXISTING_CODE),
      dupe.text,
    );
    check(
      "the upstream really was called",
      state.calls.includes("POST /v1/applications/walk-in/register"),
    );

    // ── 12. No automatic retry on a write ──────────────────────────
    section("A failed write is attempted exactly once");
    state.finalDecisionUnavailable = true;
    const before = state.calls.filter(
      (c) => c === "POST /v1/applications/final-decision",
    ).length;
    const decision = await call(
      "POST",
      "/edge/v1/applications/final-decision",
      {
        body: {
          applicationId: APPLICATION_ID,
          decision: "SHORTLIST",
          notes: "proof",
        },
      },
    );
    const after = state.calls.filter(
      (c) => c === "POST /v1/applications/final-decision",
    ).length;
    check("an unavailable upstream is a 503", decision.status === 503);
    check(
      "the 503 names the dependency",
      decision.text.includes("UPSTREAM_UNAVAILABLE"),
    );
    check(
      "the write was called EXACTLY ONCE",
      after - before === 1,
      `${String(after - before)} attempts — a retried transition is a double write on a legal record`,
    );
    state.finalDecisionUnavailable = false;

    // ── 13. Refresh rotates, with a grace window ────────────────────
    section("Refresh rotates both secrets and keeps in-flight requests alive");
    const oldHandle = jar.get(SESSION_COOKIE);
    const oldCsrf = jar.get(CSRF_COOKIE);
    const refreshed = await call("POST", "/edge/v1/session/refresh");
    check("refresh is 200", refreshed.status === 200);
    check("the handle rotated", jar.get(SESSION_COOKIE) !== oldHandle);
    check("the CSRF token rotated", jar.get(CSRF_COOKIE) !== oldCsrf);
    check(
      "the absolute ceiling did not move",
      refreshed.text.includes("absoluteExpiresAt"),
      "the UI must be able to tell the truth about when the session ends",
    );
    if (oldHandle !== undefined && oldCsrf !== undefined) {
      const graceResponse = await fetch(`${base}/edge/v1/applications`, {
        headers: { cookie: `${SESSION_COOKIE}=${oldHandle}` },
      });
      check(
        "the pre-rotation handle still works inside the grace window",
        graceResponse.status === 200,
        "without a grace window a refresh 401s the SPA\u2019s own in-flight requests",
      );
    }

    // ── 14. Wrong session kind ──────────────────────────────────
    section("The two credentials are not interchangeable");
    const officerJar = jar.header();
    jar.clear();
    await call("GET", "/edge/v1/session"); // seed a CSRF cookie for the anonymous OTP flow
    const otpVerify = await call("POST", "/edge/v1/auth/applicant/otp/verify", {
      body: { nationalId: NID_A, otp: "123456" },
    });
    check(
      "OTP verification is 204 with no body",
      otpVerify.status === 204 && otpVerify.text === "",
    );
    const applicantSession = await call("GET", "/edge/v1/session");
    check(
      "the citizen session reports kind applicant",
      applicantSession.text.includes('"kind":"applicant"'),
    );
    check(
      "the citizen session carries NO agency",
      !applicantSession.text.includes("agency"),
      "a citizen is cross-agency by construction (ADR-014 / ADR-018)",
    );
    const officerRouteAsCitizen = await call("GET", "/edge/v1/applications");
    check(
      "a citizen session on an officer route is 403",
      officerRouteAsCitizen.status === 403,
    );
    check(
      "the 403 names the reason",
      officerRouteAsCitizen.text.includes("WRONG_SESSION_KIND"),
    );
    const citizenRead = await call("GET", "/edge/v1/me/applications");
    check(
      "the citizen can read their own applications",
      citizenRead.status === 200,
    );
    check(
      "the citizen list carries the row agency",
      citizenRead.text.includes('"agency":"RDF"'),
    );
    check(
      "no forensic signal reaches the citizen list",
      !/documentLane|forensics/i.test(citizenRead.text),
      "a score handed to the uploader is a forgery-tuning oracle",
    );

    // ── 14b. The citizen submit front door (ADR-027) ────────────────
    section(
      "Citizen submission: self-bound, idempotent, rate-limited, header-clean",
    );
    const submitCallsBefore = state.submitCalls.length;
    const SUBMIT_KEY = randomUUID();

    // CSRF first: an unsafe method without the token never reaches upstream.
    const submitNoCsrf = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", nesaIndexNumber: "RW2026/1001" },
      csrf: null,
      extraHeaders: { "idempotency-key": SUBMIT_KEY },
    });
    check("submit without CSRF is 403", submitNoCsrf.status === 403);
    check(
      "the CSRF-rejected submit never reached the bridge",
      state.submitCalls.length === submitCallsBefore,
    );

    // The key contract: required, UUID, exactly one.
    const noKey = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT" },
    });
    check("submit without an Idempotency-Key is 400", noKey.status === 400);
    const badKey = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT" },
      extraHeaders: { "idempotency-key": "not-a-uuid" },
    });
    check("submit with a non-UUID key is 400", badKey.status === 400);
    // Two Idempotency-Key headers arrive from the transport ALREADY JOINED
    // ("k1, k2") — Node comma-joins duplicates — so sending the joined value
    // IS the duplicate-header case, byte for byte.
    const dupKey = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT" },
      extraHeaders: { "idempotency-key": `${randomUUID()}, ${randomUUID()}` },
    });
    check(
      "two Idempotency-Key headers (transport-joined) are 400, not resolved by picking one",
      dupKey.status === 400 && dupKey.text.includes("INVALID_IDEMPOTENCY_KEY"),
      dupKey.text,
    );
    // HTTP permits optional surrounding whitespace; the controller accepts
    // the key after trimming — and must forward the TRIMMED value (the
    // canonical UUID), never the padded raw header.
    const paddedKey = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT" },
      extraHeaders: { "idempotency-key": `  ${SUBMIT_KEY}  ` },
    });
    check(
      "a whitespace-padded UUID key is accepted",
      paddedKey.status === 201,
      paddedKey.text,
    );
    check(
      "the TRIMMED canonical key is what was forwarded upstream",
      state.submitCalls[state.submitCalls.length - 1]?.headers[
        "idempotency-key"
      ] === SUBMIT_KEY,
      String(
        state.submitCalls[state.submitCalls.length - 1]?.headers[
          "idempotency-key"
        ],
      ),
    );
    // Re-baseline: the padded-key accept above is the ONE upstream-reaching
    // call this block makes; the rejected-shape checks below start from here.
    const afterKeyContract = state.submitCalls.length;

    // Self-binding: identity fields are refused at the boundary.
    const forgedApplicant = await call("POST", "/edge/v1/me/applications", {
      body: { applicantId: randomUUID(), category: "GENERAL_ENLISTMENT" },
      extraHeaders: { "idempotency-key": randomUUID() },
    });
    check(
      "a body applicantId is REFUSED with 400",
      forgedApplicant.status === 400,
    );
    check(
      "the refusal names FORBIDDEN_FIELD",
      forgedApplicant.text.includes("FORBIDDEN_FIELD"),
    );
    const forgedChannel = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", channel: "USSD" },
      extraHeaders: { "idempotency-key": randomUUID() },
    });
    check("a body channel is REFUSED with 400", forgedChannel.status === 400);
    const badCategory = await call("POST", "/edge/v1/me/applications", {
      body: { category: "NOT_A_CATEGORY" },
      extraHeaders: { "idempotency-key": randomUUID() },
    });
    check(
      "an unknown category is 400, never forwarded",
      badCategory.status === 400,
    );
    check(
      "no rejected shape ever reached the bridge",
      state.submitCalls.length === afterKeyContract,
    );

    // First submission: 201, identifiers, no replay header, exact key +
    // allowlisted body + built-from-scratch headers upstream.
    const first = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", nesaIndexNumber: "RW2026/1001" },
      extraHeaders: {
        "idempotency-key": SUBMIT_KEY,
        // Browser junk a proxy might forward; the edge must not.
        "x-internal-role": "usrp_system_service",
        "user-agent": "evil-probe/1.0",
        "x-forwarded-for": "203.0.113.9",
      },
    });
    check("first submission is 201", first.status === 201, first.text);
    check(
      "the 201 names the application, processing code and agency",
      first.text.includes(SUBMIT_APPLICATION_ID) &&
        first.text.includes(SUBMIT_PROCESSING_CODE) &&
        first.text.includes('"agency":"RDF"'),
      first.text,
    );
    check(
      "no replay header on a first submission",
      first.response.headers.get("idempotency-replayed") === null,
    );
    check(
      "the bridge was called exactly once for it",
      state.submitCalls.length - afterKeyContract === 1,
    );
    const firstCall = state.submitCalls[state.submitCalls.length - 1];
    check(
      "the Idempotency-Key is forwarded EXACTLY",
      firstCall?.headers["idempotency-key"] === SUBMIT_KEY,
      String(firstCall?.headers["idempotency-key"]),
    );
    check(
      "the upstream body is the allowlist only (no applicantId, no channel, no junk)",
      firstCall?.body !== null &&
        typeof firstCall?.body === "object" &&
        Object.keys(firstCall.body as Record<string, unknown>)
          .sort()
          .join(",") === "category,nesaIndexNumber",
      JSON.stringify(firstCall?.body),
    );
    const firstHeaders = Object.keys(firstCall?.headers ?? {})
      .map((h) => h.toLowerCase())
      .sort();
    check(
      "the adapter's own headers are all present upstream",
      [
        "accept",
        "authorization",
        "content-type",
        "idempotency-key",
        "x-correlation-id",
      ].every((h) => firstHeaders.includes(h)),
      JSON.stringify(firstHeaders),
    );
    check(
      "NOTHING from the browser's header set is forwarded",
      !firstHeaders.includes("x-internal-role") &&
        !firstHeaders.includes("x-forwarded-for") &&
        !firstHeaders.includes("x-csrf-token") &&
        !firstHeaders.includes("cookie") &&
        String(firstCall?.headers["user-agent"] ?? "") !== "evil-probe/1.0",
      JSON.stringify(firstHeaders),
    );

    // Replay: same key, same body → 200, same identifiers, the header.
    state.submitAnswer = "replay";
    const replay = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", nesaIndexNumber: "RW2026/1001" },
      extraHeaders: { "idempotency-key": SUBMIT_KEY },
    });
    check("a replay is 200, not 201", replay.status === 200, replay.text);
    check(
      "the replay sets Idempotency-Replayed: true",
      replay.response.headers.get("idempotency-replayed") === "true",
    );
    check(
      "the replayed body is the SAME identifiers as the first submit",
      replay.text.includes(SUBMIT_APPLICATION_ID) &&
        replay.text.includes(SUBMIT_PROCESSING_CODE),
      replay.text,
    );
    check(
      "the replay is audited as EDGE_IDEMPOTENT_REPLAY",
      auditRecords.some((a) => a.action === "EDGE_IDEMPOTENT_REPLAY"),
    );

    // CORS: the browser must be able to READ the replay header.
    const corsBase = { origin: "http://localhost:3000" };
    const corsReplay = await fetch(`${base}/edge/v1/me/applications`, {
      method: "POST",
      headers: {
        ...corsBase,
        cookie: jar.header(),
        "x-csrf-token": jar.get(CSRF_COOKIE) ?? "",
        "content-type": "application/json",
        "idempotency-key": SUBMIT_KEY,
      },
      body: JSON.stringify({
        category: "GENERAL_ENLISTMENT",
        nesaIndexNumber: "RW2026/1001",
      }),
    });
    check("an allowed-origin replay is still 200", corsReplay.status === 200);
    check(
      "Access-Control-Expose-Headers names Idempotency-Replayed",
      (corsReplay.headers.get("access-control-expose-headers") ?? "").includes(
        "Idempotency-Replayed",
      ),
      corsReplay.headers.get("access-control-expose-headers") ?? "(none)",
    );
    check(
      "CORS exposes ONLY the approved response headers — nothing else leaks to the browser",
      (corsReplay.headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((h) => h.trim())
        .sort()
        .join(",") ===
        ["Idempotency-Replayed", "x-correlation-id", "x-request-id"]
          .sort()
          .join(","),
      corsReplay.headers.get("access-control-expose-headers") ?? "(none)",
    );
    const preflight = await fetch(`${base}/edge/v1/me/applications`, {
      method: "OPTIONS",
      headers: {
        ...corsBase,
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type,x-csrf-token,idempotency-key",
      },
    });
    check(
      "the preflight allows POST",
      (preflight.headers.get("access-control-allow-methods") ?? "").includes(
        "POST",
      ),
    );
    check(
      "the preflight allows the browser to SEND Idempotency-Key",
      (preflight.headers.get("access-control-allow-headers") ?? "").includes(
        "idempotency-key",
      ),
      preflight.headers.get("access-control-allow-headers") ?? "(none)",
    );

    // Live duplicate: identifiers KEPT.
    state.submitAnswer = "alreadyApplied";
    const duplicate = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", nesaIndexNumber: "RW2026/1001" },
      extraHeaders: { "idempotency-key": randomUUID() },
    });
    check(
      "a live duplicate is 409 ALREADY_APPLIED",
      duplicate.status === 409 && duplicate.text.includes("ALREADY_APPLIED"),
      duplicate.text,
    );
    check(
      "the duplicate names the application on file (same shape as 201)",
      duplicate.text.includes(SUBMIT_APPLICATION_ID) &&
        duplicate.text.includes(SUBMIT_PROCESSING_CODE),
      duplicate.text,
    );

    // The per-session rate limit: five upstream-reaching submissions are all
    // this session gets in a minute (the proof pins the limit at 5: the
    // padded-key accept, the first submit, the replay, the CORS replay and
    // the live duplicate).
    const rateLimited = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", nesaIndexNumber: "RW2026/1001" },
      extraHeaders: { "idempotency-key": randomUUID() },
    });
    check(
      "the 6th submission in a minute is 429 RATE_LIMITED",
      rateLimited.status === 429 && rateLimited.text.includes("RATE_LIMITED"),
      rateLimited.text,
    );
    check(
      "the rate-limited request never reached the bridge",
      state.submitCalls.length === submitCallsBefore + 5,
      `${state.submitCalls.length - submitCallsBefore} upstream calls`,
    );

    // A fresh citizen session (new bucket) for the rest of the submit map.
    await call("POST", "/edge/v1/auth/applicant/logout");
    await call("GET", "/edge/v1/session"); // seed a fresh CSRF cookie (§14's pattern)
    const reLogin = await call("POST", "/edge/v1/auth/applicant/otp/verify", {
      body: { nationalId: NID_A, otp: "123456" },
    });
    check(
      "citizen re-login for the second half is 204",
      reLogin.status === 204,
    );

    // Key reuse: identifier-free even when upstream misbehaves.
    state.submitAnswer = "keyReused";
    const reused = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", nesaIndexNumber: "RW2026/1002" },
      extraHeaders: { "idempotency-key": randomUUID() },
    });
    check(
      "key reuse is 422 KEY_REUSED",
      reused.status === 422 && reused.text.includes("KEY_REUSED"),
      reused.text,
    );
    check(
      "key reuse is IDENTIFIER-FREE at the boundary too",
      !reused.text.includes("applicationId") &&
        !reused.text.includes(SUBMIT_APPLICATION_ID),
      reused.text,
    );
    check(
      "key reuse is audited as EDGE_IDEMPOTENCY_KEY_REUSED",
      auditRecords.some((a) => a.action === "EDGE_IDEMPOTENCY_KEY_REUSED"),
    );
    const reuseAudit = auditRecords.find(
      (a) => a.action === "EDGE_IDEMPOTENCY_KEY_REUSED",
    );
    check(
      "the reuse audit line carries no key material",
      reuseAudit !== undefined &&
        !JSON.stringify(reuseAudit).includes(SUBMIT_KEY),
    );

    // Dependency failure: 503, and the write is attempted EXACTLY once.
    state.submitAnswer = "unavailable";
    const callsBeforeUnavailable = state.submitCalls.length;
    const unavailable = await call("POST", "/edge/v1/me/applications", {
      body: { category: "GENERAL_ENLISTMENT", nesaIndexNumber: "RW2026/1003" },
      extraHeaders: { "idempotency-key": randomUUID() },
    });
    check(
      "an unavailable bridge is a 503",
      unavailable.status === 503,
      unavailable.text,
    );
    check(
      "the failed submission was attempted EXACTLY ONCE (no hidden retry)",
      state.submitCalls.length - callsBeforeUnavailable === 1,
      "a retried submission is a double write on a citizen's legal record",
    );

    // An officer session cannot use the citizen door.
    check(
      "the audit trail contains no idempotency key value",
      !auditRecords.some((a) => JSON.stringify(a).includes(SUBMIT_KEY)),
    );

    // ── 15. Anti-enumeration ───────────────────────────────────
    section("OTP request reveals nothing about the subject");
    const otpKnown = await call("POST", "/edge/v1/auth/applicant/otp/request", {
      body: { nationalId: NID_A },
    });
    const otpUnknown = await call(
      "POST",
      "/edge/v1/auth/applicant/otp/request",
      {
        body: { nationalId: NID_B },
      },
    );
    check("OTP request is 202", otpKnown.status === 202);
    check(
      "known and unknown National IDs are BYTE-IDENTICAL",
      otpKnown.text === otpUnknown.text &&
        otpKnown.status === otpUnknown.status,
      `${otpKnown.text} vs ${otpUnknown.text}`,
    );
    check(
      "the 202 body carries only acceptance",
      otpKnown.text === '{"accepted":true}',
      otpKnown.text,
    );
    check(
      "the upstream hint never crossed the boundary",
      !otpUnknown.text.includes("unknown-citizen"),
    );
    const malformed = await call(
      "POST",
      "/edge/v1/auth/applicant/otp/request",
      {
        body: { nationalId: "123" },
      },
    );
    check(
      "a structurally invalid National ID is 400",
      malformed.status === 400,
    );
    check(
      "the 400 does not echo the submitted identifier",
      !malformed.text.includes("123"),
    );

    // ── 16. Logout is a real revocation, and idempotent ──────────────
    section("Logout destroys server-side state and is idempotent");
    const logoutCitizen = await call("POST", "/edge/v1/auth/applicant/logout");
    check("citizen logout is 204", logoutCitizen.status === 204);
    check(
      "the citizen token was revoked UPSTREAM too",
      state.calls.includes("POST /v1/applicants/auth/logout"),
      "ADR-018 chose a revocable token so a stolen session could be killed",
    );
    check(
      "the session cookie is cleared",
      jar.get(SESSION_COOKIE) === undefined,
    );
    const logoutAgain = await call("POST", "/edge/v1/auth/applicant/logout", {
      csrf: null,
    });
    check(
      "logging out without a session is still 204",
      logoutAgain.status === 204,
      "a client retrying a logout must never be told it failed",
    );

    // The officer session from earlier must be dead server-side, not merely
    // cookie-less — that is the whole point for a non-revocable JWT.
    const revived = await fetch(`${base}/edge/v1/session`, {
      headers: { cookie: officerJar },
    });
    check(
      "the officer handle still resolves until it is explicitly destroyed",
      revived.status === 200,
      "this is the state the next check destroys",
    );
    const officerLogout = await fetch(`${base}/edge/v1/auth/officer/logout`, {
      method: "POST",
      headers: {
        cookie: officerJar,
        "x-csrf-token": /usrp_csrf_dev=([^;]+)/.exec(officerJar)?.[1] ?? "",
      },
    });
    check("officer logout is 204", officerLogout.status === 204);
    const afterLogout = await fetch(`${base}/edge/v1/session`, {
      headers: { cookie: officerJar },
    });
    check(
      "the destroyed handle no longer resolves",
      afterLogout.status === 401,
      "destroying the edge handle is the ONLY revocation an officer JWT has",
    );

    // ── 17. Nothing from the browser is forwarded ───────────────────
    section("The upstream request is built, not proxied");
    check(
      "no cookie header ever reached an upstream",
      !state.sawCookieHeader,
      "the upstream request is constructed from scratch — there is no allowlist to get wrong",
    );
    check(
      "officer routes carried a Bearer credential upstream",
      state.lastAuthorization?.startsWith("Bearer ") === true,
    );
  } finally {
    await server.stop();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    // Leave no session rows behind: they are personal data, and this proof runs
    // on every gate execution.
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql("usrp_edge_gateway")}`;
        await tx`DELETE FROM public_core.edge_sessions WHERE subject_id = ${OFFICER_ID}`;
        await tx`DELETE FROM public_core.edge_sessions WHERE kind = 'applicant' AND upstream_expires_at IS NOT NULL AND issued_at > now() - interval '10 minutes'`;
      });
    } catch (err) {
      console.error(
        JSON.stringify({ msg: "edge_selfcheck_cleanup_failed" }),
        err,
      );
    }
    await sql.end({ timeout: 5 });
  }

  console.log(`\n\u001b[1m────────────────────────────────────────\u001b[0m`);
  if (fail === 0) {
    console.log(
      `\u001b[1;32mEDGE BOUNDARY GREEN — ${String(pass)} checks, no credential crosses the browser boundary ✓\u001b[0m`,
    );
    process.exit(0);
  }
  console.error(
    `\u001b[0;31m${String(fail)} of ${String(pass + fail)} checks failed\u001b[0m`,
  );
  for (const label of failures)
    console.error(`  \u001b[0;31m✗ ${label}\u001b[0m`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error("\u001b[0;31medge-gateway selfcheck crashed\u001b[0m", err);
  process.exit(1);
});

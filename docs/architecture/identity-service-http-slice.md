# Identity Service — HTTP Transport Slice (2026-07-07)

This slice makes USRP **run for the first time**. It turns `identity-service`
from a library into a live process by wiring the transport-agnostic hexagonal
core to an HTTP ingress over the new zero-dependency `@usrp/shared-http`
substrate (ADR-005). It is the transport template every other service follows.

## What was added

| Layer | File | Role |
|-------|------|------|
| Transport substrate | `packages/shared-http/**` | Zero-dep `node:http` server: routing, bounded JSON parsing, uniform error shape, health/readiness, correlation-id propagation, access log, graceful shutdown |
| Ingress adapter | `services/identity-service/src/adapters/http/verify-identity.controller.ts` | Maps HTTP ⇄ `VerifyIdentityService` |
| Composition/bootstrap | `services/identity-service/src/main.ts` | The runnable process: config → event bus → server → graceful shutdown |
| Live self-check | `services/identity-service/selfcheck/verify-http-slice.ts` | Drives the service over a real socket against live PG + NIDA mock |

## The endpoint contract

`POST /v1/identities/verify` — body `{ "nationalId": string, "channel": "WEB"|"USSD"|"IREMBO_KIOSK"|"WALK_IN" }`

| Use-case outcome / condition | HTTP | Response body |
|------------------------------|------|---------------|
| Identity created | `201` | `{ status: "CREATED", applicantId }` |
| Already exists (idempotent) | `200` | `{ status: "ALREADY_EXISTS", applicantId }` |
| Not found in NIDA | `404` | `{ status: "NOT_FOUND_IN_NIDA" }` |
| Found but not a citizen | `422` | `{ status: "NOT_A_CITIZEN" }` |
| Malformed National ID | `400` | `{ error: "INVALID_NATIONAL_ID", detail }` |
| Missing / invalid field | `400` | `{ error: "MISSING_NATIONAL_ID" \| "INVALID_CHANNEL", detail }` |
| Non-JSON / bad / empty body | `415` / `400` | `{ error: "UNSUPPORTED_MEDIA_TYPE" \| "MALFORMED_JSON" \| "EMPTY_BODY" }` |
| NIDA unreachable (G2G fault) | `503` | `{ error: "NIDA_UNAVAILABLE" }` |
| DB write fault | `500` | `{ error: "IDENTITY_PERSISTENCE_ERROR" }` |

Plus reserved `GET /health` (liveness) and `GET /ready` (readiness — DB reachable).

### Security posture at the edge
- The **raw National ID is request-only** — it never appears in a response body,
  a log line, or an event. Proven by the self-check.
- The response exposes only the **opaque applicant UUID**. The internal
  `nationalIdHash` (a cross-service key) is deliberately **not** returned to the
  edge.
- 5xx error details are withheld from the client (only the stable `error` code);
  the server logs the real cause. 4xx details are safe, caller-facing hints.
- Every response carries `x-request-id` (fresh) and echoes `x-correlation-id`
  (inbound or freshly minted), which also seeds the Kafka event trace — so an
  HTTP request and the events it causes share one correlation id.

## Proven live

`selfcheck/verify-http-slice.ts` boots the real service on an ephemeral port and
drives it with `fetch` — 25 assertions covering every row above, correlation-id
propagation into the emitted event, health/readiness, 404/405 routing, and the
raw-NID-never-leaks invariant (response bodies **and** events). Run it with the
Tier-1 stack up:

```bash
DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
NIDA_BASE_URL='http://localhost:3100' \
NIDA_HMAC_SECRET='dev_nida_hmac_secret' \
NATIONAL_ID_HMAC_KEY='dev_national_id_hmac_key_min_32_chars!!' \
PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
pnpm --filter @usrp/identity-service selfcheck:http
```

The composition root (`main.ts`) was also driven end-to-end over `curl`
(`201 CREATED` → real encrypted PG row → `200 ALREADY_EXISTS`), and graceful
shutdown was verified to run `onShutdown` and exit 0 under plain `node`.

## Transport choice by environment

`main.ts` selects the event bus from the environment: **`KAFKA_BROKERS` set → the
real `KafkaEventBus`**; unset → `InMemoryEventBus` with a loud warning (events are
local-only). This lets the service run on a tier1-only dev stack without a broker,
while production publishes durably to Kafka.

## Findings surfaced by this slice (tracked, not blocking)

1. **`shared-database` is source-only, so `node dist/main.js` cannot run yet.**
   Its `exports` point at `src/*.ts` (no dist build), so a compiled service
   entrypoint can't resolve it through a `.js` import specifier. Every runnable
   path today therefore uses `tsx` (`pnpm --filter @usrp/identity-service start`
   → `tsx src/main.ts`). **Before production**, `shared-database` needs a real
   dist build (its own slice/ADR — it also governs the agency-scoped import
   subpaths), after which `start` should switch to `node dist/main.js`.
2. **`tsx` does not forward `SIGTERM` to the app handler** — under `tsx` the
   process exits `143` and our graceful-shutdown handler does not run. Graceful
   shutdown is proven correct under plain `node` (exit 0, `onShutdown` runs).
   This is another reason the production runtime target is compiled `node`,
   gated on finding (1).

## Deferred to next slices
1. Per-endpoint request-schema validation helper (kept explicit for now).
2. Auth at the edge (JWT verify) once the gateway/BFF story lands.
3. OpenAPI description generated from the routes.
4. Fold this transport into the next service (eligibility or biometric).

# Background-Vetting Service — RIB Criminal-Clearance Gate (Stage 3)

**Status:** DONE, proven 63/63 assertions against live RIB mock + Kafka.
Registered in `scripts/run-selfchecks.sh` → gate **11/11 green**, zero regression.

## What this slice delivers

The third pipeline stage — **criminal clearance** — as a new service,
`services/background-vetting-service`. It is the platform's first fully
**event-driven-only** business service and its first **DB-free** service: it
consumes `APPLICANT_SUBMITTED`, checks the applicant against RIB (Rwanda
Investigation Bureau) over the G2G tunnel, and emits two events:

```
                       ┌───────────────────────────► RIB_VETTING_COMPLETED (vetting.rib)
APPLICANT_SUBMITTED ──►│  [background-vetting-service]
   (applicant.submitted)│  RIB gate: fetch flag → evaluate → emit
                       └───────────────────────────► AUDIT_ENTRY (audit.immutable)
```

No synchronous caller: the gate reacts to the same trigger as the age gate,
in its **own consumer group** (`background-vetting-service`), so the two gates
run in parallel coupled only by the backbone.

## Why event-driven-only + DB-free

`APPLICANT_SUBMITTED` (produced by the front door for a VERIFIED applicant)
already carries everything RIB needs:

- `nationalIdHash` — RIB's lookup key (the internal system-wide applicant key,
  **not** the NIDA-lookup hash; RIB keys on the same hash the front door mints).
- `category` — fixes the per-agency conviction threshold.
- `applicationId` — the entity the verdict is bound to.

So this gate needs **no identity read** and **no PII decrypt** → no database,
no `PII_ENCRYPTION_KEY`, the leanest config in the platform (runtime + RIB
endpoint only). Smallest possible blast radius for a criminal-records handler.

## The decision policy (pure domain)

`evaluateCriminalClearance(category, ribStatus)` is pure and total — the whole
policy is unit-testable with no I/O. It maps RIB's **coarse** flag (RIB returns
only a status, never a sentence length — "detailed records require a separate
authorized physical request") against the per-category threshold from
`CRIMINAL_THRESHOLD_BY_CATEGORY`:

| RIB status            | threshold                     | verdict              | cleared |
|-----------------------|-------------------------------|----------------------|---------|
| `CLEAR`               | (any)                         | `CLEARED`            | ✅      |
| `UNDER_INVESTIGATION` | (any)                         | `UNDER_REVIEW`       | ❌      |
| `HAS_RECORDS`         | `ANY_CONVICTION` (RDF, RCS)   | `FLAGGED_CONVICTION` | ❌      |
| `HAS_RECORDS`         | `IMPRISONMENT_*` (RNP)        | `UNDER_REVIEW`       | ❌      |

**Key judgment — the two `HAS_RECORDS` branches.** Agencies whose rule is "ANY
conviction disqualifies" need no further detail; the flag is decisive. But RNP's
rule is a **sentence-length threshold** (`>6mo` for Cadet, `≥6mo` for Basic),
which a coarse flag cannot decide. Auto-clearing would be unsafe; auto-rejecting
would be unjust. The honest, **fail-closed** action is to route to human
adjudication (`UNDER_REVIEW`) — the "authorized detailed review" RIB documents.

`FLAGGED_PROSECUTION` (RCS active prosecution) and `FLAGGED_DISMISSED`
(dismissed from public service) are in the `CriminalClearanceStatus` domain but
**not reachable** from the mock's three-state answer — they need a richer RIB
response and are handled the day RIB returns that detail.

## Architecture (hexagonal, mirrors the eligibility gates)

```
src/
  domain/
    criminal-rules.ts          pure evaluateCriminalClearance (the policy)
    rib.types.ts               RibCheckResult, RibUnavailableError
  ports/
    rib.gateway.ts             RibGateway interface (core depends on this)
  adapters/
    rib.http-gateway.ts        RibHttpGateway — HMAC-signed POST /v1/vetting/check
    events/
      applicant-submitted.consumer.ts   the ONLY ingress (group = service name)
  application/
    verify-criminal-clearance.service.ts  fetch → evaluate → emit ×2
  config.ts                    runtime + RIB endpoint only (no DB, no PII key)
  index.ts                     composition root + public API
  main.ts                      consumer-only bootstrap, routes:[], health/ready
```

- **G2G signing = HMAC-SHA256** (`signG2GRequest`), identical scheme to
  NIDA/NESA/HEC (`x-hmac-signature` / `x-request-id` / `x-timestamp`), forward-
  compatible with a signature-enforcing real RIB. The dev mock ignores the
  signature but we sign anyway.
- **Fail-closed:** `RibUnavailableError` propagates out of the consumer, so the
  Kafka offset is not committed and the vetting is redelivered — a transient RIB
  outage retries rather than fabricating a clearance or dropping the check.
- **Stateless:** the gate writes **no** application row (see below).

## The deliberate boundary: no application write-back (an ADR, not this slice)

Every eligibility/vetting gate in USRP today is a **pure emitter** — none writes
`application.criminal_clearance_status` / `academic_status`. Introducing a
write-back here would make this one gate asymmetric with the others. **Who
projects vetting verdicts onto the application row** (a dedicated projector
consuming `vetting.*`? each gate writing its own column? the application-service
consuming its own results?) is a single cross-cutting decision that deserves its
own ADR. The `RIB_VETTING_COMPLETED` event carries everything a future projector
needs: `applicationId`, `agency`, `category`, `clearanceStatus`,
`appliedThreshold`. **Flagged for the owner as the next architectural decision.**

## PII / compliance posture (Law N° 058/2021)

- The RIB request body is `{ nationalIdHash, requestId }` — no raw NID, no name,
  no DOB.
- Neither output event contains the `nationalIdHash` (asserted by the self-check
  against both `RIB_VETTING_COMPLETED` and `AUDIT_ENTRY`). The audit records
  references + the derived verdict only.
- RIB returns only a status flag — no case details enter USRP at all.

## Proof (`selfcheck/verify-vetting-slice.ts`, 63 assertions)

1. **Pure policy** — every category × RIB status combination.
2. **Live RIB gateway** vs `usrp-rib-mock:3102` — resolves CLEAR (unknown hash),
   HAS_RECORDS (flagged fixture), UNDER_INVESTIGATION (investigation fixture),
   HMAC-signed.
3. **Event-driven e2e over live Kafka** — three submissions prove the three
   decisive verdicts (RDF+records→FLAGGED_CONVICTION, RDF+clean→CLEARED,
   RNP Cadet+records→UNDER_REVIEW). Asserts both output events, agency derived
   from category, `applicationId` bound, correlationId preserved + causationId =
   trigger eventId (full causal chain), and no nationalIdHash leak.
4. **Fail-closed** — an unreachable RIB raises `RibUnavailableError`.

Plus compiled `node dist/main.js` e2e: serves `/health` + `/ready`, consumes
`applicant.submitted`, graceful SIGTERM (exit 0). Deployable.

## Environment

RIB mock is on **:3102** (in-cluster; `RIB_HMAC_SECRET=dev_rib_hmac_secret`).
Self-check env:

```
RIB_BASE_URL=http://localhost:3102 RIB_HMAC_SECRET=dev_rib_hmac_secret \
KAFKA_BROKERS=localhost:29092 \
pnpm --filter @usrp/background-vetting-service selfcheck
```

## Residuals / follow-ons

- **`.env.example` divergence:** it uses `RIB_API_BASE_URL` /
  `RIB_REQUEST_TIMEOUT_MS`; the code canon (matching NESA/HEC) is `RIB_BASE_URL`
  / `RIB_REQUEST_TIMEOUT_MS`. Part of the standing `.env` ↔ shared-config
  reconciliation item.
- **Application write-back projector** — the ADR above.
- **Richer RIB response** would unlock `FLAGGED_PROSECUTION` /
  `FLAGGED_DISMISSED` and let RNP sentence-length thresholds auto-decide instead
  of routing to review.

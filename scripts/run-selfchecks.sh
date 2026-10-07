#!/usr/bin/env bash
# ══════════════════════════════════════════════════
# run-selfchecks.sh — run EVERY proof in the repo, in dependency order,
# against live infrastructure. This is the project's real quality gate:
# "prove it, don't assert it" made repeatable and enforceable (CI runs
# this same script). A regression in any invariant — cross-agency
# isolation, PII protection, audit immutability, the event backbone —
# turns this red.
#
# Prerequisites (the caller brings the infra up and bootstraps the DB):
#   • tier1: Postgres + NIDA mock (:3100) + NESA mock (:3101) + MinIO
#   • tier2: Kafka (host listener :29092) + ClamAV
#   • DB already bootstrapped (scripts/bootstrap-db.sh)
#
# Dev secrets are the well-known non-production values used across all
# selfcheck docs; centralised here so every proof runs with one env.
#
# NOTE: this inline environment is exactly why .env.example was able to rot
# for ~30 slices — no proof read it. The final section closes that seam by
# booting the platform from the committed template instead of from here.
#
# NOTE 2: because this file COMMITS dev secrets, the values it exports are
# published material exactly like the template's, and the production guard
# fingerprints them too (see packages/shared-config/src/production-guard.ts).
#
# Usage:  bash scripts/run-selfchecks.sh
# Exit:   0 iff every proof passes; first failure aborts (fail-fast).
# ═════════════════════════════════════════════════
set -euo pipefail
ulimit -n 65536 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Shared dev environment (non-production, matches the slice docs) ──
export DATABASE_URL="${DATABASE_URL:-postgresql://usrp_app:app_pw@localhost:5432/usrp_db}"
export KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:29092}"
export NIDA_BASE_URL="${NIDA_BASE_URL:-http://localhost:3100}"
export NIDA_HMAC_SECRET="${NIDA_HMAC_SECRET:-dev_nida_hmac_secret}"
export NESA_BASE_URL="${NESA_BASE_URL:-http://localhost:3101}"
export NESA_HMAC_SECRET="${NESA_HMAC_SECRET:-dev_nesa_hmac_secret}"
export HEC_BASE_URL="${HEC_BASE_URL:-http://localhost:3103}"
export HEC_HMAC_SECRET="${HEC_HMAC_SECRET:-dev_hec_hmac_secret}"
export RIB_BASE_URL="${RIB_BASE_URL:-http://localhost:3102}"
export RIB_HMAC_SECRET="${RIB_HMAC_SECRET:-dev_rib_hmac_secret}"
export NATIONAL_ID_HMAC_KEY="${NATIONAL_ID_HMAC_KEY:-dev_national_id_hmac_key_min_32_chars!!}"
export PII_ENCRYPTION_KEY="${PII_ENCRYPTION_KEY:-dev_pii_encryption_key_min_32_chars_ok!!}"
# Auth (Ed25519 asymmetric bearer tokens). A committed DEV-ONLY keypair — same
# pattern as the QR signing dev key. The PUBLIC key is what services verify
# with; the PRIVATE key lets proofs mint tokens. Real keys come from HSM/KMS.
export AUTH_JWT_PUBLIC_KEY_B64="${AUTH_JWT_PUBLIC_KEY_B64:-LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQUpjb2FtWEM1NFMvTk51UDRlcXVzLzh5dlhuTk5yTkRhK0JGWFFuSkU1QzQ9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=}"
export AUTH_JWT_PRIVATE_KEY_B64="${AUTH_JWT_PRIVATE_KEY_B64:-LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSUlUaGJCTVJ0Sm9WQUwzUURrK29yZUgwVTludWw3RUNBNFdRRUxiV21LZmwKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=}"
# Object store + virus scanner (the amber-lane forensics slice). Dev-tier
# MinIO (tier1) + ClamAV (tier2) — values mirror .env.example dev defaults.
export MINIO_ENDPOINT="${MINIO_ENDPOINT:-localhost}"
export MINIO_PORT="${MINIO_PORT:-9000}"
export MINIO_USE_SSL="${MINIO_USE_SSL:-false}"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-usrp_minio_admin}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-usrp_minio_dev_password}"
export MINIO_BUCKET_DOCUMENTS="${MINIO_BUCKET_DOCUMENTS:-usrp-documents}"
# Document-at-rest envelope (AES-256-GCM). NOT optional: MINIO_ENCRYPTION_KEY is
# now REQUIRED to boot document-forensics-service — a store for scanned national
# IDs that can start without its encryption key is a store that will run without
# one. Committed DEV-ONLY value, same posture as the Ed25519 keypair above;
# production keys come from HSM/KMS.
export MINIO_ENCRYPTION_KEY="${MINIO_ENCRYPTION_KEY:-dev_document_envelope_key_min_32_chars!!}"
export CLAMAV_HOST="${CLAMAV_HOST:-localhost}"
export CLAMAV_PORT="${CLAMAV_PORT:-3310}"
export CLAMAV_TIMEOUT_MS="${CLAMAV_TIMEOUT_MS:-30000}"
export QR_SIGNING_KEY_ID="${QR_SIGNING_KEY_ID:-selfcheck-qr-key-1}"

# ── Edge tier (ADR-028 / ADR-024) ──────────────────────────────
# The edge proof boots the gateway in-process against a stub upstream, so it
# needs the same names services/edge-gateway/src/config.ts reads. Two notes:
#
#   EDGE_COOKIE_SECURE=false because the proof drives plain http on loopback.
#     __Host- cookies REQUIRE Secure and browsers silently drop them without it,
#     so a proof that set this true would be testing a cookie no client could
#     ever receive. The gateway itself refuses to boot with false under
#     NODE_ENV=production.
#   EDGE_SESSION_HMAC_KEY is also the ROOT of the derived at-rest key for stored
#     upstream credentials, so it is one published dev secret rather than two.
export IAM_BASE_URL="${IAM_BASE_URL:-http://localhost:4011}"
export APPLICATION_SERVICE_BASE_URL="${APPLICATION_SERVICE_BASE_URL:-http://localhost:4006}"
export IDENTITY_SERVICE_BASE_URL="${IDENTITY_SERVICE_BASE_URL:-http://localhost:4001}"
export FIELD_SYNC_SERVICE_BASE_URL="${FIELD_SYNC_SERVICE_BASE_URL:-http://localhost:4009}"
export EDGE_SESSION_HMAC_KEY="${EDGE_SESSION_HMAC_KEY:-dev_edge_session_hmac_key_min_32_chars!!}"
export EDGE_SESSION_IDLE_TTL_SECONDS="${EDGE_SESSION_IDLE_TTL_SECONDS:-1800}"
export EDGE_SESSION_ABSOLUTE_TTL_SECONDS="${EDGE_SESSION_ABSOLUTE_TTL_SECONDS:-43200}"
export EDGE_COOKIE_SECURE="${EDGE_COOKIE_SECURE:-false}"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000,http://localhost:3001}"

PG_CONTAINER="${PG_CONTAINER:-usrp-postgres}"
PG_ADMIN_USER="${PG_ADMIN_USER:-usrp_admin}"
PG_DB="${PG_DB:-usrp_db}"

pass=0
fail=0
declare -a FAILED=()

hdr()  { printf '\n\033[1;36m══ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ PASS — %s\033[0m\n' "$*"; pass=$((pass+1)); }
bad()  { printf '\033[0;31m✗ FAIL — %s\033[0m\n' "$*"; fail=$((fail+1)); FAILED+=("$1"); }

# ── Preflight: the workspace must be BUILT *from this source* ──────────────
# @usrp/* packages resolve their TYPES to src/ and their RUNTIME to dist/, and
# dist/ is gitignored — developer-local state. Switch branch or pull, and you
# keep a build from another commit: `pnpm typecheck` stays green (it never reads
# dist) while every proof that imports a symbol added since that build dies with
#   SyntaxError: The requested module '@usrp/shared-database' does not provide
#                an export named 'stageOutboxEvents'
# That is a stale artefact, not a regression — but it reads as ~5 unrelated proof
# failures. Check it FIRST, with the fix, instead of 40 proofs later.
#
# The check is SEMANTIC (declared exports vs imported namespace), never
# mtime-based: a turbo cache hit legitimately leaves dist/ untouched, so a
# timestamp comparison reports false staleness right after `pnpm build`.
# `pnpm verify` builds first (CI parity), so this normally never fires; it
# protects direct `bash scripts/run-selfchecks.sh` callers.
if ! node scripts/check-workspace-build.mjs; then exit 1; fi

# Run a tsx selfcheck; $1 = human label, $2 = path.
run_ts() {
  local label="$1" path="$2"
  hdr "$label"
  if npx tsx "$path"; then ok "$label"; else bad "$label"; fi
}

# ── 0. The production boot guard — zero infrastructure, fastest signal ──
# Runs FIRST, ahead of even the RLS proof, for two reasons. It needs no
# Postgres, no Kafka, no MinIO and no docker at all, so a regression is known
# in under a second instead of after ClamAV downloads a virus database. And it
# guards @usrp/shared-config — the config layer every service in the proofs
# below boots through — including the assertion that the guard stays INERT
# outside production. If that inertness ever broke, every proof below would
# fail at once and the cause would be far from obvious.
run_ts "shared-config: production boot guard (dev secrets / placeholders / loopback / mocks)" packages/shared-config/selfcheck/verify-production-guard.ts

# ── 0a. Deployment hygiene — zero infrastructure, pure file reads ─────
# Sits beside the production guard because it polices the same thing from the
# other end: the guard proves the ENVIRONMENT a service boots into is sane,
# this proves the IMAGE it boots as is. EXPOSE is a hand-written second copy of
# `.env.example`'s canonical PORT_<SERVICE>, and it had already rotated one
# position across biometric- / document-forensics- / background-vetting-service
# (4003→4004→4005→4003). EXPOSE publishes nothing, so the drift was invisible to
# review and to every green test run — it only bites `docker run -P`, Compose
# port inference, service meshes and k8s tooling that trusts image metadata.
run_ts "deployment hygiene (EXPOSE ↔ .env.example port map, non-root, exec-form CMD)" packages/shared-config/selfcheck/verify-deployment-hygiene.ts

# ── 0b. Edge contract drift — also zero infrastructure ────────────────
# Placed beside the production guard for the same reason: it opens no socket and
# touches no database, so contract drift between the operation registry, the
# OpenAPI document and the approved upstream catalogue is known in milliseconds.
# It is the check that would have caught the four BFF services that never
# existed being read as fact for a month.
run_ts "edge-gateway: contract drift (registry ↔ OpenAPI ↔ upstream catalogue)" services/edge-gateway/selfcheck/verify-edge-contract.ts
run_ts "edge-gateway: citizen submit front-door readiness (the release signal)" services/edge-gateway/selfcheck/verify-citizen-submit-readiness.ts
run_ts "edge-gateway: source hygiene (layering, redaction, no raw console)" services/edge-gateway/selfcheck/verify-edge-hygiene.ts

# ── 0c. kafkajs timer-patch guard — zero infrastructure ─────────────
# The kafkajs@2.2.4 idle-timer fix is carried as a pnpm patch (runbook
# known-state notes have the full rationale). A patch with no proof guarding it
# is a patch that quietly disappears: nothing else in this gate would notice a
# reinstall or dependency bump that dropped it — the symptom it fixes is a
# stderr PROCESS WARNING that exits 0, so a green gate cannot tell warned from
# unwarned. This proof drives the REAL RequestQueue class (the copy this
# workspace resolves; it prints the path) and covers the patch's full spec:
# an ACTIVE client-side throttle with an empty queue still arms its re-check
# timer (the branch a dropped wakeup would break — a silently stalled
# consumer); an idle queue arms nothing whether the throttle is expired or
# never existed (the unpatched bug arms a negative delay here — the ~1kHz busy
# loop); a saturated queue still drains with pending work scheduled at the 10
# ms clamp; and a drained queue performs zero wakeups in a 300 ms idle sample
# (unpatched: ~890/sec — measured behaviourally, so it fails on ANY Node
# version, including Node 22 where the warning never prints). Verified by
# drill: reverting the patch makes this proof fail on four checks, restoring
# makes it pass — so a dropped patch turns the gate red, not silent.
run_ts "shared-events: kafkajs timer patch (throttle arms; idle never arms; queue drains; zero idle wakeups)" packages/shared-events/selfcheck/verify-kafka-timer-patch.ts

run_ts "edge-gateway: session refresh persistence" services/edge-gateway/selfcheck/verify-edge-session-refresh.ts

# ── 1. Cross-agency isolation — the system's first hard invariant ──
# Runs as usrp_admin inside the PG container; rolls back; ERRORs on any leak.
hdr "RLS cross-agency isolation (verify-isolation.sql)"
if docker exec -i "$PG_CONTAINER" psql -U "$PG_ADMIN_USER" -d "$PG_DB" \
     -v ON_ERROR_STOP=1 -q < packages/shared-database/src/rls/verify-isolation.sql; then
  ok "RLS cross-agency isolation"
else
  bad "RLS cross-agency isolation"
fi

# ── 1b. Schema drift — the .ts mirror, the drizzle snapshot and the live
# database must agree. Runs early: every proof below asserts behaviour ON
# this schema, so a silent divergence here would undermine all of them.
run_ts "shared-database: schema drift (.ts ↔ snapshot ↔ live DB)" packages/shared-database/selfcheck/verify-schema-drift.ts
# ADR-027 follow-up: the citizen submit rate limit's shared store. Two limiter
# instances over one database share one window, concurrent increments are
# lossless, windows expire, store faults fail closed (never "allow"), and
# production refuses the memory store. Live PG only — no Kafka, no stubs.
run_ts "edge-gateway: shared rate-limit store (rls/0024 — shared, lossless, fail-closed)" services/edge-gateway/selfcheck/verify-rate-limit-store.ts

# ── 2. The service & backbone selfchecks, in dependency order ──────
# Deterministic crypto proofs first — no infra, fastest signal.
run_ts "shared-security: signed slot invitation"  packages/shared-security/selfcheck/verify-slot-invitation.ts
run_ts "shared-security: password KDF (scrypt)"   packages/shared-security/selfcheck/verify-password-kdf.ts
run_ts "shared-auth: signed bearer token + enforcement" packages/shared-auth/selfcheck/verify-auth-token.ts
run_ts "shared-events: Kafka round-trip"          packages/shared-events/selfcheck/verify-kafka-roundtrip.ts
# ADR-025: a poison message costs one retry budget, never a partition. Right
# after the round-trip because every consuming proof below rides on this path.
run_ts "shared-events: dead-letter + bounded retry (no head-of-line poison)" packages/shared-events/selfcheck/verify-dead-letter.ts
run_ts "identity-service: core slice"             services/identity-service/selfcheck/verify-slice.ts
run_ts "identity-service: HTTP slice"             services/identity-service/selfcheck/verify-http-slice.ts
run_ts "identity-service: right-to-erasure (gate → tombstone → freeze)" services/identity-service/selfcheck/verify-erasure-slice.ts
run_ts "application-service: front-door submit"   services/application-service/selfcheck/verify-submit-http-slice.ts
# ADR-027: the front door is idempotent and one citizen holds at most ONE live
# application per campaign+category. Immediately after the front-door proof it
# hardens: that one proves a submission works, this one proves a RETRIED or
# DUPLICATED submission does not quietly become a second application. Its
# section 0 is a zero-infrastructure completeness manifest — the guard against
# this slice ever shipping as its SQL migration alone again.
run_ts "application-service: submission integrity (idempotent retry, key reuse, live-intent duplicates, walk-in)" services/application-service/selfcheck/verify-submission-integrity.ts
run_ts "application-service: officer auth + RLS"  services/application-service/selfcheck/verify-auth-slice.ts
# This proof existed since 2026-08-22 but was never registered here, so it had
# never run. It was red the whole time: findById selected a column rnp_ops does
# not have, and every RNP officer's detail read answered 500. An unregistered
# proof is not a proof — it is a file. Registered so that cannot recur.
run_ts "application-service: officer single-record reads (by-id + status-history)" services/application-service/selfcheck/verify-application-detail-reads.ts
run_ts "application-service: officer lifecycle (medical→final→accept)" services/application-service/selfcheck/verify-officer-lifecycle-slice.ts
run_ts "application-service: auto-withdrawal on accept (ADR-017)" services/application-service/selfcheck/verify-auto-withdrawal-slice.ts
run_ts "iam-service: token issuer (mint → officer endpoint accepts)" services/iam-service/selfcheck/verify-iam-issuer-slice.ts
run_ts "iam-service: service tokens (client-credentials → system route accepts)" services/iam-service/selfcheck/verify-service-token-slice.ts
run_ts "identity-service: applicant auth (OTP → session → own applications)" services/identity-service/selfcheck/verify-applicant-auth-slice.ts
run_ts "identity-service: applicant self-service (withdraw own + erasure intake, ADR-020)" services/identity-service/selfcheck/verify-applicant-self-service-slice.ts
# ADR-027 follow-up: the submit bridge (POST /v1/applicants/me/applications).
# Zero infrastructure — a stub front door over a real socket proves the
# bridge forwards exactly the Idempotency-Key, uses its OWN system token,
# never the browser's credential, and maps the integrity answers verbatim.
run_ts "identity-service: applicant submit gateway (bridge → front door, own system token)" services/identity-service/selfcheck/verify-applicant-submit-gateway.ts
run_ts "identity-service: retention sweep (dry-run safe → gated tombstones)" services/identity-service/selfcheck/verify-retention-sweep-slice.ts
# The BROWSER BOUNDARY. Runs after the two credential issuers above because it
# asserts what happens to the credentials THEY mint: that neither ever crosses
# to a browser, that the opaque handle is all the client gets, and that killing
# the handle is a real revocation for a token ADR-016 makes non-revocable.
run_ts "edge-gateway: browser boundary (opaque session, CSRF, isolation, anti-enumeration, no-retry)" services/edge-gateway/selfcheck/verify-edge-security.ts
run_ts "application-service: lifecycle monotonicity" services/application-service/selfcheck/verify-lifecycle.ts
run_ts "application-service: vetting projection"   services/application-service/selfcheck/verify-vetting-projection.ts
# ADR-025: a committed transition can no longer lose its event (the GREEN-but-
# never-scheduled defect). Right after the projection proof it hardens.
run_ts "application-service: transactional outbox (atomic stage → relay → no lost CLEARED)" services/application-service/selfcheck/verify-outbox-slice.ts
run_ts "application-service: history immutability" services/application-service/selfcheck/verify-history-immutability.ts
run_ts "eligibility-service: age gate"            services/eligibility-service/selfcheck/verify-age-eligibility.ts
run_ts "eligibility-service: NESA education gate" services/eligibility-service/selfcheck/verify-education-eligibility.ts
run_ts "eligibility-service: HEC degree gate"     services/eligibility-service/selfcheck/verify-degree-eligibility.ts
run_ts "eligibility-service: event-driven age+academic" services/eligibility-service/selfcheck/verify-event-driven.ts
run_ts "background-vetting: RIB criminal gate"    services/background-vetting-service/selfcheck/verify-vetting-slice.ts
run_ts "scheduling-service: slot assignment"      services/scheduling-service/selfcheck/verify-slot-assignment.ts
# ADR-026: one invitation per application, no venue overbooked. Right after the
# assignment proof: that one proves the happy path over Kafka, this one proves
# the path under redelivery, concurrency, capacity and a broker outage.
run_ts "scheduling-service: slot integrity (idempotent re-announce, seat capacity, concurrent redelivery, durable)" services/scheduling-service/selfcheck/verify-slot-integrity.ts
run_ts "notification-service: invitation delivery + lifecycle advance" services/notification-service/selfcheck/verify-notification-slice.ts
run_ts "notification-service: contact capture → real delivery" services/notification-service/selfcheck/verify-contact-delivery-slice.ts
run_ts "notification-service: withdrawal notice (acceptance → sweep → citizen SMS, ADR-022)" services/notification-service/selfcheck/verify-notices-slice.ts
run_ts "biometric-service: check-in gate + persistence" services/biometric-service/selfcheck/verify-biometric-slice.ts
run_ts "field-sync-service: offline capture + CRDT merge + adjudication" services/field-sync-service/selfcheck/verify-field-sync-slice.ts
run_ts "audit-service: immutable trail"           services/audit-service/selfcheck/verify-audit-slice.ts
run_ts "document-forensics: bounded-real analyzer (MinIO+ClamAV)" services/document-forensics-service/selfcheck/verify-forensics-slice.ts
# The document INGRESS (P1 #3). Runs straight after the analyzer proof because it
# depends on that route behaviourally: it uploads a file, then drives
# /v1/forensics/analyze over the object it sealed itself, so a regression in
# analyze/ should turn its OWN proof red first rather than surface as a
# confusing failure in the middle of this one.
run_ts "document-forensics: upload ingress (multipart → ClamAV → sealed MinIO → verdict)" services/document-forensics-service/selfcheck/verify-document-upload-slice.ts
run_ts "application-service: amber routing + adjudication" services/application-service/selfcheck/verify-amber-adjudication-slice.ts
run_ts "application-service: walk-in lane (register → vet → physical → merged funnel)" services/application-service/selfcheck/verify-walk-in-slice.ts
# The whole spine composed: one real submission → all 3 gates → DOCUMENT_REVIEW_GREEN.
# Runs late — it exercises the most services (eligibility + background-vetting + application).
run_ts "pipeline: full chain → DOCUMENT_REVIEW_GREEN" services/application-service/selfcheck/verify-pipeline-e2e.ts

# ── 3. The developer entrypoint itself ────────────────────────────
# Boots ALL TWELVE services from .env.example — the committed template, NOT
# the inline environment above. That distinction is the whole point: every
# proof before this one is driven by this script's own exports, so the file a
# fresh clone actually starts from was the one surface no proof touched, and
# it drifted out of agreement with the code for ~30 slices.
#
# Runs LAST for two reasons: it is the broadest and most infra-heavy proof
# (the same reason pipeline-e2e runs late), and booting twelve services joins
# and leaves real consumer groups — which must not perturb the behavioural
# proofs above it.
hdr "dev boot: all 12 services from .env.example"
if bash scripts/verify-dev-boot.sh; then
  ok "dev boot: all 12 services from .env.example"
else
  bad "dev boot: all 12 services from .env.example"
fi

# ── Summary ────────────────────────────────────────
printf '\n\033[1m───────────────────────────────────────────\033[0m\n'
printf 'Proofs: \033[0;32m%d passed\033[0m, ' "$pass"
if [[ $fail -eq 0 ]]; then
  printf '\033[0;32m%d failed\033[0m\n' "$fail"
  printf '\033[1;32mALL PROOFS GREEN — every invariant holds ✓\033[0m\n'
  exit 0
else
  printf '\033[0;31m%d failed\033[0m\n' "$fail"
  printf 'Failed proofs:\n'
  for f in "${FAILED[@]}"; do printf '  \033[0;31m✗ %s\033[0m\n' "$f"; done
  exit 1
fi

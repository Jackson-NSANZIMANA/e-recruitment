#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# prove-e2e.sh — run the USRP end-to-end proof on THIS machine and leave
# an evidence bundle behind.
#
# It does not invent a new test. It drives the repository's own gate
# (`scripts/run-selfchecks.sh`) plus the static gates, records every phase
# in its own log, and writes RESULT.md + an evidence fingerprint, so a green
# run is auditable and a red run points at the failing phase.
#
# Usage:
#   bash scripts/prove-e2e.sh                 # full: tier1+tier2 → bootstrap → static → gate
#   bash scripts/prove-e2e.sh --quick         # tier1 only → bootstrap → static → DB-only subset
#   bash scripts/prove-e2e.sh --no-infra      # assume infra is already up; don't touch compose
#   bash scripts/prove-e2e.sh --reset         # DESTRUCTIVE: resume from a clean DB volume
#   bash scripts/prove-e2e.sh --ref <git-ref> # assert HEAD is this ref (never checks it out)
#
# Exit: 0 iff every phase run passed. Skips are reported, never hidden.
# ══════════════════════════════════════════════════════════════════
set -uo pipefail
ulimit -n 65536 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="full"; NO_INFRA=0; RESET=0; EXPECT_REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) MODE="quick" ;;
    --full) MODE="full" ;;
    --no-infra) NO_INFRA=1 ;;
    --reset) RESET=1 ;;
    --ref) EXPECT_REF="${2:-}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$REPO_ROOT/.prove-e2e/run-$RUN_ID"
mkdir -p "$OUT_DIR"

# ── output helpers ────────────────────────────────────────────────
C_RESET=$'\033[0m'; C_G=$'\033[0;32m'; C_R=$'\033[0;31m'; C_B=$'\033[1;36m'; C_Y=$'\033[0;33m'
say()  { printf '%s\n' "${C_B}── $* ${C_RESET}"; }
ok()   { printf '%s\n' "${C_G}✓ $*${C_RESET}"; }
bad()  { printf '%s\n' "${C_R}✗ $*${C_RESET}"; }
warn() { printf '%s\n' "${C_Y}! $*${C_RESET}"; }

PASSED=(); FAILED=(); SKIPPED=()
record() { # record <phase> <pass|fail|skip> <detail>
  case "$2" in
    pass) PASSED+=("$1") ;;
    fail) FAILED+=("$1") ;;
    skip) SKIPPED+=("$1 — $3") ;;
  esac
}

# Run a command, tee to a log, record pass/fail. Prereq phases abort on failure.
phase() { # phase <name> <logfile> <abort-on-fail:0|1> <cmd...>
  local name="$1" log="$2" abort="$3"; shift 3
  say "$name"
  ( "$@" ) 2>&1 | tee "$OUT_DIR/$log"
  local rc="${PIPESTATUS[0]}"
  if [[ "$rc" -eq 0 ]]; then ok "$name"; record "$name" pass
  else bad "$name (see $OUT_DIR/$log)"; record "$name" fail
       if [[ "$abort" == "1" ]]; then finish; fi
  fi
  return 0
}

finish() {
  # ── evidence bundle ──────────────────────────────────────────────
  { echo "# prove-e2e run $RUN_ID"; echo; echo "commit: $(git rev-parse HEAD 2>/dev/null) ($(git rev-parse --abbrev-ref HEAD 2>/dev/null))"; echo "mode: $MODE"; echo "node: $(node -v 2>/dev/null)"; echo "pnpm: $(pnpm -v 2>/dev/null)"; echo "docker: $(docker --version 2>/dev/null)"; echo; echo "## phases"; } > "$OUT_DIR/RESULT.md"
  local p; for p in "${PASSED[@]:-}"; do [[ -n "$p" ]] && echo "- PASS: $p" >> "$OUT_DIR/RESULT.md"; done
  for p in "${FAILED[@]:-}"; do [[ -n "$p" ]] && echo "- FAIL: $p" >> "$OUT_DIR/RESULT.md"; done
  for p in "${SKIPPED[@]:-}"; do [[ -n "$p" ]] && echo "- SKIP: $p" >> "$OUT_DIR/RESULT.md"; done

  git rev-parse HEAD > "$OUT_DIR/commit.txt" 2>/dev/null || true
  { docker compose -f infrastructure/docker/docker-compose.tier1.yml ps 2>&1 || true; } > "$OUT_DIR/tier1-ps.txt"
  { docker compose -f infrastructure/docker/docker-compose.tier2.yml ps 2>&1 || true; } > "$OUT_DIR/tier2-ps.txt"

  printf '\n%s\n' "${C_B}════════════════════════════════════════${C_RESET}"
  printf 'phases: %d passed, %d failed, %d skipped\n' "${#PASSED[@]}" "${#FAILED[@]}" "${#SKIPPED[@]}"
  for p in "${FAILED[@]:-}"; do [[ -n "$p" ]] && bad "failed: $p"; done
  for p in "${SKIPPED[@]:-}"; do [[ -n "$p" ]] && warn "skipped: $p"; done
  echo "evidence: $OUT_DIR"
  if [[ "${#FAILED[@]}" -eq 0 ]]; then printf '%s\n' "${C_G}PROOF RUN GREEN — every phase executed passed ✓${C_RESET}"; else printf '%s\n' "${C_R}PROOF RUN INCOMPLETE — fix the failed phases above${C_RESET}"; fi
  exit "${#FAILED[@]}"
}

# ── Phase 0: preflight ────────────────────────────────────────────
say "preflight"
PREFLIGHT_FAIL=0
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && ok "docker daemon reachable" || { bad "docker missing or daemon not running"; PREFLIGHT_FAIL=1; }
docker compose version >/dev/null 2>&1 && ok "compose v2 present" || { bad "docker compose v2 missing"; PREFLIGHT_FAIL=1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -ge 24 && "$NODE_MAJOR" -le 25 ]]; then ok "node v$(node -v)"; else warn "node $(node -v 2>/dev/null) — engines want >=24 <=25; continuing, but use nvm for a faithful run"; fi
command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm -v)" || { bad "pnpm missing (run: corepack enable)"; PREFLIGHT_FAIL=1; }
AVAIL_GB="$(df -Pk . | awk 'NR==2{printf "%d", $4/1024/1024}')"
if [[ "${AVAIL_GB:-0}" -ge 20 ]]; then ok "disk ${AVAIL_GB}GB free"; else warn "disk ${AVAIL_GB}GB free (<20GB): ClamAV/Kafka images may not fit"; fi
PORTS_BUSY="$(ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -oE ':(5432|9000|9001|3100|3101|3102|3103|8080|8081|9092|29092|3310)$' | sort -u | tr '\n' ' ' || true)"
[[ -z "$PORTS_BUSY" ]] && ok "required ports free" || warn "ports already in use: ${PORTS_BUSY}- if infra is already up, use --no-infra"
[[ -f .env ]] && ok ".env present" || warn ".env missing — will be generated"
# Every package.json script is a documented command. Two of them shipped pointing at
# files that NEVER existed (docker-compose.infra.yml / docker-compose.mocks.yml) and
# stayed broken because CI calls the compose files directly. This check is what makes
# that class of defect visible instead of tribal knowledge.
say "script-reference check (package.json → paths that exist)"
MISSING_REFS="$(node -e '
const p=require("./package.json"); const fs=require("fs"); const out=[];
for (const [k,cmd] of Object.entries(p.scripts)) {
  const toks = cmd.match(/(?:\.\/)?(?:scripts|infrastructure|docs|packages|services|\.github)\/[A-Za-z0-9._\/-]+/g) || [];
  for (const t of toks) if (!fs.existsSync(t)) out.push(`${k} -> ${t}`);
}
process.stdout.write(out.join("\n"));
' 2>/dev/null || echo "")"
if [[ -z "$MISSING_REFS" ]]; then ok "every script reference exists"; record "script-reference check" pass
else bad "scripts point at missing files:"; printf '    %s\n' $MISSING_REFS; record "script-reference check" fail; fi

[[ "$PREFLIGHT_FAIL" == "1" ]] && { bad "preflight failed — install/start Docker and retry"; record "preflight" fail; finish; }
record "preflight" pass
{ echo "commit under test: $(git rev-parse HEAD)"; echo "branch: $(git rev-parse --abbrev-ref HEAD)"; } | tee "$OUT_DIR/00-fingerprint.txt"

# ── Phase 0b: ref assertion (never checks out) ────────────────────
if [[ -n "$EXPECT_REF" ]]; then
  HEAD_SHA="$(git rev-parse HEAD)"; EXPECT_SHA="$(git rev-parse "$EXPECT_REF" 2>/dev/null || echo '')"
  if [[ -n "$EXPECT_SHA" && "$HEAD_SHA" == "$EXPECT_SHA" ]]; then ok "HEAD == $EXPECT_REF ($HEAD_SHA)"; record "ref $EXPECT_REF matches HEAD" pass
  else bad "HEAD ($HEAD_SHA) != $EXPECT_REF (${EXPECT_SHA:-unknown})"; record "ref assertion" fail; finish; fi
fi

# ── Phase 1: install ──────────────────────────────────────────────
phase "install (pnpm --frozen-lockfile)" 01-install.log 1 pnpm install --frozen-lockfile

# ── Phase 2: static gates ─────────────────────────────────────────
phase "static: turbo build (expect 20/20)"     02-build.log     0 pnpm turbo run build
# The build above is what makes dist/ represent src/. This asserts it REALLY does —
# the failure it prevents is a stale, gitignored dist/ from another branch, which
# surfaces as "does not provide an export named X" inside whichever proof first
# imports the new symbol (see Appendix D, D4).
phase "workspace build matches src (declared exports exist in dist)" 02b-build-check.log 0 node scripts/check-workspace-build.mjs
phase "static: turbo typecheck (expect 34/34)" 03-typecheck.log 0 pnpm turbo run typecheck
phase "static: turbo test (expect 19/19)"      04-test.log      0 pnpm turbo run test

# ── Phase 3: env file ─────────────────────────────────────────────
if [[ ! -f .env ]]; then
  phase "generate .env (fresh dev keypairs)" 05-env.log 1 pnpm generate:env
else
  ok ".env already present (left untouched)"; record "env file" pass
fi

# ── Phase 4: infrastructure ───────────────────────────────────────
if [[ "$NO_INFRA" == "1" ]]; then
  warn "infra: skipped (--no-infra) — assuming Postgres/mocks/Mist up"; record "infra bring-up" skip "--no-infra"
else
  if [[ "$RESET" == "1" ]]; then
    warn "--reset: dropping the Postgres volume (the database will be rebuilt)"
    phase "reset infra volume (destructive)" 06-reset.log 1 pnpm infra:reset
  fi
  phase "infra: tier1 (Postgres + MinIO + G2G mocks)" 06-tier1.log 1 pnpm infra:up:tier1
  if [[ "$MODE" == "full" ]]; then
    phase "infra: tier2 (Kafka + schema-registry + ClamAV)" 07-tier2.log 1 pnpm infra:up:tier2
    # CI parity: kafka-init is a ONE-SHOT that must exit 0 (it creates the topics,
    # including events.dead-letter). `up --wait` would count any exited container as
    # failure, so it is started separately and its exit code asserted here — the same
    # way .github/workflows/ci-backend.yml does it.
    say "assert kafka-init exited 0 (topics created)"
    INIT_EXIT="$(docker wait usrp-kafka-init 2>/dev/null || echo 'unavailable')"
    if [[ "$INIT_EXIT" == "0" ]]; then ok "kafka-init exit 0"; record "kafka-init exit 0" pass
    else bad "kafka-init exit '$INIT_EXIT' — topics may be missing (docker logs usrp-kafka-init)"; record "kafka-init exit 0" fail; fi
  else
    warn "tier2 skipped in --quick: Kafka/MinIO/ClamAV proofs will be skipped, not faked"; record "infra: tier2" skip "--quick"
  fi
fi

# ── Phase 5: wait for health ──────────────────────────────────────
say "wait for Postgres to accept connections (up to 90s)"
PG_OK=0
for i in $(seq 1 45); do
  if docker exec -i usrp-postgres pg_isready -U usrp_admin -d usrp_db >/dev/null 2>&1; then PG_OK=1; break; fi
  sleep 2
done
if [[ "$PG_OK" == "1" ]]; then ok "Postgres ready"; record "postgres ready" pass
else bad "Postgres did not become ready — docker logs usrp-postgres"; record "postgres ready" fail; finish; fi

# ── Phase 6: bootstrap DB ─────────────────────────────────────────
phase "bootstrap database (drizzle + rls/0001-0025 + dev officers)" 08-bootstrap.log 1 pnpm bootstrap:db

# ── Phase 7: the proofs ───────────────────────────────────────────
run_gate_proof() { # run_gate_proof <label> <path>
  local label="$1" path="$2"
  say "proof: $label"
  bash -c "source <(grep '^export ' scripts/run-selfchecks.sh); npx tsx '$path'" 2>&1 \
    | tee "$OUT_DIR/proof-$(basename "$path" .ts).log"
  local rc="${PIPESTATUS[0]}"
  if [[ "$rc" -eq 0 ]]; then ok "$label"; record "proof: $label" pass; else bad "$label"; record "proof: $label" fail; fi
}

if [[ "$MODE" == "full" ]]; then
  phase "THE GATE (scripts/run-selfchecks.sh — RLS isolation + all proofs + dev boot)" 09-gate.log 0 pnpm verify
else
  say "RLS cross-agency isolation (verify-isolation.sql)"
  if docker exec -i usrp-postgres psql -U usrp_admin -d usrp_db -v ON_ERROR_STOP=1 -q \
       < packages/shared-database/src/rls/verify-isolation.sql > "$OUT_DIR/proof-rls-isolation.log" 2>&1; then
    ok "RLS isolation"; record "proof: rls isolation" pass
  else bad "RLS isolation"; record "proof: rls isolation" fail; fi

  # The DB-only subset: no Kafka, no MinIO, no ClamAV — still the spine's core invariants.
  run_gate_proof "schema drift"            packages/shared-database/selfcheck/verify-schema-drift.ts
  run_gate_proof "iam: token issuer loop-closer (login → token → app-service)" services/iam-service/selfcheck/verify-iam-issuer-slice.ts
  run_gate_proof "identity: applicant auth (register → OTP → session)"          services/identity-service/selfcheck/verify-applicant-auth-slice.ts
  run_gate_proof "application: submission integrity (idempotency ledger)"       services/application-service/selfcheck/verify-submission-integrity.ts
  run_gate_proof "scheduling: slot integrity (capacity, redelivery)"            services/scheduling-service/selfcheck/verify-slot-integrity.ts
  run_gate_proof "eligibility: age gate"                                        services/eligibility-service/selfcheck/verify-age-eligibility.ts
  run_gate_proof "field-sync: offline capture + CRDT"                           services/field-sync-service/selfcheck/verify-field-sync-slice.ts
  run_gate_proof "notification: invitation delivery"                            services/notification-service/selfcheck/verify-notification-slice.ts
  run_gate_proof "edge: socket boundary + session security"                     services/edge-gateway/selfcheck/verify-edge-security.ts
  run_gate_proof "edge: shared rate-limit store"                                services/edge-gateway/selfcheck/verify-rate-limit-store.ts
  # The dev-boot proof boots all 12 services and waits on every /ready — several of
  # which depend on Kafka (tier2). It runs inside `pnpm verify` (full mode); in quick
  # mode it is deliberately skipped rather than faked.
  record "proof: dev boot (12 services)" skip "--quick (several /ready probes need tier2 Kafka)"
fi

# ── Phase 8: teardown guidance (infra left running by design) ─────
say "teardown (optional — infra is left running so you can inspect it)"
echo "  pnpm infra:down"
echo "  docker compose -f infrastructure/docker/docker-compose.tier2.yml down"
echo "  pnpm infra:reset   # destructive: drops the DB volume"
record "teardown guidance" pass

finish

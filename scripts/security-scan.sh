#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# security-scan.sh — the repo's own security gate.
#
# `pnpm security:scan` has pointed at this file for months and the file did
# not exist, so the command failed with 'No such file or directory'. Same
# class of defect as `pnpm generate:env` before ebdc5b4: a package.json
# script that documents an intention nobody could execute.
#
# ci-backend.yml calls the trivy-action DIRECTLY instead of calling this
# script, which is why the gate stayed green on a broken contract. What runs
# here is a SUPERSET of the CI job, so CI can be pointed at it later.
#
# Checks are AGGREGATED: every one runs, then the script exits non-zero once
# with a summary. Fixing security findings one redeploy at a time is how the
# last three get skipped.
#
# Usage:  bash scripts/security-scan.sh [--skip-trivy] [--skip-audit]
# ══════════════════════════════════════════════════════════════════
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Pinned to match ci-backend.yml's trivy-action release. An unpinned :latest
# is an unpinned supply-chain dependency, which is the reason the action is
# pinned there too.
TRIVY_IMAGE='aquasec/trivy:0.58.1'

SKIP_TRIVY=0
SKIP_AUDIT=0
for arg in "$@"; do
  case "$arg" in
    --skip-trivy) SKIP_TRIVY=1 ;;
    --skip-audit) SKIP_AUDIT=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[0;36m\u25b6 %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m\u2713 %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m! %s\033[0m\n' "$*"; }
bad()  { printf '\033[0;31m\u2717 %s\033[0m\n' "$*" >&2; }

FAILURES=()
fail_check() { FAILURES+=("$1"); bad "$1"; }

printf '\n\033[1mUSRP security scan\033[0m\n\n'

# ── 1. No secret-bearing files are TRACKED ───────────────────────────
# .gitignore is a request. This is the check. A committed .env or *.key is
# unrecoverable once pushed — rotation is the only remedy, so catch it here.
log 'checking that no secret files are tracked by git'
TRACKED_SECRETS=$(git ls-files -- \
  '.env' '.env.*' '**/.env' '**/.env.*' \
  '*.pem' '*.key' '*.p12' '*.pfx' '*.jks' '*.keystore' \
  2>/dev/null | grep -v -E '^\.env\.example$' || true)
if [[ -n "$TRACKED_SECRETS" ]]; then
  fail_check "secret-bearing files are tracked by git:"
  printf '%s\n' "$TRACKED_SECRETS" | sed 's/^/      /' >&2
else
  ok 'no tracked .env / key / keystore files'
fi

# ── 2. No inline private key material outside the allowlist ────────────
# Committed dev key material legitimately lives in exactly three places:
# .env.example (the template), scripts/ (the proof/dev keypair) and docs/.
# A PEM block anywhere else — a service, a proof fixture, a manifest — is
# either a real leak or a dev key on its way to becoming one.
log 'scanning tracked files for inline private key material'
KEY_HITS=$(git grep -l -E 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' -- \
  ':!.env.example' ':!scripts/*' ':!docs/*' 2>/dev/null || true)
if [[ -n "$KEY_HITS" ]]; then
  fail_check 'inline PRIVATE KEY block found outside .env.example / scripts / docs:'
  printf '%s\n' "$KEY_HITS" | sed 's/^/      /' >&2
else
  ok 'no stray private key blocks'
fi

# ── 3. No placeholder leakage ──────────────────────────────────────
# CHANGE_ME belongs in .env.example and nowhere else. In a Compose file, a
# k8s manifest or a service default it is a DEPLOYABLE placeholder — the
# thing assertProductionSecrets() refuses at boot, caught earlier and
# cheaper. production-guard.ts is excluded: it contains the pattern itself.
log 'checking for placeholder secrets outside .env.example'
PLACEHOLDER_HITS=$(git grep -l -E 'CHANGE_ME|REPLACE_ME|INSERT_YOUR' -- \
  ':!.env.example' ':!docs/*' ':!scripts/security-scan.sh' \
  ':!packages/shared-config/src/production-guard.ts' 2>/dev/null || true)
if [[ -n "$PLACEHOLDER_HITS" ]]; then
  fail_check 'placeholder secret markers found outside .env.example:'
  printf '%s\n' "$PLACEHOLDER_HITS" | sed 's/^/      /' >&2
else
  ok 'placeholders confined to .env.example'
fi

# ── 4. Trivy filesystem scan ─────────────────────────────────────
# Same severity gate as CI: CRITICAL+HIGH, ignore-unfixed. When neither a
# binary nor Docker is available this SKIPS LOUDLY rather than passing — a
# scanner that silently no-ops is worse than no scanner, because it produces
# a green line nobody investigates.
if [[ $SKIP_TRIVY -eq 1 ]]; then
  warn 'trivy scan skipped (--skip-trivy)'
elif command -v trivy >/dev/null 2>&1; then
  log 'running trivy filesystem scan (CRITICAL,HIGH)'
  if trivy fs --scanners vuln,secret,misconfig --severity CRITICAL,HIGH \
      --ignore-unfixed --exit-code 1 .; then
    ok 'trivy: no CRITICAL/HIGH findings'
  else
    fail_check 'trivy reported CRITICAL/HIGH findings (see output above)'
  fi
elif command -v docker >/dev/null 2>&1; then
  log "running trivy via docker ($TRIVY_IMAGE)"
  if docker run --rm -v "$REPO_ROOT:/repo:ro" -w /repo "$TRIVY_IMAGE" \
      fs --scanners vuln,secret,misconfig --severity CRITICAL,HIGH \
      --ignore-unfixed --exit-code 1 .; then
    ok 'trivy: no CRITICAL/HIGH findings'
  else
    fail_check 'trivy reported CRITICAL/HIGH findings (see output above)'
  fi
else
  warn 'NOT SCANNED: neither a trivy binary nor docker is available.'
  warn 'This is a GAP in this run, not a pass. Install trivy or run in CI.'
fi

# ── 5. Dependency audit ───────────────────────────────────────────
if [[ $SKIP_AUDIT -eq 1 ]]; then
  warn 'pnpm audit skipped (--skip-audit)'
elif command -v pnpm >/dev/null 2>&1; then
  log 'running pnpm audit (--audit-level high)'
  if pnpm audit --audit-level high; then
    ok 'pnpm audit: no high/critical advisories'
  else
    fail_check 'pnpm audit reported high/critical advisories'
  fi
else
  warn 'NOT AUDITED: pnpm is not on PATH. This is a GAP, not a pass.'
fi

# ── Summary ──────────────────────────────────────────────────────
printf '\n'
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  bad "security scan FAILED — ${#FAILURES[@]} finding(s):"
  for f in "${FAILURES[@]}"; do printf '    • %s\n' "$f" >&2; done
  printf '\n'
  exit 1
fi
ok 'security scan passed'
printf '\n'

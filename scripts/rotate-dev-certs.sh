#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# rotate-dev-certs.sh — rotate BOTH Ed25519 dev keypairs in an existing .env.
#
# `pnpm certs:rotate` has pointed at this file for months and the file did
# not exist. Same defect as security-scan.sh, and it matters more than it
# looks: rotation is the ONLY remedy after dev key material leaks, and the
# committed template's keys are public in git by design. A team with no
# rotation command rotates by hand, inconsistently, or not at all.
#
# TWO SEPARATE KEYPAIRS, ALWAYS — the same invariant generate-env.sh asserts:
#
#   AUTH_JWT_*  the bearer-token trust anchor. iam-service SIGNS; every other
#               service VERIFIES with the public half only.
#   QR_*        the slot-invitation trust anchor, whose PUBLIC half is handed
#               to OFFLINE field devices at exam gates.
#
# Collapsing them would put the token-minting anchor on every tablet, so one
# stolen device would forge bearer tokens as well as slot invitations.
# Different trust domain -> different custody -> different rotation. This
# script refuses to write if the two ever come out equal.
#
# NOT FOR PRODUCTION. Production keys live in an HSM/KMS and are rotated by
# the custodian of that HSM, never by a shell script against a file. This
# refuses to run when NODE_ENV=production for exactly that reason.
#
# Usage:  bash scripts/rotate-dev-certs.sh [--auth-only|--qr-only] [--force]
#           --auth-only  rotate the bearer-token keypair only
#           --qr-only    rotate the slot-invitation keypair only
#           --force      overwrite an existing backup from today
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ROTATE_AUTH=1
ROTATE_QR=1
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --auth-only) ROTATE_QR=0 ;;
    --qr-only)   ROTATE_AUTH=0 ;;
    --force)     FORCE=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[0;36m\u25b6 %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m\u2713 %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m! %s\033[0m\n' "$*"; }
fail() { printf '\033[0;31m\u2717 %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f .env ]] || fail '.env not found — run `pnpm generate:env` first'
command -v openssl >/dev/null 2>&1 || fail 'openssl is required to mint keypairs'

# Refuse on a production environment. A file-based rotation of a production
# trust anchor is not a rotation, it is an outage with extra steps.
ENV_NODE_ENV=$(grep -E '^NODE_ENV=' .env | head -1 | cut -d= -f2- | tr -d "'\"" || true)
if [[ "${NODE_ENV:-}" == 'production' || "$ENV_NODE_ENV" == 'production' ]]; then
  fail 'NODE_ENV=production — refusing. Production keys live in an HSM/KMS and are rotated there.'
fi

# Timestamped backup. Rotating the AUTH keypair invalidates every token in
# flight; an operator who did not mean to needs a way back.
BACKUP=".env.bak.$(date +%Y%m%d)"
if [[ -f "$BACKUP" && $FORCE -eq 0 ]]; then
  fail "$BACKUP already exists — pass --force to overwrite it"
fi
cp .env "$BACKUP"
chmod 600 "$BACKUP"
log "backed up .env -> $BACKUP"

# base64 never contains |, so | is a safe sed delimiter for these values.
subst() {
  local key=$1 value=$2
  grep -qE "^${key}=" .env || fail "${key} missing from .env — template drift; re-run generate:env"
  sed -i "s|^${key}=.*|${key}='${value}'|" .env
}

mint_pair() {
  local tmp_priv tmp_pub
  tmp_priv=$(mktemp)
  tmp_pub=$(mktemp)
  openssl genpkey -algorithm ed25519 -out "$tmp_priv" 2>/dev/null
  openssl pkey -in "$tmp_priv" -pubout -out "$tmp_pub" 2>/dev/null
  MINTED_PRIV=$(base64 -w0 < "$tmp_priv")
  MINTED_PUB=$(base64 -w0 < "$tmp_pub")
  rm -f "$tmp_priv" "$tmp_pub"
}

# Read the CURRENT public halves so the distinctness assertion still holds
# when only one keypair is being rotated — a partial rotation must not be
# allowed to converge the two trust domains either.
current_value() {
  grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d "'\""
}
AUTH_PUB=$(current_value AUTH_JWT_PUBLIC_KEY_B64)
QR_PUB=$(current_value QR_INVITATION_PUBLIC_KEY_B64)

if [[ $ROTATE_AUTH -eq 1 ]]; then
  log 'minting a new bearer-token keypair (AUTH_JWT_*)'
  mint_pair
  subst AUTH_JWT_PRIVATE_KEY_B64 "$MINTED_PRIV"
  subst AUTH_JWT_PUBLIC_KEY_B64 "$MINTED_PUB"
  AUTH_PUB="$MINTED_PUB"
fi

if [[ $ROTATE_QR -eq 1 ]]; then
  log 'minting a new slot-invitation keypair (QR_*)'
  mint_pair
  subst QR_SIGNING_PRIVATE_KEY_B64 "$MINTED_PRIV"
  subst QR_INVITATION_PUBLIC_KEY_B64 "$MINTED_PUB"
  QR_PUB="$MINTED_PUB"
  # The key id is what offline field devices pin their trust to — a rotated
  # key under an unchanged id is indistinguishable from the old one to a
  # tablet that has not synced.
  subst QR_SIGNING_KEY_ID "dev-qr-key-$(date +%Y%m%d%H%M%S)"
fi

# The entire point of two keypairs — assert they really are two. Restore the
# backup rather than leaving a converged .env behind.
if [[ "$AUTH_PUB" == "$QR_PUB" ]]; then
  cp "$BACKUP" .env
  fail 'AUTH and QR keypairs are identical — restored the backup and refused to write'
fi

chmod 600 .env
ok 'rotated (mode 600), AUTH and QR trust anchors verified distinct'

printf '\n\033[1mThis rotation is NOT live until you do the following:\033[0m\n'
if [[ $ROTATE_AUTH -eq 1 ]]; then
  printf '  1. Restart ALL services — every bearer token in flight is now invalid,\n'
  printf '     and each verifier caches the public half at boot.\n'
  printf '  2. Re-seed the dev service clients so identity-service can still obtain a\n'
  printf '     system token:  services/iam-service/scripts/seed-dev-officers.ts\n'
fi
if [[ $ROTATE_QR -eq 1 ]]; then
  printf '  3. Re-issue any outstanding QR slot invitations — biometric-service verifies\n'
  printf '     them against the NEW public half and will reject the old ones at the gate.\n'
fi
printf '\n  restore:  cp %s .env\n\n' "$BACKUP"
warn 'delete the backup once you are satisfied — it holds the previous private keys'

#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# generate-env.sh — render .env from .env.example.
#
# The root package.json has advertised `pnpm generate:env` for months while
# this file did not exist. The only route to a working .env was the
# `cp .env.example .env` inside setup-dev.sh — which is precisely how a
# stale template went unnoticed for ~30 slices: the tool that would have
# surfaced the drift was never written.
#
# By DEFAULT it mints FRESH dev keypairs instead of copying the well-known
# ones out of the template, so no two clones share signing material even in
# development. TWO SEPARATE Ed25519 keypairs are generated, never one:
#
#   AUTH_JWT_*  — the bearer-token trust anchor (iam-service signs; every
#                 other service verifies with the public half)
#   QR_*        — the slot-invitation trust anchor, whose PUBLIC half is
#                 distributed to OFFLINE field devices at exam gates
#
# Collapsing those into one keypair would ship the token-minting trust
# anchor to every tablet, so a single stolen device would forge bearer
# tokens as well as slot invitations. The script asserts they really are
# distinct before writing — the dev default must match the prod design.
#
# Usage:  bash scripts/generate-env.sh [--force] [--keep-keys]
#           --force      overwrite an existing .env
#           --keep-keys  keep the template's committed dev keys (use when a
#                        teammate or proof needs matching key material)
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FORCE=0
KEEP_KEYS=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --keep-keys) KEEP_KEYS=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[0;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f .env.example ]] || fail '.env.example is missing'
command -v openssl >/dev/null 2>&1 || fail 'openssl is required to mint dev keys'

if [[ -f .env && $FORCE -eq 0 ]]; then
  fail '.env already exists — pass --force to overwrite (it is gitignored)'
fi

log 'rendering .env from .env.example'
cp .env.example .env

if [[ $KEEP_KEYS -eq 1 ]]; then
  chmod 600 .env
  ok '.env rendered — kept the template dev keys (--keep-keys)'
  exit 0
fi

# base64 never contains |, so | is a safe sed delimiter for these values.
subst() {
  local key=$1 value=$2
  grep -qE "^${key}=" .env || fail "${key} missing from .env.example — template drift"
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

log 'minting the bearer-token keypair (AUTH_JWT_*)'
mint_pair
subst AUTH_JWT_PRIVATE_KEY_B64 "$MINTED_PRIV"
subst AUTH_JWT_PUBLIC_KEY_B64 "$MINTED_PUB"
AUTH_PUB="$MINTED_PUB"

log 'minting a SEPARATE slot-invitation keypair (QR_*)'
mint_pair
subst QR_SIGNING_PRIVATE_KEY_B64 "$MINTED_PRIV"
subst QR_INVITATION_PUBLIC_KEY_B64 "$MINTED_PUB"

# The entire point of two keypairs — assert they really are two.
[[ "$MINTED_PUB" != "$AUTH_PUB" ]] || fail 'QR and AUTH keypairs are identical — refusing to write'

chmod 600 .env
ok '.env rendered with two distinct freshly-minted dev keypairs (mode 600)'
printf '  next: \033[0;36mpnpm dev\033[0m\n'

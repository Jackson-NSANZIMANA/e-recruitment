#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# up.sh — bring up as much of the USRP proof stack as is possible WITHOUT
# Docker, for sandboxes and CI runners where no container runtime exists.
#
# THIS IS A FALLBACK, NOT A REPLACEMENT FOR `pnpm infra:up`.
# Docker remains the supported path and the one CI uses. Use this only when
# there is no daemon. It brings up, natively:
#
#   * PostgreSQL 16 (real server, from the npm-distributed binaries)
#   * the four G2G registry mocks (the SAME server.js the containers run)
#
# It CANNOT bring up Kafka, MinIO or ClamAV — see "What this cannot do".
#
# Measured result on a clean sandbox: `bash scripts/run-selfchecks.sh`
# goes from 11 passed / 43 failed (no infra) to 43 passed / 11 failed,
# and every one of the 11 remaining failures is a connection error to a
# service this script cannot start — zero logic failures.
#
# Usage:
#   bash tools/native-stack/up.sh          # start everything + bootstrap
#   bash tools/native-stack/up.sh --stop   # stop what it started
#
# Then, in the shell you run proofs from:
#   export PATH="$PWD/tools/native-stack/bin:$PATH"   # psql + docker shims
#   bash scripts/run-selfchecks.sh
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_DIR="${NATIVE_STACK_DIR:-$HOME/.usrp-native-stack}"
PG_VERSION="${PG_VERSION:-16.14.0-beta.17}"   # matches compose's postgres:16
PGROOT="$STACK_DIR/pg/package/native"
PGDATA="$STACK_DIR/pgdata"
PGPORT="${PGPORT:-5432}"
PIDFILE="$STACK_DIR/pids"

log()  { printf '\033[0;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m! %s\033[0m\n' "$*"; }
fail() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── stop ──────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
  # Deliberately NOT pidfile-only. A second (idempotent) up.sh run truncates
  # the pidfile and short-circuits start_mock when a port is already bound, so
  # the pidfile can be empty while the mocks are very much alive — that bug
  # once left all four registries running after a "successful" --stop. Stop by
  # identity instead, and verify the ports actually freed.
  if [[ -f "$PIDFILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && { kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; }
    done < "$PIDFILE"
    rm -f "$PIDFILE"
  fi

  # The four G2G mocks, matched on this repo's own mocks path so nothing
  # unrelated on the box is touched.
  pkill -f "$REPO_ROOT/infrastructure/docker/mocks/[a-z]*/server.js" 2>/dev/null || true

  if [[ -d "$PGDATA" && -x "$PGROOT/bin/pg_ctl" ]]; then
    LD_LIBRARY_PATH="$PGROOT/lib" "$PGROOT/bin/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
  fi

  sleep 1
  leftover=""
  for p in "${PGPORT}" 3100 3101 3102 3103; do
    (printf '' > "/dev/tcp/127.0.0.1/$p") 2>/dev/null && leftover="$leftover $p"
  done
  if [[ -n "$leftover" ]]; then
    warn "still listening after stop:$leftover"
    exit 1
  fi
  ok "native stack stopped (5432, 3100-3103 all free)"
  exit 0
fi

mkdir -p "$STACK_DIR"
: > "$PIDFILE"

# ── 1. PostgreSQL binaries ────────────────────────────────────────────
# The Debian mirrors are unreachable in the target sandbox, but the npm
# registry is. embedded-postgres republishes real PostgreSQL builds, so the
# server comes from there. It ships initdb/pg_ctl/postgres but NO psql —
# hence bin/psql in this directory.
if [[ ! -x "$PGROOT/bin/postgres" ]]; then
  log "fetching PostgreSQL $PG_VERSION from npm"
  mkdir -p "$STACK_DIR/pg" && cd "$STACK_DIR/pg"
  npm pack "@embedded-postgres/linux-x64@${PG_VERSION}" >/dev/null 2>&1 \
    || fail "could not fetch @embedded-postgres/linux-x64@${PG_VERSION}"
  tar xzf embedded-postgres-linux-x64-*.tgz && rm -f ./*.tgz
  # The bundled libs are named libfoo.so.N.M but the ELF headers ask for
  # libfoo.so.N, so the loader needs the usual soname symlinks.
  cd "$PGROOT/lib"
  for f in *.so.*; do
    base="$(echo "$f" | sed -E 's/\.so\.([0-9]+)\..*/.so.\1/')"
    [[ "$base" != "$f" && ! -e "$base" ]] && ln -sf "$f" "$base"
  done
  cd "$REPO_ROOT"
  ok "PostgreSQL $("$PGROOT/bin/postgres" --version 2>/dev/null | awk '{print $3}') unpacked"
fi
export LD_LIBRARY_PATH="$PGROOT/lib"

# ── 2. cluster ────────────────────────────────────────────────────────
if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  log "initdb (superuser usrp_admin, as the compose file declares)"
  rm -rf "$PGDATA"; mkdir -p "$PGDATA" "$STACK_DIR/run"
  printf 'usrp_dev_password\n' > "$STACK_DIR/pw"; chmod 600 "$STACK_DIR/pw"
  "$PGROOT/bin/initdb" -D "$PGDATA" -U usrp_admin --pwfile="$STACK_DIR/pw" \
    -E UTF8 --locale=C >/dev/null || fail "initdb failed"
  ok "cluster initialised"
fi

if ! (printf '' > "/dev/tcp/127.0.0.1/$PGPORT") 2>/dev/null; then
  log "starting PostgreSQL on 127.0.0.1:$PGPORT"
  mkdir -p "$STACK_DIR/run"
  # setsid+nohup so the server outlives this script's shell (and any
  # tooling that kills the script's process group when it exits).
  setsid nohup "$PGROOT/bin/postgres" -D "$PGDATA" -p "$PGPORT" -k "$STACK_DIR/run" \
    -c listen_addresses=127.0.0.1 -c max_connections=200 \
    > "$STACK_DIR/postgres.log" 2>&1 < /dev/null &
  echo $! >> "$PIDFILE"
  for _ in $(seq 1 40); do
    (printf '' > "/dev/tcp/127.0.0.1/$PGPORT") 2>/dev/null && break
    sleep 0.25
  done
fi
(printf '' > "/dev/tcp/127.0.0.1/$PGPORT") 2>/dev/null \
  || fail "PostgreSQL did not come up — see $STACK_DIR/postgres.log"
ok "PostgreSQL accepting connections on $PGPORT"

export PATH="$REPO_ROOT/tools/native-stack/bin:$PATH"
export PGHOST=127.0.0.1 PGPORT="$PGPORT"

# ── 3. database ───────────────────────────────────────────────────────
if ! psql -U usrp_admin -d usrp_db -c 'select 1' >/dev/null 2>&1; then
  log "creating database usrp_db"
  psql -U usrp_admin -d postgres -c 'CREATE DATABASE usrp_db OWNER usrp_admin' >/dev/null
fi
ok "database usrp_db present"

# ── 4. G2G registry mocks ─────────────────────────────────────────────
# Run the containers' own server.js directly. Same code, same data files,
# same ports and env as docker-compose.tier1.yml declares.
MOCKS="$REPO_ROOT/infrastructure/docker/mocks"
if [[ ! -d "$STACK_DIR/node_modules/express" ]]; then
  log "installing express for the mocks"
  (cd "$STACK_DIR" && npm install --silent --no-save express@4 >/dev/null 2>&1) \
    || fail "could not install express"
fi
export NODE_PATH="$STACK_DIR/node_modules"

start_mock() {
  local name="$1" port="$2" data="$3" secret="${4:-}"
  if (printf '' > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    warn "port $port already in use — assuming $name is up"
    # Re-adopt it so --stop can still find it after an idempotent re-run.
    pgrep -f "$MOCKS/$name/server.js" 2>/dev/null >> "$PIDFILE" || true
    return
  fi
  # Launch via the ABSOLUTE script path: the process cmdline is what --stop
  # matches on, and a relative "nida/server.js" is unmatchable once the shell
  # that set the cwd is gone.
  ( cd "$MOCKS" && PORT="$port" MOCK_DATA_FILE="$MOCKS/$data" HMAC_SECRET="$secret" \
      setsid nohup node "$MOCKS/$name/server.js" > "$STACK_DIR/$name.log" 2>&1 < /dev/null &
    echo $! >> "$PIDFILE" )
}
log "starting the four G2G registry mocks"
start_mock nida 3100 nida/data/citizens.json dev_nida_hmac_secret
start_mock nesa 3101 nesa/data/results.json  dev_nesa_hmac_secret
start_mock rib  3102 rib/data/records.json   dev_rib_hmac_secret
start_mock hec  3103 hec/data/degrees.json
for p in 3100 3101 3102 3103; do
  for _ in $(seq 1 40); do (printf '' > "/dev/tcp/127.0.0.1/$p") 2>/dev/null && break; sleep 0.25; done
  (printf '' > "/dev/tcp/127.0.0.1/$p") 2>/dev/null || fail "mock on $p did not start"
done
ok "NIDA:3100 NESA:3101 RIB:3102 HEC:3103 healthy"

# ── 5. schema, RLS, officers ──────────────────────────────────────────
# bootstrap-db.sh is run UNMODIFIED; the docker shim on PATH routes its
# `docker exec -i usrp-postgres psql ...` calls to the native server.
log "bootstrapping the database (scripts/bootstrap-db.sh, unmodified)"
cd "$REPO_ROOT"
DATABASE_URL="postgresql://usrp_admin:usrp_dev_password@localhost:$PGPORT/usrp_db" \
  bash scripts/bootstrap-db.sh >"$STACK_DIR/bootstrap.log" 2>&1 \
  || fail "bootstrap failed — see $STACK_DIR/bootstrap.log"
ok "schema + RLS + officer accounts in place"

[[ -f "$REPO_ROOT/.env" ]] || { log "rendering .env"; pnpm generate:env >/dev/null 2>&1 || warn "generate:env failed"; }

cat <<EOF

$(printf '\033[0;32m✓ native stack up\033[0m')

  Postgres   127.0.0.1:$PGPORT   usrp_admin / usrp_dev_password / usrp_db
  G2G mocks  3100 NIDA  3101 NESA  3102 RIB  3103 HEC

  Run the proofs with the shims on PATH:

    export PATH="\$PWD/tools/native-stack/bin:\$PATH"
    bash scripts/run-selfchecks.sh

  Expect 43 passed / 11 failed. What this cannot do:

    Kafka  (8 proofs)  needs a JVM or a broker binary; the only reachable
                       origin in the target sandbox is registry.npmjs.org,
                       and node-jre/java-jre DOWNLOAD a JRE at install time
                       from hosts that are blocked.
    MinIO  (2 proofs)  dl.min.io is blocked.
    ClamAV (1, shared) no clamd binary on npm, and the virus DB fetch is
                       blocked. Stubbing it would fake the very thing the
                       forensics proof exists to check, so it is left failing.

  Those 11 are proven green by CI on real Docker. Stop with:
    bash tools/native-stack/up.sh --stop
EOF

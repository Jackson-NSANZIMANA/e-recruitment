#!/usr/bin/env bash
# pnpm sandbox:full — the WHOLE system, every unit, production-shaped, on one machine.
#
#   pnpm sandbox:full                     boot everything (idempotent: what is already up is reused)
#   pnpm sandbox:full --real-sms          the owner's real Twilio, guarded to TWILIO_TO (see below)
#   pnpm sandbox:full --journeys          also play every citizen journey through the real edge
#   pnpm sandbox:full --kafka-ui          also a Kafka UI on the sandbox broker (:4994, +256 MB)
#   pnpm sandbox:full --rebuild           rebuild the services, and the three apps past the turbo cache (--force)
#   pnpm sandbox:full --lan               the three apps also over HTTPS on this machine's LAN address (below)
#   pnpm sandbox:full --status            what is running
#   pnpm sandbox:full --down              stop what this script started (data kept)
#
# What comes up, in order:
#   1. tier1 infrastructure     Postgres (5432), RIB and HEC mocks
#   2. the sandbox (ADR-047)    own Kafka (:4992), G2G simulators (:4900: NIDA, NESA, Irembo, Twilio),
#                               the 12 services under NODE_ENV=production + USRP_ENVIRONMENT=sandbox with
#                               freshly minted secrets, the document door with its own MinIO (:4993) and
#                               ClamAV (:4995), the edge (:4921)
#   3. data                     the six real campaigns (policy v2 as printed) and the clearance matrix;
#                               synthetic personas exported to .sandbox/personas
#   4. the three apps           PRODUCTION builds made by the frontend's own build (its root `pnpm build`,
#                               i.e. turbo, filtered to one app and its workspace dependencies), each served
#                               by the app's own `preview` script on its own origin with /edge proxied to the
#                               edge, as one deployed domain would be:
#                               applicant portal :4930, officer console :4931, Field Station :4932
#
# The frontend checkout: USRP_UI_DIR, else ../e-recruitment-ui next to this repository (or next to the
# worktrees/ folder). Real SMS: --real-sms reads ~/.config/usrp/twilio.env (chmod 600, outside every git
# work tree; TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_TO) and the owner's private persona
# from ~/.config/usrp/persona when present. Every destination except TWILIO_TO is refused before Twilio is
# called, and --journeys is refused with --real-sms (the synthetic population has real-looking numbers).
#
# The frontend repository owns how its apps are built: this script never calls vite itself, never picks an
# output directory and keeps no build stamp of its own. The bundles are the apps' ordinary dist/ folders and
# Turbo's cache decides what is rebuilt (sources, workspace packages, lockfile and every VITE_* variable are
# in its hash). Build time and serve time get different VITE_EDGE_URLs, on purpose:
#   build    the app's OWN origin (http://localhost:4930 ...), baked into the bundle as the browser's API
#            origin, so every /edge request is same-origin
#   preview  the real edge (:4921), read by the app's vite.config.ts as the /edge proxy target
#
# On the network (--lan, or SANDBOX_EXPOSE_LAN=1): the apps are built for https://<lan-ip>:4930/4931/4932
# and infrastructure/sandbox/tls-proxy.mjs serves them there, from this machine and from any phone, tablet or
# laptop on the same network. ONLY those three ports leave loopback: the previews, the edge, the twelve
# services, Postgres and Kafka stay on 127.0.0.1, and every /edge call reaches the edge through the app's own
# same-origin proxy, so the session cookies keep their production form (Secure, __Host-). The certificate
# comes from a sandbox CA made once in ~/.config/usrp/sandbox-ca (SANDBOX_CA_DIR), name-constrained to
# private addresses; each device trusts its ca.crt once (http://<lan-ip>:4930/usrp-sandbox-ca.crt, compare
# the printed fingerprint). SANDBOX_LAN_ADDRESS picks the address when the machine has several. Without the
# flag nothing changes: http://localhost as before. Guide: docs/sandbox/README.md.
#
# It stops nothing it did not start: processes are recorded in .sandbox/pids and stopped only while they
# still run from this repository or the frontend checkout.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
STATE="$REPO/.sandbox"; LOGS="$STATE/logs"; PIDS="$STATE/pids"
export SANDBOX_DB="${SANDBOX_DB:-usrp_sandbox}" SANDBOX_FORENSICS=1 REHEARSAL_COEXIST=1
EDGE="http://localhost:4921"
CA_DIR="${SANDBOX_CA_DIR:-$HOME/.config/usrp/sandbox-ca}"; TLS="$STATE/tls"
APPS=("applicant-portal:4930" "officer-console:4931" "field-station:4932")

REAL_SMS=0; JOURNEYS=0; KAFKA_UI=0; REBUILD=0; LAN=0; ACTION=up
[ "${SANDBOX_EXPOSE_LAN:-}" = 1 ] && LAN=1
for arg in "$@"; do
  case "$arg" in
    --real-sms) REAL_SMS=1 ;; --journeys) JOURNEYS=1 ;; --kafka-ui) KAFKA_UI=1 ;; --rebuild) REBUILD=1 ;; --lan) LAN=1 ;;
    --down) ACTION=down ;; --status) ACTION=status ;;
    *) echo "✗ unknown option $arg (see the header of $0)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[0;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null; }
busy() { ss -H -ltn "sport = :$1" | grep -q .; }
# An https answer that only counts when the certificate verifies against the sandbox CA.
tls_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 --cacert "$CA_DIR/ca.crt" "$1" 2>/dev/null; }

# This machine's LAN address: SANDBOX_LAN_ADDRESS, else the source address of the default route.
lan_address() {
  local ip="${SANDBOX_LAN_ADDRESS:-}"
  [ -n "$ip" ] || ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  [ -n "$ip" ] || ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [ -n "$ip" ] || ip="$(node -e 'for (const a of Object.values(require("os").networkInterfaces()).flat()) if (a.family === "IPv4" && !a.internal) { process.stdout.write(a.address); break; }')"
  printf '%s' "$ip"
}
# The addresses the sandbox CA may vouch for (its name constraints): private networks and loopback only.
private_ipv4() {
  [[ "$1" =~ ^(10\.|192\.168\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)([0-9]{1,3}\.){1,2}[0-9]{1,3}$ ]]
}

UI="${USRP_UI_DIR:-}"
if [ -z "$UI" ]; then
  for candidate in "$REPO/../e-recruitment-ui" "$REPO/../../e-recruitment-ui"; do
    [ -d "$candidate/apps/applicant-portal" ] && UI="$(cd "$candidate" && pwd)" && break
  done
fi

# A recorded PID is stopped only while it still runs from one of our checkouts (a reboot reuses PIDs).
stop_recorded() { # name
  local file="$PIDS/$1" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  # The command line may be relative (vite, pnpm): the working directory decides, the command line otherwise.
  if { readlink "/proc/$pid/cwd" 2>/dev/null; ps -o command= -p "$pid" 2>/dev/null; } | grep -qF -e "$REPO" -e "${UI:-/nonexistent}"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

status() {
  printf '\n%-28s %s\n' "UNIT" "STATE"
  local p
  for p in "g2g simulators:4900" "identity:4901" "eligibility:4902" "biometric:4903" "document-forensics:4904" \
           "background-vetting:4905" "application:4906" "scheduling:4907" "notification:4908" "field-sync:4909" \
           "audit:4910" "iam:4911" "edge gateway:4921"; do
    local path=/ready; [ "${p##*:}" = 4900 ] && path=/health
    printf '%-28s %s\n' "${p%%:*} :${p##*:}" "$([ "$(code "http://localhost:${p##*:}$path")" = 200 ] && echo "✓ ready" || echo "✗ down")"
  done
  for a in "${APPS[@]}"; do
    printf '%-28s %s\n' "${a%%:*} :${a##*:}" "$([ "$(code "http://localhost:${a##*:}/")" = 200 ] && echo "✓ production bundle" || echo "✗ down")"
  done
  if [ -f "$PIDS/web-tls" ] && [ -s "$TLS/address" ]; then
    local ip; ip="$(cat "$TLS/address")"
    for a in "${APPS[@]}"; do
      printf '%-28s %s\n' "${a%%:*} (LAN)" "$([ "$(tls_code "https://$ip:${a##*:}/")" = 200 ] && echo "✓ https://$ip:${a##*:}" || echo "✗ https://$ip:${a##*:} not answering")"
    done
  fi
  docker ps --format '{{.Names}}\t{{.Status}}' | grep -E '^usrp-' | while IFS=$'\t' read -r n s; do printf '%-28s %s\n' "$n" "$s"; done
  printf '%-28s %s\n' "SMS" "$(grep -o 'SMS: [^·]*' "$LOGS/sandbox-up.out" 2>/dev/null | tail -1)"
  if [ -f "$PIDS/web-tls" ] && [ -s "$TLS/address" ]; then
    printf '%-28s %s\n' "Exposure" "⚠ the three apps on https://$(cat "$TLS/address"):4930-4932; edge, services, data on loopback"
  else
    local exposure; exposure="$(grep -o 'Exposure: [^·]*' "$LOGS/sandbox-up.out" 2>/dev/null | tail -1)"
    case "$exposure" in
      *"LOOPBACK ONLY"*) exposure="loopback only (every process); --lan puts the three apps on the network over HTTPS" ;;
      *) exposure="${exposure#Exposure: }" ;;
    esac
    printf '%-28s %s\n' "Exposure" "$(printf '%s' "$exposure" | cut -c1-100)"
  fi
  printf '%-28s %s\n' "memory available" "$(free -h | awk '/^Mem/{print $7}') of $(free -h | awk '/^Mem/{print $2}')"
}

if [ "$ACTION" = status ]; then status; exit 0; fi

if [ "$ACTION" = down ]; then
  stop_recorded web-tls
  for a in "${APPS[@]}"; do stop_recorded "web-${a%%:*}"; done
  docker rm -f usrp-sandbox-kafka-ui >/dev/null 2>&1 || true
  pnpm -s sandbox:down
  echo "✓ the apps, the services and the sandbox broker are stopped (database and state kept; tier1 Postgres left running)"
  exit 0
fi

# The package an app directory holds, provided the frontend still gives it the two scripts this file relies
# on (`build` for turbo to run, `preview` to serve dist/). Prints the package name; fails with the reason.
ui_app_package() { # app
  node -e '
    const [dir, app] = process.argv.slice(1);
    let pkg;
    try { pkg = JSON.parse(require("fs").readFileSync(dir + "/apps/" + app + "/package.json", "utf8")); }
    catch { console.error("apps/" + app + "/package.json is missing or unreadable"); process.exit(1); }
    const missing = ["build", "preview"].filter((s) => !pkg.scripts?.[s]);
    if (missing.length) { console.error(pkg.name + " has no " + missing.join(" or ") + " script"); process.exit(1); }
    process.stdout.write(pkg.name);' "$UI" "$1"
}

# ── preflight ─────────────────────────────────────────────────────
[ -n "$UI" ] || die "the frontend checkout was not found; set USRP_UI_DIR=/path/to/e-recruitment-ui"
[ -d "$UI" ] || die "USRP_UI_DIR=$UI does not exist; point it at the frontend checkout (e-recruitment-ui)"
for f in package.json pnpm-lock.yaml turbo.json; do
  [ -f "$UI/$f" ] || die "$UI has no $f: it is not the frontend workspace; set USRP_UI_DIR=/path/to/e-recruitment-ui"
done
declare -A UI_PKG
for a in "${APPS[@]}"; do
  UI_PKG[${a%%:*}]="$(ui_app_package "${a%%:*}" 2>&1)" || die "the frontend checkout $UI cannot build ${a%%:*}: ${UI_PKG[${a%%:*}]}"
done
command -v docker >/dev/null || die "docker is required"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
if [ "$LAN" = 1 ] && [ "$REAL_SMS" = 1 ]; then
  die "SANDBOX_EXPOSE_LAN=1 (--lan) cannot be combined with --real-sms (ADR-053): a network-reachable sandbox with live SMS behind it"
fi
# Here the APPS are what the network reaches, over TLS, and the edge stays on loopback behind their /edge
# proxies. The launcher's own SANDBOX_EXPOSE_LAN binds the edge (plain http) to the LAN address instead,
# where neither those proxies nor any readiness check (127.0.0.1) can reach it, so it is not passed on.
unset SANDBOX_EXPOSE_LAN
if [ "$REAL_SMS" = 1 ]; then
  [ "$JOURNEYS" = 0 ] || die "--journeys with --real-sms would text the synthetic population; run them on the emulator"
  export SANDBOX_SMS=twilio SANDBOX_TWILIO_ENV_FILE="${SANDBOX_TWILIO_ENV_FILE:-$HOME/.config/usrp/twilio.env}"
  [ -f "$SANDBOX_TWILIO_ENV_FILE" ] || die "--real-sms needs $SANDBOX_TWILIO_ENV_FILE"
  if [ -z "${SANDBOX_PRIVATE_PERSONA_DIR:-}" ] && [ -d "$HOME/.config/usrp/persona" ]; then export SANDBOX_PRIVATE_PERSONA_DIR="$HOME/.config/usrp/persona"; fi
fi
mkdir -p "$LOGS" "$PIDS"; chmod 700 "$STATE"
if [ "$LAN" = 1 ]; then
  LAN_IP="$(lan_address)"
  [ -n "$LAN_IP" ] || die "--lan: this machine has no LAN IPv4 address; connect it to the network, or set SANDBOX_LAN_ADDRESS"
  private_ipv4 "$LAN_IP" || die "--lan: $LAN_IP is not a private address (10/8, 172.16/12, 192.168/16, 100.64/10): the sandbox is for a local network, and its CA can only vouch for private addresses. Set SANDBOX_LAN_ADDRESS to this machine's address on that network."
  CA_FINGERPRINT="$(bash "$REPO/infrastructure/sandbox/lan-certs.sh" "$CA_DIR" "$TLS" "$LAN_IP" 2> "$LOGS/full-lan-certs.out")" \
    || { cat "$LOGS/full-lan-certs.out" >&2; die "--lan: the certificates for $LAN_IP could not be made; see $LOGS/full-lan-certs.out"; }
fi
avail_mb="$(free -m | awk '/^Mem/{print $7}')"
[ "$avail_mb" -ge 2500 ] || printf '\033[0;33m! only %s MB available: the full system wants ~4 GB (ClamAV alone ~1.3 GB). Close heavy apps for honest timings.\033[0m\n' "$avail_mb"

# ── 1. tier1 infrastructure ───────────────────────────────────────
say "tier1: Postgres, RIB and HEC mocks"
docker compose -f infrastructure/docker/docker-compose.tier1.yml up -d --wait postgres rib-mock hec-mock > "$LOGS/full-tier1.out" 2>&1 \
  || die "tier1 did not come up; see $LOGS/full-tier1.out"

# ── 2. build ──────────────────────────────────────────────────────
# Always, not only when node_modules is absent: a pull can add a workspace package that needs linking.
say "backend dependencies"; pnpm install --frozen-lockfile --prefer-offline > "$LOGS/full-install.out" 2>&1 || die "pnpm install failed"
if [ "$REBUILD" = 1 ] || ! node scripts/check-workspace-build.mjs > /dev/null 2>&1; then
  say "building the services"
  pnpm exec turbo run build > "$LOGS/full-build.out" 2>&1 || die "the build failed; see $LOGS/full-build.out"
fi

# ── 3. the sandbox and its data ───────────────────────────────────
if [ "$(code "$EDGE/edge/v1/session")" = 000 ]; then
  # A reboot leaves PID files behind; the launcher only stops what still runs from here.
  pnpm -s sandbox:down > /dev/null 2>&1 || true
fi
say "sandbox: broker, simulators, 12 services, document door, six campaigns (database $SANDBOX_DB)"
bash infrastructure/sandbox/up.sh > "$LOGS/full-up.out" 2>&1 || { tail -5 "$LOGS/full-up.out" >&2; die "sandbox:up failed; see $LOGS/full-up.out"; }
[ "$(code http://localhost:4904/ready)" = 200 ] \
  || printf '\033[0;33m! the running sandbox was started without the document door; run --down, then again\033[0m\n'
say "clearance matrix and personas"
USRP_SANDBOX=1 USRP_SANDBOX_STATE="$STATE" pnpm -s rehearse --sandbox clearance-matrix > "$LOGS/full-stage-clearance.out" 2>&1 || true
for scenario in rdf-2026 rnp-basic-2025 rcs-junior-2025 rcs-officer-2026-4y clearance-matrix; do
  USRP_SANDBOX=1 USRP_SANDBOX_STATE="$STATE" pnpm -s rehearse --sandbox "$scenario" --journey --export-personas > "$LOGS/full-personas-$scenario.out" 2>&1 \
    || printf '\033[0;33m! could not export the %s personas; see %s\033[0m\n' "$scenario" "$LOGS/full-personas-$scenario.out"
done

# ── 4. the three apps: the frontend's own build, served by its own preview ──
# Always, like the backend install above: a pull of the frontend can add a workspace package that needs linking.
say "frontend dependencies ($UI)"
(cd "$UI" && pnpm install --frozen-lockfile --prefer-offline) > "$LOGS/full-ui-install.out" 2>&1 \
  || die "the frontend install (pnpm install --frozen-lockfile in $UI) failed; see $LOGS/full-ui-install.out"
anchor="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).QR_INVITATION_PUBLIC_KEY_B64 ?? '')" "$STATE/secrets.json" 2>/dev/null)"
force=""; [ "$REBUILD" = 1 ] && force="--force"
# The origin each app is built for: where the browser loads it. --lan bakes the https LAN address.
app_origin() { if [ "$LAN" = 1 ]; then printf 'https://%s:%s' "$LAN_IP" "$1"; else printf 'http://localhost:%s' "$1"; fi; }
# The TLS front shares the app ports (LAN address vs loopback); it is restarted after the previews below, so
# a preview that has to be started again never finds its port held by it.
stop_recorded web-tls
[ -d "$STATE/web" ] && printf '\033[0;33m! %s holds bundles from the previous launcher and is no longer used; it can be deleted\033[0m\n' "$STATE/web"
for a in "${APPS[@]}"; do
  app="${a%%:*}"; port="${a##*:}"; pkg="${UI_PKG[$app]}"
  # One turbo run per app, because each app is built for its own origin: a single `pnpm build` would give
  # all three the same VITE_EDGE_URL. `--filter=$pkg...` is the app and every workspace package it depends on.
  say "building $app: pnpm build --filter=$pkg... ${force:+$force }(the frontend's own build, sandbox banner on)"
  ( cd "$UI" && VITE_EDGE_URL="$(app_origin "$port")" VITE_USRP_SANDBOX=1 VITE_FIELD_STATION_URL="$(app_origin 4932)" \
      VITE_SLOT_TRUST_ANCHOR_B64="$anchor" pnpm run build --filter="$pkg..." --ui=stream --no-daemon ${force:+"$force"} ) \
      > "$LOGS/full-build-$app.out" 2>&1 \
    || { tail -15 "$LOGS/full-build-$app.out" >&2; die "the $app build failed; see $LOGS/full-build-$app.out"; }
  [ -f "$UI/apps/$app/dist/index.html" ] || die "the $app build succeeded but left no apps/$app/dist/index.html; see $LOGS/full-build-$app.out"
  printf '  %s\n' "$(grep -E '^ *Cached:' "$LOGS/full-build-$app.out" | tail -1 | sed 's/^ *//')"
  # A preview this script started keeps serving: vite preview reads dist/ on every request, so it serves the
  # build that just finished. Anything else on the port is not ours to replace.
  if [ "$(code "http://localhost:$port/")" = 200 ] && [ -f "$PIDS/web-$app" ]; then continue; fi
  busy "$port" && die ":$port is busy with a server this script did not start; stop it first"
  # exec setsid: the recorded PID IS the server's session leader (pnpm, then the app's `vite preview`), and
  # nothing keeps this script's stdout open.
  ( cd "$UI/apps/$app" || exit 1; VITE_EDGE_URL="$EDGE" exec setsid pnpm run preview --port "$port" --strictPort ) \
    > "$LOGS/full-web-$app.out" 2>&1 < /dev/null &
  echo $! > "$PIDS/web-$app"
done
for a in "${APPS[@]}"; do
  for _ in $(seq 1 30); do [ "$(code "http://localhost:${a##*:}/")" = 200 ] && break; sleep 1; done
  [ "$(code "http://localhost:${a##*:}/")" = 200 ] \
    || printf '\033[0;33m! %s did not answer on :%s; see %s\033[0m\n' "${a%%:*}" "${a##*:}" "$LOGS/full-web-${a%%:*}.out"
done
if [ "$LAN" = 1 ]; then
  say "HTTPS on the network: https://$LAN_IP:4930, :4931, :4932 (only these three ports leave loopback)"
  maps=(); for a in "${APPS[@]}"; do maps+=("$LAN_IP:${a##*:}=${a##*:}"); done
  ( exec setsid node "$REPO/infrastructure/sandbox/tls-proxy.mjs" --cert "$TLS/server.crt" --key "$TLS/server.key" \
      --ca "$CA_DIR/ca.crt" "${maps[@]}" ) > "$LOGS/full-web-tls.out" 2>&1 < /dev/null &
  echo $! > "$PIDS/web-tls"
  for _ in $(seq 1 20); do grep -q 'tls-proxy ready' "$LOGS/full-web-tls.out" 2>/dev/null && break; kill -0 "$(cat "$PIDS/web-tls")" 2>/dev/null || break; sleep 0.5; done
  grep -q 'tls-proxy ready' "$LOGS/full-web-tls.out" \
    || { cat "$LOGS/full-web-tls.out" >&2; stop_recorded web-tls; die "--lan: the HTTPS front did not start; see $LOGS/full-web-tls.out"; }
  for a in "${APPS[@]}"; do
    [ "$(tls_code "https://$LAN_IP:${a##*:}/")" = 200 ] \
      || printf '\033[0;33m! https://%s:%s does not answer with a certificate the sandbox CA verifies; see %s\033[0m\n' "$LAN_IP" "${a##*:}" "$LOGS/full-web-tls.out"
  done
fi

# ── 5. optional ───────────────────────────────────────────────────
if [ "$KAFKA_UI" = 1 ] && ! docker ps --format '{{.Names}}' | grep -qx usrp-sandbox-kafka-ui; then
  say "Kafka UI on :4994"
  docker rm -f usrp-sandbox-kafka-ui >/dev/null 2>&1 || true
  docker run -d --name usrp-sandbox-kafka-ui --network host -m 256m -e SERVER_PORT=4994 -e SERVER_ADDRESS=127.0.0.1 \
    -e KAFKA_CLUSTERS_0_NAME=usrp-sandbox -e KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS=localhost:4992 provectuslabs/kafka-ui:latest > /dev/null \
    || printf '\033[0;33m! Kafka UI did not start\033[0m\n'
fi
if [ "$JOURNEYS" = 1 ]; then
  say "playing every sandbox journey through the edge"
  bash infrastructure/sandbox/journeys.sh 2>&1 | tee "$LOGS/full-journeys.out" | grep -E 'PASSED|FAILED|✗' || true
fi

status
cat <<EOF

✓ sandbox:full is up
  applicant portal   $(app_origin 4930)   citizens: synthetic personas in .sandbox/personas (OTP: .sandbox/sms/inbox.jsonl$( [ "$REAL_SMS" = 1 ] && echo '; REAL SMS to TWILIO_TO only'))
  officer console    $(app_origin 4931)   rdf.admin / rnp.admin / rcs.admin (second admin: *.admin2), password RehearsalAdmin#2026
                                             station staff reh.<agency>.gate.*, reh.<agency>.reviewer, reh.<agency>.supervisor: RehearsalStaff#2026
  field station      $(app_origin 4932)
  edge               $EDGE     simulators :4900 (behaviour switch: header x-usrp-sandbox-behaviour)
  logs               $LOGS     guide: docs/sandbox/README.md
  stop               pnpm sandbox:full --down
EOF
if [ "$LAN" = 1 ]; then
  cat <<EOF

  ON THE NETWORK (this machine and every device on it; open the https addresses above, not localhost)
  trust the CA once per device   http://$LAN_IP:4930/usrp-sandbox-ca.crt  (or $CA_DIR/ca.crt)
    SHA-256 fingerprint          $CA_FINGERPRINT
  a device that cannot connect   allow 4930-4932/tcp in this machine's firewall (ufw: sudo ufw allow 4930:4932/tcp)
EOF
fi

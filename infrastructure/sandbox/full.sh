#!/usr/bin/env bash
# pnpm sandbox:full — the WHOLE system, every unit, production-shaped, on one machine.
#
#   pnpm sandbox:full                     boot everything (idempotent: what is already up is reused)
#   pnpm sandbox:full --real-sms          the owner's real Twilio, guarded to TWILIO_TO (see below)
#   pnpm sandbox:full --journeys          also play every citizen journey through the real edge
#   pnpm sandbox:full --kafka-ui          also a Kafka UI on the sandbox broker (:4994, +256 MB)
#   pnpm sandbox:full --rebuild           rebuild the services, and the three apps past the turbo cache (--force)
#   pnpm sandbox:full --lan               the three apps also over HTTPS on this machine's LAN address (below)
#   pnpm sandbox:full --lan-real-sms      --lan AND --real-sms together: the APPLICANT PORTAL ONLY on the
#                                         network, live Twilio behind it, guarded to TWILIO_TO (ADR-053 §3.5)
#   SANDBOX_LAN_APPS=...                  which apps leave loopback under --lan: a comma-separated list of
#                                         applicant-portal, officer-console, field-station, or 'all'.
#                                         Defaults to all three; to the applicant portal alone with live SMS.
#   pnpm sandbox:full --no-staging        boot without staging the campaigns, rehearsal staff and personas
#                                         (an empty database stays empty; see pnpm sandbox:clean)
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
# --lan with --real-sms is refused unless --lan-real-sms (or SANDBOX_I_ACCEPT_LAN_SMS=1) acknowledges it;
# that exception serves the applicant portal ALONE on the network and never exposes the edge (ADR-053 §3.5).
#
# The frontend repository owns how its apps are built: this script never calls vite itself, never picks an
# output directory and keeps no build stamp of its own. The bundles are the apps' ordinary dist/ folders and
# Turbo's cache decides what is rebuilt (sources, workspace packages, lockfile and every VITE_* variable are
# in its hash). Build time and serve time get different VITE_EDGE_URLs, on purpose:
#   build    the app's OWN origin (http://localhost:4930 ...), baked into the bundle as the browser's API
#            origin, so every /edge request is same-origin
#   preview  the real edge (:4921), read by the app's vite.config.ts as the /edge proxy target
#
# What is served is always a build this script can name. Before building, Turbo's dry run gives each app's
# task hash; a preview this script started is kept only while it serves that exact hash and the same
# dist/index.html. Otherwise the preview is stopped BEFORE dist/ is rebuilt (never serving it half-written)
# and started again only on success; a failed build leaves that app NOT served, and --status says so.
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
# Which of those leave loopback under --lan. Narrowed to the applicant portal alone when live SMS is
# behind it (ADR-053 §3.5): the officer console and field station carry staff credentials, and the
# citizen journey is the only one that needs a phone on the network.
LAN_APPS=("${APPS[@]}")

REAL_SMS=0; JOURNEYS=0; KAFKA_UI=0; REBUILD=0; LAN=0; STAGE=1; ACTION=up
# The narrowed ADR-053 escape hatch: set ONLY by --lan-real-sms or SANDBOX_I_ACCEPT_LAN_SMS=1, and it
# never reaches the launcher's own SANDBOX_EXPOSE_LAN (raw edge on the LAN), which stays absolutely barred.
ALLOW_LAN_SMS=0
[ "${SANDBOX_I_ACCEPT_LAN_SMS:-}" = 1 ] && ALLOW_LAN_SMS=1
[ "${SANDBOX_EXPOSE_LAN:-}" = 1 ] && LAN=1
for arg in "$@"; do
  case "$arg" in
    --real-sms) REAL_SMS=1 ;; --lan-real-sms) LAN=1; REAL_SMS=1; ALLOW_LAN_SMS=1 ;; --journeys) JOURNEYS=1 ;; --kafka-ui) KAFKA_UI=1 ;; --rebuild) REBUILD=1 ;; --lan) LAN=1 ;; --no-staging) STAGE=0 ;;
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

# Is this PID still a process of ours? It must be alive and run from one of our checkouts (a reboot reuses
# PIDs). The command line may be relative (vite, pnpm): the working directory decides, the command line otherwise.
ours() { # pid
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null \
    && { readlink "/proc/$1/cwd" 2>/dev/null; ps -o command= -p "$1" 2>/dev/null; } | grep -qF -e "$REPO" -e "${UI:-/nonexistent}"
}
# Is anything left of the process group this recorded PID leads (or of the PID itself)?
group_alive() { kill -0 -- "-$1" 2>/dev/null || kill -0 "$1" 2>/dev/null; }
# The recorded PID leads a group (setsid). It is ours while the leader is ours, or, once the leader has
# exited first (pnpm dies on SIGTERM before its `vite preview` child has closed the port), while a process
# still in that group is ours.
group_ours() { # pid
  [ -n "$1" ] || return 1
  ours "$1" && return 0
  local member
  for member in $(ps -eo pid=,pgid= 2>/dev/null | awk -v g="$1" '$2 == g { print $1 }'); do ours "$member" && return 0; done
  return 1
}
# A recorded PID is stopped only while it is still ours, and the WHOLE group is waited for: the port belongs
# to the vite child, so waiting for pnpm alone found the port still held and refused it as someone else's.
stop_recorded() { # name
  local file="$PIDS/$1" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  if group_ours "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do group_alive "$pid" || break; sleep 0.1; done
    if group_alive "$pid"; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do group_alive "$pid" || break; sleep 0.1; done
    fi
  fi
  rm -f "$file"
}
# Who holds a port, so a refusal says what to stop instead of leaving the operator to find it. It never stops
# anything itself: a server with no record here may be someone else's. A preview of this very app, run from
# the frontend checkout, is named as the likely leftover of an earlier run that lost its record.
holder() { # port app
  local pid pgid cmd cwd
  for pid in $(ss -H -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    cmd="$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-120)"
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
    printf '  held by pid %s (group %s): %s\n' "$pid" "${pgid:-?}" "${cmd:-unknown}"
    [ -n "$cwd" ] && printf '  running in %s\n' "$cwd"
    if [ -n "$UI" ] && [ "$cwd" = "$UI/apps/$2" ] && [[ "$cmd" == *vite* ]]; then
      printf '  This looks like the %s preview left by an earlier sandbox run. Stop it, then run this again:\n    kill -TERM -- -%s\n' "$2" "${pgid:-$pid}"
    fi
  done
  [ -n "${pid:-}" ] || printf '  (ss could not name the process; try: sudo ss -ltnp "sport = :%s")\n' "$1"
}
# Is the app's port served by the preview this script recorded? Answering HTTP 200 is not proof: the recorded
# PID must be ours AND lead the process group of a process listening on that port (the PID is pnpm under
# setsid; the listener is the `vite preview` node process below it).
serving_ours() { # app port
  local pid listener
  pid="$(cat "$PIDS/web-$1" 2>/dev/null)"; ours "$pid" || return 1
  for listener in $(ss -H -ltnp "sport = :$2" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    [ "$(ps -o pgid= -p "$listener" 2>/dev/null | tr -d ' ')" = "$pid" ] && return 0
  done
  return 1
}
# The build the app's preview serves, as recorded when it was started: Turbo's task hash, the sha256 of the
# dist/index.html it served, and the environment it was built with (so --status can ask Turbo again).
state_get() { sed -n "s/^$2=//p" "$PIDS/web-$1.build" 2>/dev/null | head -1; }
index_sha() { sha256sum "$UI/apps/$1/dist/index.html" 2>/dev/null | cut -c1-64; }
# Turbo's hash for the app's build task under the given environment, from the frontend's own build script
# (`turbo run build --dry=json`): the same key Turbo uses to decide hit or miss. Empty when it cannot be had.
build_hash() { # pkg NAME=value...
  local pkg="$1"; shift
  (cd "$UI" && env "$@" pnpm -s run build --filter="$pkg..." --dry=json 2>/dev/null) | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const t = JSON.parse(s.slice(s.indexOf("{"))).tasks.find((x) => x.taskId === process.argv[1] + "#build");
            if (t) process.stdout.write(t.hash); } catch {} });' "$pkg"
}

# One line on what an app's port really serves.
app_state() { # app port
  local app="$1" port="$2" served pkg now benv=()
  if [ -f "$PIDS/web-$app.failed" ]; then
    echo "✗ not serving: the last build failed ($(sed -n 's/^log=//p' "$PIDS/web-$app.failed"))"; return
  fi
  if ! serving_ours "$app" "$port"; then
    [ "$(code "http://localhost:$port/")" = 200 ] && echo "⚠ answering, but not a server this sandbox started" || echo "✗ down"
    return
  fi
  served="$(state_get "$app" hash)"
  [ "$(index_sha "$app")" = "$(state_get "$app" index)" ] \
    || { echo "⚠ dist/ changed outside the sandbox since build ${served:0:8} (pnpm sandbox:full rebuilds it)"; return; }
  pkg="$(node -p "require('$UI/apps/$app/package.json').name" 2>/dev/null)"
  mapfile -t benv < <(sed -n 's/^env=//p' "$PIDS/web-$app.build" 2>/dev/null)
  now="$( [ -n "$pkg" ] && [ "${#benv[@]}" -gt 0 ] && build_hash "$pkg" "${benv[@]}")"
  if [ -z "$now" ]; then echo "✓ serving build ${served:0:8} (freshness unknown: turbo dry-run failed)"
  elif [ "$now" = "$served" ]; then echo "✓ serving build ${served:0:8}, current"
  else echo "⚠ serving build ${served:0:8}; the sources now build ${now:0:8} (pnpm sandbox:full)"; fi
}

# Is this app port on the LAN surface? Defined before status(): --status runs and exits before the boot section.
on_lan() { local p; for p in "${LAN_APPS[@]}"; do [ "${p##*:}" = "$1" ] && return 0; done; return 1; }
status() {
  printf '\n%-28s %s\n' "UNIT" "STATE"
  local p
  for p in "g2g simulators:4900" "identity:4901" "eligibility:4902" "biometric:4903" "document-forensics:4904" \
           "background-vetting:4905" "application:4906" "scheduling:4907" "notification:4908" "field-sync:4909" \
           "audit:4910" "iam:4911" "edge gateway:4921"; do
    local path=/ready; [ "${p##*:}" = 4900 ] && path=/health
    printf '%-28s %s\n' "${p%%:*} :${p##*:}" "$([ "$(code "http://localhost:${p##*:}$path")" = 200 ] && echo "✓ ready" || echo "✗ down")"
  done
  for a in "${APPS[@]}"; do printf '%-28s %s\n' "${a%%:*} :${a##*:}" "$(app_state "${a%%:*}" "${a##*:}")"; done
  if [ -f "$PIDS/web-tls" ] && [ -s "$TLS/address" ]; then
    local ip; ip="$(cat "$TLS/address")"
    # Only the apps on the LAN surface: under --lan-real-sms the other two are deliberately
    # loopback-only, and a ✗ row for them reads as a fault rather than as the decision it is.
    for a in "${LAN_APPS[@]}"; do
      printf '%-28s %s\n' "${a%%:*} (LAN)" "$([ "$(tls_code "https://$ip:${a##*:}/")" = 200 ] && echo "✓ https://$ip:${a##*:}" || echo "✗ https://$ip:${a##*:} not answering")"
    done
    for a in "${APPS[@]}"; do
      on_lan "${a##*:}" || printf '%-28s %s\n' "${a%%:*} (LAN)" "— loopback only by choice: http://localhost:${a##*:}"
    done
  fi
  docker ps --format '{{.Names}}\t{{.Status}}' | grep -E '^usrp-' | while IFS=$'\t' read -r n s; do printf '%-28s %s\n' "$n" "$s"; done
  printf '%-28s %s\n' "database" "$(node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r.db + " (complete boot " + r.startedAt + ")"); } catch { console.log("no complete boot recorded"); }' "$STATE/running.json")"
  printf '%-28s %s\n' "SMS" "$(grep -o 'SMS: [^·]*' "$LOGS/sandbox-up.out" 2>/dev/null | tail -1)"
  # ADR-047 §3.5: presence only, never the directory's contents or the identity's values. The simulator
  # reports it as a boolean on its own `sandbox_listening` line; a refused directory never gets this far
  # (loadPrivatePersona throws and :4900 does not come up at all).
  local overlay; overlay="$(grep -o '"overlay":[a-z]*' "$LOGS/g2g-sandbox.log" 2>/dev/null | tail -1)"
  case "$overlay" in
    '"overlay":true')  printf '%-28s %s\n' "private persona" "overlaid (PRIVATE)" ;;
    '"overlay":false') printf '%-28s %s\n' "private persona" "none (synthetic population only; set SANDBOX_PRIVATE_PERSONA_DIR to overlay yours)" ;;
    *)                 printf '%-28s %s\n' "private persona" "unknown (no sandbox_listening line yet in .sandbox/logs/g2g-sandbox.log)" ;;
  esac
  if [ -f "$PIDS/web-tls" ] && [ -s "$TLS/address" ]; then
    local served; served="$(cat "$TLS/ports" 2>/dev/null)"; [ -n "$served" ] || served="4930-4932"
    printf '%-28s %s\n' "Exposure" "⚠ on https://$(cat "$TLS/address") ports $served; edge, services, data on loopback"
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
  for a in "${APPS[@]}"; do stop_recorded "web-${a%%:*}"; rm -f "$PIDS/web-${a%%:*}.build" "$PIDS/web-${a%%:*}.failed"; done
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
[ "$STAGE" = 1 ] || [ "$JOURNEYS" = 0 ] || die "--journeys plays the staged rehearsal scenarios; it cannot run with --no-staging"
export SANDBOX_STAGE="$STAGE"
if [ "$LAN" = 1 ] && [ "$REAL_SMS" = 1 ] && [ "$ALLOW_LAN_SMS" != 1 ]; then
  die "SANDBOX_EXPOSE_LAN=1 (--lan) cannot be combined with --real-sms (ADR-053): a network-reachable sandbox with live SMS behind it. The owner-acknowledged exception is --lan-real-sms, which serves the applicant portal alone on the network (widen it deliberately with SANDBOX_LAN_APPS)."
fi
# Which apps leave loopback. Default: all three under --lan; the applicant portal ALONE when live SMS is
# behind it (ADR-053 §3.5). SANDBOX_LAN_APPS overrides either default with a comma-separated list of app
# names, or "all". Widening it under live SMS puts staff credentials on the network, so it says so loudly.
if [ -n "${SANDBOX_LAN_APPS:-}" ]; then
  wanted="${SANDBOX_LAN_APPS//,/ }"
  [ "$wanted" = all ] && wanted="$(printf '%s ' "${APPS[@]%%:*}")"
  LAN_APPS=()
  for want in $wanted; do
    match=""
    for a in "${APPS[@]}"; do [ "${a%%:*}" = "$want" ] && match="$a"; done
    [ -n "$match" ] || die "SANDBOX_LAN_APPS: unknown app '$want' (choose from ${APPS[*]%%:*}, or 'all')"
    LAN_APPS+=("$match")
  done
  [ "${#LAN_APPS[@]}" -gt 0 ] || die "SANDBOX_LAN_APPS is empty: name at least one app, or unset it for the default"
elif [ "$LAN" = 1 ] && [ "$REAL_SMS" = 1 ]; then
  LAN_APPS=("applicant-portal:4930")
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
# The document door's one-time work, visibly and untimed: a first boot builds MinIO from pinned source.
say "document door: MinIO image and ClamAV volume (a first boot builds MinIO from source: 3-10 min)"
pnpm -s --filter @usrp/g2g-sandbox sandbox prepare 2>&1 | tee "$LOGS/full-prepare.out" | sed 's/^/  /' 
[ "${PIPESTATUS[0]}" = 0 ] || die "the document door could not be prepared; see $LOGS/full-prepare.out"
say "sandbox: broker, simulators, 12 services, document door, six campaigns (database $SANDBOX_DB)"
bash infrastructure/sandbox/up.sh > "$LOGS/full-up.out" 2>&1 || { tail -5 "$LOGS/full-up.out" >&2; die "sandbox:up failed; see $LOGS/full-up.out"; }
[ "$(code http://localhost:4904/ready)" = 200 ] \
  || printf '\033[0;33m! the running sandbox was started without the document door; run --down, then again\033[0m\n'
if [ "$STAGE" = 1 ]; then
  say "clearance matrix and personas"
  USRP_SANDBOX=1 USRP_SANDBOX_STATE="$STATE" pnpm -s rehearse --sandbox clearance-matrix > "$LOGS/full-stage-clearance.out" 2>&1 || true
  for scenario in rdf-2026 rnp-basic-2025 rcs-junior-2025 rcs-officer-2026-4y clearance-matrix; do
    USRP_SANDBOX=1 USRP_SANDBOX_STATE="$STATE" pnpm -s rehearse --sandbox "$scenario" --journey --export-personas > "$LOGS/full-personas-$scenario.out" 2>&1 \
      || printf '\033[0;33m! could not export the %s personas; see %s\033[0m\n' "$scenario" "$LOGS/full-personas-$scenario.out"
  done
else
  say "no staging (--no-staging): no campaigns, rehearsal staff or personas are added"
  admins="$(docker exec usrp-postgres psql -U usrp_admin -d "$SANDBOX_DB" -tAc "SELECT string_agg(login_handle, ' ' ORDER BY login_handle) FROM public_core.officer_accounts WHERE 'agency_admin' = ANY(roles)" 2>/dev/null)"
  if [ -n "$admins" ]; then printf '  agency administrators: %s\n' "$admins"
  else printf '\033[0;33m! %s has no agency administrator, so nobody can sign in to the officer console: boot once without --no-staging to provision them\033[0m\n' "$SANDBOX_DB"; fi
fi

# ── 4. the three apps: the frontend's own build, served by its own preview ──
# Always, like the backend install above: a pull of the frontend can add a workspace package that needs linking.
say "frontend dependencies ($UI)"
(cd "$UI" && pnpm install --frozen-lockfile --prefer-offline) > "$LOGS/full-ui-install.out" 2>&1 \
  || die "the frontend install (pnpm install --frozen-lockfile in $UI) failed; see $LOGS/full-ui-install.out"
anchor="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).QR_INVITATION_PUBLIC_KEY_B64 ?? '')" "$STATE/secrets.json" 2>/dev/null)"
force=""; [ "$REBUILD" = 1 ] && force="--force"
# The origin each app is built for: where the browser loads it. --lan bakes the https LAN address.
app_origin() { if [ "$LAN" = 1 ] && on_lan "$1"; then printf 'https://%s:%s' "$LAN_IP" "$1"; else printf 'http://localhost:%s' "$1"; fi; }
# The TLS front shares the app ports (LAN address vs loopback); it is restarted after the previews below, so
# a preview that has to be started again never finds its port held by it.
stop_recorded web-tls
[ -d "$STATE/web" ] && printf '\033[0;33m! %s holds bundles from the previous launcher and is no longer used; it can be deleted\033[0m\n' "$STATE/web"
failed=(); started=()
for a in "${APPS[@]}"; do
  app="${a%%:*}"; port="${a##*:}"; pkg="${UI_PKG[$app]}"
  # One turbo run per app, because each app is built for its own origin: a single `pnpm build` would give
  # all three the same VITE_EDGE_URL. `--filter=$pkg...` is the app and every workspace package it depends on.
  benv=("VITE_EDGE_URL=$(app_origin "$port")" VITE_USRP_SANDBOX=1 "VITE_FIELD_STATION_URL=$(app_origin 4932)" "VITE_SLOT_TRUST_ANCHOR_B64=$anchor")
  hash="$(build_hash "$pkg" "${benv[@]}")"
  [ -n "$hash" ] || die "turbo could not plan the $app build (pnpm run build --filter=$pkg... --dry=json in $UI)"
  # Nothing to do only when it is provably the same: our own preview, started for this exact build, still
  # serving the dist/index.html it was started with (a developer's own `pnpm build` rewrites dist/ in place).
  if [ "$REBUILD" = 0 ] && serving_ours "$app" "$port" && [ "$(state_get "$app" hash)" = "$hash" ] \
     && [ -n "$(index_sha "$app")" ] && [ "$(index_sha "$app")" = "$(state_get "$app" index)" ]; then
    say "$app: serving build ${hash:0:8}, current"
    continue
  fi
  # Stop the preview BEFORE the build touches dist/: vite empties it and writes it again, and a preview kept
  # running through that serves pages without their entry script. A closed port says what is happening.
  stop_recorded "web-$app"; rm -f "$PIDS/web-$app.build"
  busy "$port" && die ":$port is busy with a server this script did not start; stop it first
$(holder "$port" "$app")"
  say "building $app (${hash:0:8}): pnpm build --filter=$pkg... ${force:+$force }(the frontend's own build, sandbox banner on)"
  if ! ( cd "$UI" && env "${benv[@]}" pnpm run build --filter="$pkg..." --ui=stream --no-daemon ${force:+"$force"} ) \
      > "$LOGS/full-build-$app.out" 2>&1 || [ ! -f "$UI/apps/$app/dist/index.html" ]; then
    # A failed build serves nothing: the previous bundle is not this source, and calling it current would lie.
    tail -15 "$LOGS/full-build-$app.out" >&2
    printf 'hash=%s\nlog=%s\n' "$hash" "$LOGS/full-build-$app.out" > "$PIDS/web-$app.failed"
    printf '\033[0;31m✗ the %s build failed; it is not served. See %s\033[0m\n' "$app" "$LOGS/full-build-$app.out" >&2
    failed+=("$app"); continue
  fi
  rm -f "$PIDS/web-$app.failed"
  printf '  %s\n' "$(grep -E '^ *Cached:' "$LOGS/full-build-$app.out" | tail -1 | sed 's/^ *//')"
  # exec setsid: the recorded PID IS the server's session leader (pnpm, then the app's `vite preview`), and
  # nothing keeps this script's stdout open.
  ( cd "$UI/apps/$app" || exit 1; VITE_EDGE_URL="$EDGE" exec setsid pnpm run preview --port "$port" --strictPort ) \
    > "$LOGS/full-web-$app.out" 2>&1 < /dev/null &
  echo $! > "$PIDS/web-$app"
  { printf 'hash=%s\nindex=%s\n' "$hash" "$(index_sha "$app")"; printf 'env=%s\n' "${benv[@]}"; } > "$PIDS/web-$app.build"
  started+=("$a")
done
for a in ${started[@]+"${started[@]}"}; do
  for _ in $(seq 1 30); do serving_ours "${a%%:*}" "${a##*:}" && [ "$(code "http://localhost:${a##*:}/")" = 200 ] && break; sleep 1; done
  [ "$(code "http://localhost:${a##*:}/")" = 200 ] \
    || printf '\033[0;33m! %s did not answer on :%s; see %s\033[0m\n' "${a%%:*}" "${a##*:}" "$LOGS/full-web-${a%%:*}.out"
done
if [ "$LAN" = 1 ]; then
  lan_ports="$(printf '%s ' "${LAN_APPS[@]##*:}" | sed 's/ $//')"
  say "HTTPS on the network: $LAN_IP, port(s) $lan_ports (only these leave loopback)"
  maps=(); for a in "${LAN_APPS[@]}"; do maps+=("$LAN_IP:${a##*:}=${a##*:}"); done
  printf '%s' "$(printf '%s ' "${LAN_APPS[@]##*:}" | sed 's/ $//')" > "$TLS/ports"
  ( exec setsid node "$REPO/infrastructure/sandbox/tls-proxy.mjs" --cert "$TLS/server.crt" --key "$TLS/server.key" \
      --ca "$CA_DIR/ca.crt" "${maps[@]}" ) > "$LOGS/full-web-tls.out" 2>&1 < /dev/null &
  echo $! > "$PIDS/web-tls"
  for _ in $(seq 1 20); do grep -q 'tls-proxy ready' "$LOGS/full-web-tls.out" 2>/dev/null && break; kill -0 "$(cat "$PIDS/web-tls")" 2>/dev/null || break; sleep 0.5; done
  grep -q 'tls-proxy ready' "$LOGS/full-web-tls.out" \
    || { cat "$LOGS/full-web-tls.out" >&2; stop_recorded web-tls; die "--lan: the HTTPS front did not start; see $LOGS/full-web-tls.out"; }
  for a in "${LAN_APPS[@]}"; do
    [ "$(tls_code "https://$LAN_IP:${a##*:}/")" = 200 ] \
      || printf '\033[0;33m! https://%s:%s does not answer with a certificate the sandbox CA verifies; see %s\033[0m\n' "$LAN_IP" "${a##*:}" "$LOGS/full-web-tls.out"
  done
fi

if [ "${#failed[@]}" -gt 0 ]; then
  status
  die "not every app is served: the ${failed[*]} build failed (see .sandbox/logs/full-build-<app>.out); the others are up"
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
if [ "$LAN" = 1 ] && [ "$REAL_SMS" = 1 ]; then
  printf '\033[0;33m
  ⚠ LIVE SMS BEHIND A NETWORK-REACHABLE SANDBOX (ADR-053 §3.5, acknowledged by --lan-real-sms)
    On the network   %s
                     The edge, the services and the data never leave loopback.
    Twilio           every destination except TWILIO_TO is refused before the provider is called, so
                     nobody else on this network can be texted by this sandbox. They CAN still spend
                     your daily SMS cap and ring your number: do not leave this up unattended.
    When you are done  pnpm sandbox:full --down
\033[0m
' "$(printf '%s ' "${LAN_APPS[@]%%:*}" | sed 's/ $//') on https://$LAN_IP"
  # Widening past the portal puts officer and station credentials on the network: say so separately,
  # so it can never be mistaken for the vetted default.
  if [ "${#LAN_APPS[@]}" -gt 1 ]; then
    printf '\033[0;31m    ⚠ STAFF CREDENTIALS ARE ON THIS NETWORK: SANDBOX_LAN_APPS widened the surface past the
      applicant portal. Anyone on this Wi-Fi can reach the officer console and/or field station
      sign-in. Use it on a network you control, never at a venue.\033[0m\n'
  fi
fi
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
  a device that cannot connect   allow$(printf ' %s' "${LAN_APPS[@]##*:}")/tcp in this machine's firewall (ufw: sudo ufw allow $(printf '%s ' "${LAN_APPS[@]##*:}" | sed 's/ $//' | tr ' ' ',')/tcp)
EOF
fi

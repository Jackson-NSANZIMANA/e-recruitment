#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# rehearse.sh — run USRP from its images and rehearse on it (ADR-038).
#
#   infrastructure/images/rehearse.sh up        # own DB + bootstrap, stack up, wait healthy
#   infrastructure/images/rehearse.sh rehearse  # pnpm rehearse through the officer SPA's /edge
#   infrastructure/images/rehearse.sh status    # containers + every service's GET /version
#   infrastructure/images/rehearse.sh down      # remove ONLY this project, drop its DB
#
# Then the live journey from the frontend repo (apps/applicant-portal):
#   USRP_LIVE=1 USRP_PORTAL_URL=http://localhost:3510 USRP_OFFICER_URL=http://localhost:3511 \
#   USRP_DEV_SMS_INBOX=$USRP_SMS_DIR/inbox.jsonl \
#   npx playwright test -c e2e/playwright.config.ts --project desktop e2e/live-rehearsal.spec.ts
#
# Prerequisites: tier1 + ClamAV running (pnpm infra:up), images built
# (services/*/Dockerfile → usrp-s03/<service>:dev, and the two SPA images).
# It never stops, restarts or removes a container it did not start.
#
# Env: USRP_STACK_PROJECT (usrp-s03) · USRP_REHEARSAL_DB (usrp_images)
#      USRP_APPLICANT_PORT (3510) · USRP_OFFICER_PORT (3511)
#      USRP_SMS_DIR (.dev-sms-images) · USRP_IMAGE_PREFIX / USRP_IMAGE_TAG
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infrastructure/images/docker-compose.rehearsal.yml"
PROJECT="${USRP_STACK_PROJECT:-usrp-s03}"
DB="${USRP_REHEARSAL_DB:-usrp_images}"
export USRP_REHEARSAL_DB="$DB"
export USRP_APPLICANT_PORT="${USRP_APPLICANT_PORT:-3510}"
export USRP_OFFICER_PORT="${USRP_OFFICER_PORT:-3511}"
export USRP_SMS_DIR="${USRP_SMS_DIR:-$REPO_ROOT/.dev-sms-images}"
PG_CONTAINER="${PG_CONTAINER:-usrp-postgres}"
OFFICER="http://localhost:$USRP_OFFICER_PORT"

case "$PROJECT" in usrp-tier1|usrp-tier2|"") echo "refusing project name '$PROJECT': that is the shared infrastructure" >&2; exit 1 ;; esac
case "$DB" in usrp_db|postgres|template0|template1) echo "refusing database '$DB': not a disposable database" >&2; exit 1 ;; esac
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || { echo "bad database name '$DB'" >&2; exit 1; }

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }
psql_admin() { docker exec -i "$PG_CONTAINER" psql -U usrp_admin -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

up() {
  for port in "$USRP_APPLICANT_PORT" "$USRP_OFFICER_PORT"; do
    if (printf '' > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "port $port is already in use" >&2; exit 1; fi
  done
  docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" usrp-minio usrp-clamav usrp-nida-mock usrp-nesa-mock usrp-rib-mock usrp-hec-mock > /dev/null \
    || { echo "tier1/ClamAV are not running (pnpm infra:up)" >&2; exit 1; }
  mkdir -p "$USRP_SMS_DIR" && chmod 0777 "$USRP_SMS_DIR"
  if [[ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$DB'")" != "1" ]]; then
    psql_admin -c "CREATE DATABASE $DB"
  fi
  DATABASE_URL="postgresql://usrp_admin:usrp_dev_password@localhost:5432/$DB" PG_DB="$DB" NODE_ENV=development \
    bash "$REPO_ROOT/scripts/bootstrap-db.sh"
  compose up -d --wait --wait-timeout 420
  status
}

status() {
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
  echo
  for svc in identity-service eligibility-service biometric-service document-forensics-service background-vetting-service \
             application-service scheduling-service notification-service field-sync-service audit-service iam-service edge-gateway; do
    port=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -q "$svc")" | sed -n 's/^PORT=//p')
    printf '%-28s %s\n' "$svc" "$(compose exec -T "$svc" node -e "fetch('http://127.0.0.1:$port/version').then(r=>r.text()).then(t=>console.log(t))")"
  done
  for app in "$USRP_APPLICANT_PORT" "$USRP_OFFICER_PORT"; do
    printf '%-28s %s\n' "spa :$app" "$(curl -fsS "http://localhost:$app/version.json" | tr -d '\n ')"
  done
}

rehearse() {
  REHEARSAL_EDGE_URL="$OFFICER" REHEARSAL_ORIGIN="$OFFICER" \
  REHEARSAL_DATABASE_URL="postgresql://usrp_admin:usrp_dev_password@localhost:5432/$DB" \
    pnpm --dir "$REPO_ROOT" rehearse "$@"
}

down() {
  compose down -v --remove-orphans
  psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
  echo "removed project $PROJECT and database $DB"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  up) up ;;
  status) status ;;
  rehearse) rehearse "$@" ;;
  down) down ;;
  *) echo "usage: $0 up | rehearse | status | down" >&2; exit 2 ;;
esac

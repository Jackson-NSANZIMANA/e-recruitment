#!/usr/bin/env bash
# pnpm sandbox:clean — empty a SANDBOX database of every test record, keeping only the agency administrators.
#
#   SANDBOX_DB=usrp_sandbox_eval pnpm sandbox:clean          dry run: what would go, nothing changed
#   SANDBOX_DB=usrp_sandbox_eval pnpm sandbox:clean --yes    do it
#
# KEPT     the agency administrators (officer accounts holding the agency_admin role, whatever their
#          handle), the platform's own service account, the schema and its migration journal, and
#          .sandbox/secrets.json, the TLS certificates and the CA (so passwords and devices keep working).
# REMOVED  every other officer account (the rehearsal reh.* staff), every citizen identity, campaign,
#          application, document, session, event, rate-limit bucket and the audit log; the sandbox broker's
#          and object store's volumes (Kafka events, stored documents; both are recreated empty on the next
#          boot); the personas, SMS inbox, logs and rehearsal manifest on disk.
#
# Safety: only databases named usrp_sandbox*; refused while the sandbox runs (`pnpm sandbox:full --down`
# first); a restorable pg_dump is written to .sandbox/backups before anything changes; the database part is
# ONE transaction (all or nothing), refused if no administrator would remain. Evidence tables are
# append-only by design (Law N° 058/2021): the audit log, the status histories, campaign history and
# commands, gate admissions, biometric evidence, clearance verifications, document revisions; their
# triggers reject TRUNCATE. The tool finds every such guard on the tables it empties, disables exactly
# those inside the transaction, enables the same set again before it commits, and then checks that no
# guard was left disabled.
#
# A later `pnpm sandbox:full` stages the six campaigns and rehearsal data again; `--no-staging` boots
# without them.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
STATE="$REPO/.sandbox"
DB="${SANDBOX_DB:-usrp_sandbox}"
PG_CONTAINER="${PG_CONTAINER:-usrp-postgres}"; PG_ADMIN="${PG_ADMIN_USER:-usrp_admin}"
YES=0
for arg in "$@"; do
  case "$arg" in --yes) YES=1 ;; *) echo "✗ unknown option $arg (see the header of $0)" >&2; exit 2 ;; esac
done

die() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\033[0;36m▶ %s\033[0m\n' "$*"; }
q() { docker exec -i "$PG_CONTAINER" psql -U "$PG_ADMIN" -d "$DB" -v ON_ERROR_STOP=1 -tAq "$@"; }

[[ "$DB" =~ ^usrp_sandbox[a-z0-9_]*$ ]] || die "SANDBOX_DB=$DB is not a sandbox database (usrp_sandbox*); this tool never touches any other"
docker exec "$PG_CONTAINER" pg_isready -q 2>/dev/null || die "Postgres ($PG_CONTAINER) is not running; start tier1 first"
[ "$(docker exec "$PG_CONTAINER" psql -U "$PG_ADMIN" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'")" = 1 ] \
  || die "database $DB does not exist"
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:4921/edge/v1/session 2>/dev/null)" != 000 ]; then
  die "a sandbox is running (its edge answers on :4921); stop it first: pnpm sandbox:full --down"
fi

KEEP_TABLES="'public.drizzle_migrations','public_core.officer_accounts','public_core.service_accounts'"
EMPTY_TABLES="$(q -c "SELECT string_agg(format('%I.%I', table_schema, table_name), ', ' ORDER BY 1)
  FROM information_schema.tables WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
  AND format('%I.%I', table_schema, table_name) NOT IN ($KEEP_TABLES)")"
EMPTY_LITERALS="$(q -c "SELECT string_agg(quote_literal(format('%I.%I', table_schema, table_name)), ', ')
  FROM information_schema.tables WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
  AND format('%I.%I', table_schema, table_name) NOT IN ($KEEP_TABLES)")"
# The append-only guards: user triggers that fire on TRUNCATE (tgtype bit 32), and how many are off.
GUARDS_SQL="FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal AND (t.tgtype & 32) = 32"
guards_disabled() { q -c "SELECT count(*) $GUARDS_SQL AND t.tgenabled = 'D'"; }
count() { q -c "SELECT count(*) FROM $1"; }
ops_count() { q -c "SELECT (SELECT count(*) FROM rdf_ops.$1) + (SELECT count(*) FROM rnp_ops.$1) + (SELECT count(*) FROM rcs_ops.$1)"; }

report() {
  printf '  %-34s %s\n' "agency administrators (kept)" "$(q -c "SELECT count(*) || ': ' || coalesce(string_agg(login_handle, ' ' ORDER BY login_handle), '') FROM public_core.officer_accounts WHERE 'agency_admin' = ANY(roles)")"
  printf '  %-34s %s\n' "other officer accounts" "$(q -c "SELECT count(*) FROM public_core.officer_accounts WHERE NOT ('agency_admin' = ANY(roles))")"
  printf '  %-34s %s\n' "citizen identities" "$(count public_core.applicant_identities)"
  printf '  %-34s %s\n' "campaigns" "$(count public_core.recruitment_campaigns)"
  printf '  %-34s %s\n' "applications (RDF+RNP+RCS)" "$(ops_count applications)"
  printf '  %-34s %s\n' "document records" "$(ops_count document_records)"
  printf '  %-34s %s\n' "sessions (officer + citizen)" "$(q -c "SELECT (SELECT count(*) FROM public_core.edge_sessions) + (SELECT count(*) FROM public_core.applicant_sessions)")"
  printf '  %-34s %s\n' "outbox events" "$(count public_core.event_outbox)"
  printf '  %-34s %s\n' "audit entries" "$(count audit_log.audit_entries)"
  printf '  %-34s %s\n' "append-only guards (TRUNCATE)" "$(q -c "SELECT count(*) $GUARDS_SQL") ($(guards_disabled) disabled)"
  printf '  %-34s %s\n' "all rows in emptied tables" "$(q -c "SELECT $(echo "$EMPTY_TABLES" | sed -E 's/([^, ]+)/(SELECT count(*) FROM \1)/g; s/, / + /g')")"
}

say "database $DB"
report
VOLUMES=(usrp-sandbox_sandbox-kafka-data usrp-sandbox_sandbox-minio-data)
FILES=("$STATE/personas" "$STATE/sms" "$STATE/logs" "$STATE/running.json" "$REPO/.rehearsal")
printf '  %-34s %s\n' "volumes to remove" "$(for v in "${VOLUMES[@]}"; do docker volume inspect "$v" >/dev/null 2>&1 && printf '%s ' "$v"; done)"
printf '  %-34s %s\n' "files to remove" "$(for f in "${FILES[@]}"; do [ -e "$f" ] && printf '%s ' "${f#"$REPO"/}"; done)"

if [ "$YES" = 0 ]; then
  echo
  echo "dry run: nothing changed. To remove all of the above except the administrators:"
  echo "  SANDBOX_DB=$DB pnpm sandbox:clean --yes"
  exit 0
fi

[ "$(q -c "SELECT count(*) FROM public_core.officer_accounts WHERE 'agency_admin' = ANY(roles)")" -gt 0 ] \
  || die "no agency administrator in $DB: cleaning would leave no account to sign in with; nothing changed"

mkdir -p "$STATE/backups"; chmod 700 "$STATE/backups"
backup="$STATE/backups/$DB-$(date -u +%Y%m%dT%H%M%SZ).dump"
say "backup: $backup"
( umask 077; docker exec "$PG_CONTAINER" pg_dump -U "$PG_ADMIN" -Fc "$DB" > "$backup" ) || die "the backup failed; nothing changed"
[ -s "$backup" ] || die "the backup is empty; nothing changed"

# The sandbox project's own containers go first (as `pnpm sandbox:down` does; the volumes stay until
# below): a stopped container still holds its volume and would refuse the removal half-way.
docker compose -p usrp-sandbox -f "$REPO/infrastructure/docker/docker-compose.sandbox.yml" down > /dev/null 2>&1 || true

disabled_before="$(guards_disabled)"
say "emptying $DB (one transaction)"
q <<SQL
BEGIN;
DELETE FROM public_core.officer_accounts WHERE NOT ('agency_admin' = ANY(roles));
CREATE TEMP TABLE usrp_clean_guards ON COMMIT DROP AS
  SELECT format('%I.%I', n.nspname, c.relname) AS tbl, t.tgname $GUARDS_SQL
  AND t.tgenabled <> 'D' AND format('%I.%I', n.nspname, c.relname) IN ($EMPTY_LITERALS);
DO \$\$ DECLARE g record; BEGIN
  FOR g IN SELECT * FROM usrp_clean_guards LOOP EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', g.tbl, g.tgname); END LOOP;
END \$\$;
TRUNCATE $EMPTY_TABLES RESTART IDENTITY;
DO \$\$ DECLARE g record; BEGIN
  FOR g IN SELECT * FROM usrp_clean_guards LOOP EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', g.tbl, g.tgname); END LOOP;
END \$\$;
DO \$\$ BEGIN
  IF (SELECT count(*) FROM public_core.officer_accounts WHERE 'agency_admin' = ANY(roles)) = 0 THEN
    RAISE EXCEPTION 'no agency administrator would remain';
  END IF;
END \$\$;
COMMIT;
SQL
[ "$(guards_disabled)" = "$disabled_before" ] \
  || die "an append-only guard is still disabled; list them: SELECT tgrelid::regclass, tgname FROM pg_trigger WHERE (tgtype & 32) = 32 AND tgenabled = 'D'"

say "removing the broker's and object store's volumes (recreated empty on the next boot)"
for v in "${VOLUMES[@]}"; do
  docker volume inspect "$v" >/dev/null 2>&1 || continue
  docker volume rm "$v" >/dev/null || die "volume $v is in use; run pnpm sandbox:full --down, then this again"
done
say "removing personas, SMS inbox, logs and the rehearsal manifest"
for f in "${FILES[@]}"; do rm -rf "$f"; done
mkdir -p "$STATE/logs"

echo
say "after"
report
cat <<EOF

✓ $DB holds only its agency administrators (and the platform service account).
  restore the previous state   docker exec -i $PG_CONTAINER pg_restore -U $PG_ADMIN -d $DB --clean --if-exists < ${backup#"$REPO"/}
  boot without test data       SANDBOX_DB=$DB pnpm sandbox:full --no-staging   (add --lan for the network)
  the backup still holds the removed test data; delete it when you no longer need it: rm ${backup#"$REPO"/}
EOF

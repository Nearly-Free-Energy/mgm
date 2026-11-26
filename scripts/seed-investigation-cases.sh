#!/usr/bin/env bash
# Seed #133's investigation fixture set (docs/investigation-cases.md §1) into
# this repository's own local Supabase database: two organizations, twenty
# synthetic microgrids, their devices, units and meter links, and an
# organization manager of both. Disposable local installations only.
#
#   scripts/seed-investigation-cases.sh --disposable
#
# docs/setup.md § "Investigation cases" has the whole procedure. The guards,
# from the outside in:
#   - --disposable is required.
#   - The database URL comes only from `supabase status`, run at this
#     repository's root; there is no option to pass one. Which stack status
#     reports is still the CLI's choice: SUPABASE_WORKDIR picks the project
#     directory (and so its project_id and ports), as it does for every
#     `supabase` command, and the port it prints is the one in that
#     directory's config.toml, whoever is listening on it.
#   - The URL must be a postgres URI for a single loopback host, with a valid
#     port and no query string, which libpq could use to point elsewhere.
#   - A loopback port is not proof of "my stack": on a shared machine
#     127.0.0.1 can reach another account's Docker. So the database behind the
#     URL must be the one inside the supabase_db_* container that publishes
#     its Postgres port (5432 in the container) on that host port, on the
#     Docker daemon this shell's `docker` reaches (DOCKER_HOST or the current
#     docker context): exactly one such container, and both databases must
#     report the same pg_control_system() system_identifier. The binding is
#     read from `docker ps`'s Ports column rather than its publish= filter,
#     whose side of a binding Docker's reference and its daemons disagree on
#     (the reference's example matches the container port; Docker 29 matches
#     the host port). If that daemon is not yours, this check proves nothing,
#     so point docker at your own first.
#   - PGHOST, PGHOSTADDR, PGSERVICE and PGSERVICEFILE are unset for psql, and
#     ~/.psqlrc is not read.
#   - supabase/scripts/seed-investigation-cases.sql refuses a database
#     without the development opt-in in Vault, or with organizations other
#     than the local sample one, and runs here in one transaction. Those prove
#     a fresh development database, not whose it is.
#   - Afterwards this checks that the seed wrote its organizations and that
#     the component-id trigger it disables for the legacy rows is enabled.
set -euo pipefail

usage() {
  echo "Usage: $0 --disposable" >&2
  echo "Seeds the investigation cases into this checkout's local Supabase database." >&2
}

if [ "$#" -ne 1 ] || [ "$1" != "--disposable" ]; then
  usage
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in npx psql python3 docker; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Refusing: $tool is not installed." >&2
    exit 1
  fi
done

if ! status="$(npx --no-install supabase status -o env 2>/dev/null)"; then
  echo "Refusing: supabase status failed. Start this checkout's local stack first (docs/setup.md)." >&2
  exit 1
fi

line="$(printf '%s\n' "$status" | grep '^DB_URL=' | head -n 1 || true)"
DB_URL="${line#DB_URL=}"
DB_URL="${DB_URL#\"}"
DB_URL="${DB_URL%\"}"
if [ -z "$line" ] || [ -z "$DB_URL" ]; then
  echo "Refusing: supabase status printed no DB_URL." >&2
  exit 1
fi

# Parsed in isolated mode (-I), so no module is loaded from the current
# directory or PYTHON* variables. The loopback set matches
# scripts/emergency-sign-in-link.py's LOOPBACK_HOSTS. Prints the port.
if ! port="$(DB_URL="$DB_URL" python3 -I - <<'PY'
import os
import sys
from urllib.parse import urlsplit

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def refuse(reason):
    print(f"Refusing: the database URL from supabase status {reason}.", file=sys.stderr)
    sys.exit(1)


value = os.environ.get("DB_URL", "")
try:
    parts = urlsplit(value)
except ValueError:
    refuse("is not a URI")
if parts.scheme not in ("postgres", "postgresql") or not parts.netloc:
    refuse("is not a postgres URI")
if "," in parts.netloc:
    refuse("names more than one host")
if parts.hostname not in LOOPBACK_HOSTS:
    refuse("is not on this machine's loopback address")
try:
    parts.port
except ValueError:
    refuse("has an invalid port")
if parts.query or parts.fragment:
    refuse("carries connection parameters")
print(parts.port or 5432)
PY
)"; then
  exit 1
fi

run_psql() {
  env -u PGHOST -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE psql -X "$DB_URL" "$@"
}

# The database behind the URL must be the one in this daemon's container that
# publishes its Postgres port on the URL's port (see the header). Ports reads
# like "0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp", host side first. The
# Supabase CLI runs Postgres on 5432 inside supabase_db_*; if that changes,
# this finds no container and refuses.
if ! listing="$(docker ps --filter "name=supabase_db_" --format '{{.Names}} {{.Ports}}')"; then
  echo "Refusing: docker ps failed. Start the Docker daemon your local stack runs on." >&2
  exit 1
fi
containers=""
matches=0
while read -r name ports; do
  # docker's name filter matches anywhere in the name.
  case "$name" in supabase_db_*) ;; *) continue ;; esac
  case ", ${ports}," in
    *":${port}->5432/tcp,"*)
      containers="$name"
      matches=$((matches + 1))
      ;;
  esac
done <<<"$listing"
if [ "$matches" != "1" ]; then
  echo "Refusing: no single supabase_db_* container on this Docker daemon publishes port ${port} as its Postgres port." >&2
  echo "On a shared machine that port may be another account's stack; point docker (DOCKER_HOST or docker context) at the daemon your own stack runs on." >&2
  exit 1
fi
IDENTITY_SQL="SELECT system_identifier FROM pg_control_system()"
inside="$(docker exec "$containers" psql -X -U postgres -d postgres -At -c "$IDENTITY_SQL" || true)"
behind="$(run_psql -At -c "$IDENTITY_SQL" || true)"
if [ -z "$inside" ] || [ "$inside" != "$behind" ]; then
  echo "Refusing: the database at port ${port} is not the one in container ${containers}." >&2
  exit 1
fi

run_psql -v ON_ERROR_STOP=1 -v disposable=1 --single-transaction \
  -f supabase/scripts/seed-investigation-cases.sql

# A refused guard ends the SQL file without an error, so check the result.
seeded="$(run_psql -v ON_ERROR_STOP=1 -At -c \
  "SELECT count(*) FROM public.organizations WHERE id IN ('00000000-0000-4000-8000-0000000c00a0', '00000000-0000-4000-8000-0000000c00b0')")"
if [ "$seeded" != "2" ]; then
  echo "The seed did not write organizations A and B; see its output above." >&2
  exit 1
fi

trigger="$(run_psql -v ON_ERROR_STOP=1 -At -c \
  "SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.devices'::regclass AND tgname = 'trg_device_openems_component_valid'")"
if [ "$trigger" != "O" ]; then
  echo "trg_device_openems_component_valid is not enabled (state '${trigger}'). Reset the database: MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset" >&2
  exit 1
fi

echo "Done. Nothing in this database is real; reset it when you are finished."

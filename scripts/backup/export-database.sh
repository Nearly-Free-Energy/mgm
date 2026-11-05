#!/usr/bin/env bash
# Export an MGM database with pg_dump and pg_dumpall.
#
#   export-database.sh --db-url-env <ENV_VAR_NAME> --out <dir> (--age-recipients <file> | --plaintext)
#
# Operator guide: docs/runbooks/backup-and-restore.md.
#
# An export holds personal data and every stored credential, so each run must
# say how to write it: --age-recipients to encrypt it, or --plaintext. Naming
# neither is a usage error, so leaving a flag off never produces plaintext.
#
# The connection string, the database's postgres connection string, is read
# from the environment variable named by --db-url-env. It grants full access
# to the database, Vault secrets included, so keep it as a secret. It is never
# accepted as an argument to this script and never printed by it. Its
# password reaches pg_dump and pg_dumpall through PGPASSWORD, not through
# their command lines.
#
# The files have the names, layout and filters of `supabase db dump` output,
# so the restore commands in Supabase's backup-and-restore guide apply to
# them. Unlike `supabase db dump`, the data dump reads an explicit list of
# schemas, and the export fails if a migration is recorded while it runs (see
# "Dumps" below).

# Tracing would print the connection string, so turn it off before anything
# else runs, including when the caller used `bash -x` or exported SHELLOPTS.
set +x
set -euo pipefail
umask 077
unset CDPATH

readonly PROG="export-database.sh"
readonly EXIT_USAGE=2
readonly EXIT_PRECONDITION=3
readonly EXIT_DUMP=4
readonly EXIT_PACKAGE=5
readonly EXPORT_FORMAT="mgm-database-export/1"

# File names follow Supabase's backup-and-restore guide, so the restore
# commands there apply to an extracted export unchanged.
readonly DUMP_FILES=(roles.sql schema.sql data.sql history_schema.sql history_data.sql)

usage() {
  printf '%s\n' \
    "Usage: $PROG --db-url-env <ENV_VAR_NAME> --out <dir> (--age-recipients <file> | --plaintext)" \
    "" \
    "Exports a database with pg_dump and pg_dumpall: cluster roles, schema, data," \
    "and the Supabase CLI migration history, plus manifest.json recording the" \
    "UTC start time of the export and of its data dump, the pg_dump and server" \
    "versions, and each file's size and SHA-256. Needs pg_dump and pg_dumpall of" \
    "at least the server's major version." \
    "" \
    "  --db-url-env NAME      Environment variable that holds the postgresql://" \
    "                         connection string, with any password percent-encoded" \
    "                         in its user-info part. The value is never printed." \
    "  --out DIR              Directory that receives the export (created if" \
    "                         missing). Each run adds mgm-db-export-<UTC time>." \
    "  --age-recipients FILE  age recipients file (public keys). The only output" \
    "                         is mgm-db-export-<UTC time>.tar.gz.age; the plaintext" \
    "                         dumps are staged under \$TMPDIR (default /tmp), never" \
    "                         in DIR, and removed after encryption." \
    "  --plaintext            Write the export as an unencrypted directory instead." \
    "                         It holds personal data and every stored credential;" \
    "                         use it only on an encrypted disk, never on a schedule." \
    "  -h, --help             Show this help." \
    "" \
    "Exactly one of --age-recipients and --plaintext is required." \
    "" \
    "Prints the path of the export on stdout. Progress, and the SHA-256 of the" \
    "encrypted file (or of manifest.json for a plaintext export), go to stderr." \
    "Each run first removes the staging directories and partial files that" \
    "earlier runs of this script left behind when they were killed, if those runs" \
    "are no longer running." \
    "" \
    "Exit codes:" \
    "  0  export written" \
    "  2  usage error" \
    "  3  missing or unusable input (nothing was dumped): environment variable," \
    "     output directory, staging directory, recipients file, or a required" \
    "     program" \
    "  4  pg_dump or pg_dumpall failed or wrote nothing, or the migration history" \
    "     changed while the export ran (a deploy ran); export again after it" \
    "  5  computing a size or SHA-256, packaging, encryption, or moving the" \
    "     export into place failed" \
    "" \
    "See docs/runbooks/backup-and-restore.md."
}

err() {
  printf '%s: error: %s\n' "$PROG" "$*" >&2
}

die() {
  local code=$1
  shift
  err "$@"
  exit "$code"
}

die_usage() {
  err "$@"
  printf "Run '%s --help' for usage.\n" "$PROG" >&2
  exit "$EXIT_USAGE"
}

note() {
  printf '%s: %s\n' "$PROG" "$*" >&2
}

# Names an argument in an error message without repeating anything that could
# be a secret, such as a connection string passed where it does not belong.
describe_arg() {
  local name=${1%%=*}
  local re='^--?[A-Za-z0-9][A-Za-z0-9-]*$'
  if [[ $name =~ $re ]]; then
    printf '%s' "$name"
  else
    printf '%s' "(argument not shown)"
  fi
}

# sha256_of and bytes_of print nothing and return non-zero unless they have a
# well-formed result. Callers assign the result and check the status before
# using it: a failure inside $(...) passed straight to printf would not trip
# `set -e`, and the manifest would record an empty value.
sha256_of() {
  local sum re='^[0123456789abcdef]{64}$'
  if [[ $sha256_tool == sha256sum ]]; then
    sum=$(sha256sum <"$1") || return
  else
    sum=$(shasum -a 256 <"$1") || return
  fi
  sum=${sum%% *}
  [[ $sum =~ $re ]] || return 1
  printf '%s' "$sum"
}

bytes_of() {
  local n
  n=$(wc -c <"$1") || return
  n=${n//[!0-9]/}
  [[ -n $n ]] || return 1
  printf '%s' "$n"
}

# Keeps a version string safe to embed in JSON: letters, digits, spaces and
# . _ + - ( ) only.
version_text() {
  local text=${1%%$'\n'*}
  text=${text//[!A-Za-z0-9._+() -]/}
  printf '%s' "${text:-unknown}"
}

# --- Arguments ---------------------------------------------------------------

db_url_env=""
out_dir=""
recipients_file=""
plaintext=0

while (($# > 0)); do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --plaintext)
      ((plaintext == 0)) || die_usage "--plaintext given more than once"
      plaintext=1
      shift
      ;;
    --db-url-env | --out | --age-recipients)
      if (($# < 2)) || [[ -z $2 || $2 == -* ]]; then
        die_usage "$1 needs a value"
      fi
      case $1 in
        --db-url-env)
          [[ -z $db_url_env ]] || die_usage "--db-url-env given more than once"
          db_url_env=$2
          ;;
        --out)
          [[ -z $out_dir ]] || die_usage "--out given more than once"
          out_dir=$2
          ;;
        --age-recipients)
          [[ -z $recipients_file ]] || die_usage "--age-recipients given more than once"
          recipients_file=$2
          ;;
      esac
      shift 2
      ;;
    *)
      die_usage "unknown argument: $(describe_arg "$1")"
      ;;
  esac
done

[[ -n $db_url_env ]] || die_usage "--db-url-env is required"
[[ -n $out_dir ]] || die_usage "--out is required"
if [[ -n $recipients_file ]] && ((plaintext)); then
  die_usage "--age-recipients and --plaintext cannot be used together"
fi
if [[ -z $recipients_file ]] && ((plaintext == 0)); then
  die_usage "choose --age-recipients <file> to encrypt the export, or --plaintext to write it unencrypted"
fi

env_name_re='^[A-Za-z_][A-Za-z0-9_]*$'
if ! [[ $db_url_env =~ $env_name_re ]]; then
  die_usage "--db-url-env takes the NAME of an environment variable that holds the connection string, not the connection string itself (value not shown)"
fi

# --- Preconditions -----------------------------------------------------------
# Everything that can be checked without the database is checked before the
# first dump, so a misconfigured schedule fails fast and leaves nothing behind.

db_url=${!db_url_env-}
if [[ -z $db_url ]]; then
  die "$EXIT_PRECONDITION" "environment variable $db_url_env is not set or is empty"
fi
case $db_url in
  postgres://* | postgresql://*) ;;
  *) die "$EXIT_PRECONDITION" "environment variable $db_url_env does not hold a postgres:// or postgresql:// connection string (value not shown)" ;;
esac
case $db_url in
  *[?\&]password=*)
    die "$EXIT_PRECONDITION" "the connection string in $db_url_env carries a password= parameter, which would reach pg_dump's command line; put the password, percent-encoded, in the user-info part instead (value not shown)"
    ;;
esac

# Take the password out of the connection string, so it never appears in the
# process list. libpq reads PGPASSWORD when the connection string has no
# password. The user-info part ends at the last '@'.
db_url_for_tools=$db_url
db_password_raw=""
db_password=""
db_scheme=${db_url%%://*}
db_rest=${db_url#*://}
if [[ $db_rest == *@* ]]; then
  db_userinfo=${db_rest%@*}
  if [[ $db_userinfo == *[/?#]* ]]; then
    die "$EXIT_PRECONDITION" "cannot find the user name and password in the connection string in $db_url_env; percent-encode '/', '?', '#' and '@' in them (value not shown)"
  fi
  if [[ $db_userinfo == *:* ]]; then
    db_password_raw=${db_userinfo#*:}
    db_url_for_tools="$db_scheme://${db_userinfo%%:*}@${db_rest##*@}"
  fi
fi
if [[ -n $db_password_raw ]]; then
  # Every '%' must start a two-digit hex escape. A raw backslash, or an
  # encoded NUL, cannot be passed through the decoding below. The bracket
  # expression [\\] matches one backslash.
  bad_encoding='%($|[^0-9A-Fa-f]|[0-9A-Fa-f]($|[^0-9A-Fa-f]))|%00|[\\]'
  if [[ $db_password_raw =~ $bad_encoding ]]; then
    die "$EXIT_PRECONDITION" "the password in $db_url_env is not percent-encoded correctly (value not shown)"
  fi
  printf -v db_password '%b' "${db_password_raw//%/\\x}"
fi

for program in pg_dump pg_dumpall; do
  command -v "$program" >/dev/null 2>&1 \
    || die "$EXIT_PRECONDITION" "'$program' is not on PATH; install the PostgreSQL client programs, at least the database server's major version"
done
command -v sed >/dev/null 2>&1 || die "$EXIT_PRECONDITION" "'sed' is not on PATH"

if command -v sha256sum >/dev/null 2>&1; then
  sha256_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  sha256_tool=shasum
else
  die "$EXIT_PRECONDITION" "neither sha256sum nor shasum is on PATH"
fi

if ((plaintext == 0)); then
  command -v age >/dev/null 2>&1 \
    || die "$EXIT_PRECONDITION" "--age-recipients needs the 'age' program on PATH"
  command -v tar >/dev/null 2>&1 \
    || die "$EXIT_PRECONDITION" "--age-recipients needs the 'tar' program on PATH"
  # GNU tar's -z runs the external gzip program; without it, packaging would
  # fail only after the whole database had been read.
  command -v gzip >/dev/null 2>&1 \
    || die "$EXIT_PRECONDITION" "--age-recipients needs the 'gzip' program on PATH"
  [[ -f $recipients_file ]] \
    || die "$EXIT_PRECONDITION" "recipients file not found: $recipients_file"
  [[ -r $recipients_file ]] \
    || die "$EXIT_PRECONDITION" "recipients file is not readable: $recipients_file"

  # age ignores blank lines and lines starting with '#'. Lines are not
  # printed: a wrongly chosen file could hold a secret key.
  recipient_count=0
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      *AGE-SECRET-KEY-* | *"PRIVATE KEY"*)
        die "$EXIT_PRECONDITION" "recipients file contains a secret key; give the public recipient (age1... or an SSH public key) and keep the secret key offline"
        ;;
    esac
    trimmed=${line//[[:space:]]/}
    [[ -z $trimmed || $trimmed == \#* ]] && continue
    recipient_count=$((recipient_count + 1))
  done <"$recipients_file"
  ((recipient_count > 0)) \
    || die "$EXIT_PRECONDITION" "recipients file lists no recipients: $recipients_file"

  # Let age parse the file now, by encrypting nothing, so a malformed entry
  # fails here rather than after the whole database has been read. Its
  # message is not shown, for the same reason the lines are not.
  age -R "$recipients_file" -o /dev/null </dev/null >/dev/null 2>&1 \
    || die "$EXIT_PRECONDITION" "age cannot use an entry in the recipients file: $recipients_file"
fi

if [[ -e $out_dir && ! -d $out_dir ]]; then
  die "$EXIT_PRECONDITION" "--out exists and is not a directory: $out_dir"
fi
mkdir -p -- "$out_dir" 2>/dev/null \
  || die "$EXIT_PRECONDITION" "cannot create output directory: $out_dir"
[[ -w $out_dir ]] || die "$EXIT_PRECONDITION" "output directory is not writable: $out_dir"
out_dir=$(cd -- "$out_dir" && pwd -P)

started_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  || die "$EXIT_PRECONDITION" "cannot read the clock"
export_name="mgm-db-export-${started_utc//[-:]/}"
if ((plaintext)); then
  final_path="$out_dir/$export_name"
else
  final_path="$out_dir/$export_name.tar.gz.age"
fi
[[ ! -e $final_path ]] || die "$EXIT_PRECONDITION" "an export with this name already exists: $final_path"

pg_dump_version=$(pg_dump --version 2>/dev/null) \
  || die "$EXIT_PRECONDITION" "'pg_dump --version' failed"
pg_dump_version=$(version_text "$pg_dump_version")

# --- Staging -----------------------------------------------------------------
# Dumps are written to a private (0700) staging directory and moved into place
# only when complete, so an interrupted run never leaves an export that looks
# finished. With --age-recipients the staging directory is under $TMPDIR, not
# --out: a run killed outright (SIGKILL, power loss) cannot clean up, and --out
# is the directory that gets copied to export storage. age then writes to a
# hidden .partial file in --out that is renamed when complete. With
# --plaintext the output is plaintext anyway, so staging stays inside --out,
# where the final move is a rename. The trap removes the staging directory,
# and with it any plaintext, and any partial file, on every exit path it can
# run on.
#
# The names of the staging directory and the partial file carry this run's
# process ID, so that a later run can tell whether the run that made them is
# still going (see "Leftovers" below).

stage=""
partial=""
cleanup() {
  if [[ -n $stage && -d $stage ]]; then
    rm -rf -- "$stage"
  fi
  if [[ -n $partial && -e $partial ]]; then
    rm -f -- "$partial"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

tmp_parent=${TMPDIR:-/tmp}
tmp_parent=${tmp_parent%/}

# --- Leftovers ---------------------------------------------------------------
# A run killed outright cannot run its trap, so its staging directory, with
# plaintext dumps in it, and its partial encrypted file stay behind. Before
# creating its own, each run removes those of earlier runs, and only those:
#   - only names this script creates, in the two places it writes ($TMPDIR and
#     --out), owned by the current user, and not symbolic links;
#   - only when the process ID in the name is not a running process of the
#     current user. A run still in progress keeps its files, so overlapping
#     runs are safe. The ID can also be this run's own, reused after the
#     earlier run died (a container that starts each run with the same IDs):
#     this run has created nothing yet, so a name with its ID is stale.
# A process ID means something only on the host that issued it, which is one
# more reason --out must be a local directory, not one shared between hosts.
# If the ID has since been reused by another process of the current user, the
# leftover stays until a later run finds that process gone.

readonly LEFTOVER_PID='([1-9][0-9]{0,9})'
readonly TMP_STAGE_NAME_RE="^mgm-export\\.$LEFTOVER_PID\\.[A-Za-z0-9]{6}\$"
readonly OUT_STAGE_NAME_RE="^\\.mgm-export\\.$LEFTOVER_PID\\.[A-Za-z0-9]{6}\$"
readonly PARTIAL_NAME_RE="^\\.mgm-db-export-[0-9]{8}T[0-9]{6}Z\\.tar\\.gz\\.age\\.$LEFTOVER_PID\\.partial\$"

# remove_leftovers <name regex> <description> <path>...
remove_leftovers() {
  local re=$1 what=$2 path pid
  shift 2
  for path in "$@"; do
    [[ ${path##*/} =~ $re ]] || continue
    pid=${BASH_REMATCH[1]}
    [[ ! -L $path && -O $path ]] || continue
    if [[ $pid != "$$" ]] && kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    if rm -rf -- "$path" 2>/dev/null; then
      note "removed the $what of an earlier run that did not finish: $path"
    else
      note "warning: cannot remove the $what of an earlier run that did not finish: $path"
    fi
  done
}

remove_leftovers "$TMP_STAGE_NAME_RE" "staging directory" "$tmp_parent"/mgm-export.*
remove_leftovers "$OUT_STAGE_NAME_RE" "staging directory" "$out_dir"/.mgm-export.*
remove_leftovers "$PARTIAL_NAME_RE" "partial encrypted export" "$out_dir"/.mgm-db-export-*.partial

if ((plaintext)); then
  stage_parent=$out_dir
  stage_template="$out_dir/.mgm-export.$$.XXXXXX"
else
  stage_parent=$tmp_parent
  stage_template="$tmp_parent/mgm-export.$$.XXXXXX"
fi
stage=$(mktemp -d "$stage_template" 2>/dev/null) \
  || die "$EXIT_PRECONDITION" "cannot create a staging directory in $stage_parent"
# TMPDIR may be relative; resolve it once so later paths do not depend on it.
stage_abs=$(cd -- "$stage" && pwd -P) \
  || die "$EXIT_PRECONDITION" "cannot create a staging directory in $stage_parent"
stage=$stage_abs
work="$stage/$export_name"
mkdir -- "$work" || die "$EXIT_PRECONDITION" "cannot create a staging directory in $stage_parent"
dump_log="$stage/dump.log"

# Prints pg_dump or pg_dumpall diagnostics with the connection string and its
# password (as written in the URL, and decoded) removed. Neither program is
# expected to print any of them; this is a second line of defence. Values
# reach awk through the environment rather than its arguments.
redact() {
  MGM_REDACT_URL=$db_url \
    MGM_REDACT_PASSWORD=$db_password_raw \
    MGM_REDACT_PASSWORD_DECODED=$db_password \
    awk '
    function scrub(line, secret,    out, at) {
      if (secret == "") return line
      out = ""
      while ((at = index(line, secret)) > 0) {
        out = out substr(line, 1, at - 1) "[redacted]"
        line = substr(line, at + length(secret))
      }
      return out line
    }
    {
      line = scrub($0, ENVIRON["MGM_REDACT_URL"])
      line = scrub(line, ENVIRON["MGM_REDACT_PASSWORD"])
      line = scrub(line, ENVIRON["MGM_REDACT_PASSWORD_DECODED"])
      gsub(/:\/\/[^:\/@ ]*:[^@ ]*@/, "://[redacted]@", line)
      print line
    }'
}

# Runs a PostgreSQL client program with the password, if the URL had one, in
# PGPASSWORD. Without one, the caller's own PGPASSWORD or .pgpass applies
# unchanged.
with_password() {
  if [[ -n $db_password ]]; then
    PGPASSWORD=$db_password "$@"
  else
    "$@"
  fi
}

# --- Filters -----------------------------------------------------------------
# The filters `supabase db dump` applies (Supabase CLI 2.113.0, MIT License),
# so the files restore into a Supabase project as the CLI's do. They comment
# out what a project's postgres role cannot restore or what Supabase already
# provides: reserved roles, event triggers, the supabase_realtime publication,
# settings of platform-owned objects. Two differences: comment lines are kept
# (the CLI deletes them), so a commented-out statement stays in the file as a
# record of what was left out, and filter_roles has one more expression. If a
# restore fails on a statement Supabase manages, compare these with the
# current CLI's filters.

# psql meta-commands that only a recent psql understands.
readonly FILTER_RESTRICT='s/^\\(un)?restrict .*$/-- &/'

# Schemas Supabase manages. The schema dump leaves them out.
readonly MANAGED_SCHEMAS='information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault'

# Roles Supabase creates, and role settings a project may change on them.
readonly RESERVED_ROLES='anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin'
readonly ALLOWED_ROLE_SETTINGS='pgaudit.*|pgrst.*|session_replication_role|statement_timeout|track_io_timing'

# filter_schema [managed schemas]: the schema dump's filter. Grants on the
# named schemas are commented out; with no argument, none are.
filter_schema() {
  local managed=${1-}
  local args=(
    -e "$FILTER_RESTRICT"
    -e 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/'
    -e 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/'
    -e 's/^CREATE SEQUENCE "/CREATE SEQUENCE IF NOT EXISTS "/'
    -e 's/^CREATE VIEW "/CREATE OR REPLACE VIEW "/'
    -e 's/^CREATE FUNCTION "/CREATE OR REPLACE FUNCTION "/'
    -e 's/^CREATE TRIGGER "/CREATE OR REPLACE TRIGGER "/'
    -e 's/^CREATE PUBLICATION "supabase_realtime/-- &/'
    -e 's/^CREATE EVENT TRIGGER /-- &/'
    -e 's/^         WHEN TAG IN /-- &/'
    -e 's/^   EXECUTE FUNCTION /-- &/'
    -e 's/^ALTER EVENT TRIGGER /-- &/'
    -e 's/^ALTER PUBLICATION "supabase_realtime_/-- &/'
    -e 's/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /-- &/'
    -e 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/'
    -e 's/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/-- &/'
  )
  if [[ -n $managed ]]; then
    args+=(
      -e "s/^GRANT (.+) ON (.+) \"($managed)\"/-- &/"
      -e "s/^REVOKE (.+) ON (.+) \"($managed)\"/-- &/"
    )
  fi
  args+=(
    -e 's/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/\1;/'
    -e 's/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/\1;/'
    -e 's/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/\1;/'
    -e 's/^COMMENT ON EXTENSION (.+)/-- &/'
    -e 's/^CREATE POLICY "cron_job_/-- &/'
    -e 's/^ALTER TABLE "cron"/-- &/'
    -e 's/^SET transaction_timeout = 0;/-- &/'
  )
  sed -E "${args[@]}"
}

# The last expression is not in the CLI: pg_dumpall also writes the reserved
# roles' grants on server parameters, which the postgres role cannot restore
# ("permission denied for parameter").
filter_roles() {
  sed -E \
    -e "$FILTER_RESTRICT" \
    -e "s/^CREATE ROLE \"($RESERVED_ROLES)\"/-- &/" \
    -e "s/^ALTER ROLE \"($RESERVED_ROLES)\"/-- &/" \
    -e 's/ (NOSUPERUSER|NOREPLICATION)//g' \
    -e "s/^-- (.* SET \"($ALLOWED_ROLE_SETTINGS)\" .*)/\\1/" \
    -e "s/GRANT \".*\" TO \"($RESERVED_ROLES)\"/-- &/" \
    -e "s/^GRANT .+ ON PARAMETER .+ TO \"($RESERVED_ROLES)\"/-- &/"
}

# --- Dumpers -----------------------------------------------------------------
# Each writes one file and returns non-zero if a program in its pipeline
# failed, or NO_OUTPUT if the dump program wrote nothing. They are called in a
# condition, where bash ignores `set -e`, so every step checks its own status.

readonly NO_OUTPUT=99

# dump_roles <file>
dump_roles() {
  local file=$1
  with_password pg_dumpall --dbname="$db_url_for_tools" --no-password \
    --roles-only --quote-all-identifiers --no-role-passwords --no-comments \
    | filter_roles >"$file" || return
  [[ -s $file ]] || return "$NO_OUTPUT"
  printf 'RESET ALL;\n' >>"$file"
}

# dump_schema <file> <managed schemas or ""> [pg_dump selection options...]
dump_schema() {
  local file=$1 managed=$2
  shift 2
  with_password pg_dump --dbname="$db_url_for_tools" --no-password \
    --schema-only --quote-all-identifiers "$@" \
    | filter_schema "$managed" >"$file" || return
  [[ -s $file ]] || return "$NO_OUTPUT"
}

# dump_data <file> [pg_dump selection options...]. Like the CLI's data dump,
# it disables triggers while loading and resets the session afterwards.
dump_data() {
  local file=$1 header_bytes total_bytes
  shift
  printf 'SET session_replication_role = replica;\n\n' >"$file" || return
  header_bytes=$(bytes_of "$file") || return
  with_password pg_dump --dbname="$db_url_for_tools" --no-password \
    --data-only --quote-all-identifiers "$@" \
    | sed -E -e "$FILTER_RESTRICT" >>"$file" || return
  total_bytes=$(bytes_of "$file") || return
  ((total_bytes > header_bytes)) || return "$NO_OUTPUT"
  printf 'RESET ALL;\n' >>"$file"
}

# run_dump <label> <dumper> <path> [dumper arguments...]
run_dump() {
  local label=$1 dumper=$2 path=$3 status=0
  shift 3
  note "dumping $label"
  "$dumper" "$path" "$@" 2>"$dump_log" || status=$?
  ((status == 0)) && return
  redact <"$dump_log" >&2
  if ((status == NO_OUTPUT)); then
    die "$EXIT_DUMP" "the $label dump wrote nothing"
  fi
  die "$EXIT_DUMP" "dumping $label failed"
}

# --- Dumps -------------------------------------------------------------------
# The data dump reads only the schemas MGM's data lives in: public, and the
# Auth, Storage and database-webhook schemas whose rows a restore needs. So it
# leaves out pg_cron's jobs and run history and pg_net's request queue and
# response log: a restored database starts no scheduled job and repeats no
# queued request until you choose (the runbook's cutover re-creates MGM's
# job). Within those schemas it also leaves out the data of:
#   - Supabase's own migration ledgers, which the target project has, and the
#     Storage vector tables Supabase's guide excludes.
#   - Auth's session state and second factors: sessions, refresh tokens, MFA
#     factors, challenges and claims, pending sign-in flows, one-time tokens,
#     SAML relay states, pending OAuth authorizations and client states, and
#     WebAuthn challenges. Refresh tokens are usable values that do not expire
#     by default, MFA factors hold TOTP secrets and pending authorizations
#     hold authorization codes, so with them an export would let its holder
#     act as a signed-in user. Everyone signs in again after a restore, and
#     users enroll MFA factors again.
#   - Auth's custom OAuth providers, which hold each provider's client
#     secret. They are configuration, recorded and re-created with the
#     project's other Auth settings.
# Every other table in auth is exported, among them the clients registered
# with Auth's OAuth server (whose secrets Auth stores only as hashes), the
# consents users gave those clients, and WebAuthn credentials (public keys).
# When a Supabase upgrade adds a table to auth,
# scripts/tests/test_export_restore_e2e.py fails until it is classified here
# or in that test's list of knowingly exported tables.

readonly DATA_SCHEMAS=(public auth storage supabase_functions)
readonly DATA_EXCLUDED_TABLES=(
  auth.schema_migrations
  storage.migrations
  supabase_functions.migrations
  storage.buckets_vectors
  storage.vector_indexes
  auth.sessions
  auth.refresh_tokens
  auth.mfa_factors
  auth.mfa_challenges
  auth.mfa_amr_claims
  auth.flow_state
  auth.one_time_tokens
  auth.saml_relay_states
  auth.oauth_authorizations
  auth.oauth_client_states
  auth.webauthn_challenges
  auth.custom_oauth_providers
)

data_selection=()
for schema in "${DATA_SCHEMAS[@]}"; do
  data_selection+=("--schema=\"$schema\"")
done
for table in "${DATA_EXCLUDED_TABLES[@]}"; do
  data_selection+=("--exclude-table=\"${table%%.*}\".\"${table#*.}\"")
done

# Each file comes from its own pg_dump or pg_dumpall run, with its own
# snapshot. A migration applied between two runs would leave schema.sql from
# before it and data.sql or history_data.sql from after it, which may not
# restore. So the migration history is dumped once more, first of all, into
# the staging directory but not the export, and compared with
# history_data.sql, dumped last; if a migration was recorded in between, the
# export fails. A schema change made without recording a migration, such as
# one in the SQL editor, goes unnoticed, so the runbook also says not to
# export during a deploy. pg_dump --snapshot could give the pg_dump runs one
# snapshot, but only while another session holds a transaction open for the
# whole export, and pg_dumpall cannot use it.

history_first="$stage/history_first.sql"

# Prints a dump without its \restrict and \unrestrict lines, whose key pg_dump
# chooses at random on every run.
without_restrict_key() {
  sed -E '/^-- \\(un)?restrict /d' "$1"
}

run_dump "initial migration history" dump_data "$history_first" --schema=supabase_migrations
run_dump "roles" dump_roles "$work/roles.sql"
run_dump "schema" dump_schema "$work/schema.sql" "$MANAGED_SCHEMAS" --exclude-schema="$MANAGED_SCHEMAS"
# The rows in data.sql are those of the snapshot pg_dump takes when it starts,
# which is later than created_utc by however long the dumps before it took.
# This time, read just before pg_dump starts, is no later than the snapshot:
# a change committed before it is in the export, and one committed after it
# may not be.
data_dump_started_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  || die "$EXIT_DUMP" "cannot read the clock"
run_dump "data" dump_data "$work/data.sql" "${data_selection[@]}"
run_dump "migration history schema" dump_schema "$work/history_schema.sql" "" --schema=supabase_migrations
run_dump "migration history data" dump_data "$work/history_data.sql" --schema=supabase_migrations

history_at_start=$(without_restrict_key "$history_first") \
  || die "$EXIT_DUMP" "cannot read the initial migration history"
history_at_end=$(without_restrict_key "$work/history_data.sql") \
  || die "$EXIT_DUMP" "cannot read history_data.sql"
if [[ $history_at_start != "$history_at_end" ]]; then
  die "$EXIT_DUMP" "the migration history changed while the export ran, so its files may come from both sides of a migration; export again when no deploy is running"
fi

# --- Manifest ----------------------------------------------------------------
# Times are UTC from the export host's clock, to the second.

server_version=$(awk '
  /^-- Dumped from database version / {
    sub(/^-- Dumped from database version /, "")
    print
    exit
  }' "$work/data.sql")
server_version=$(version_text "$server_version")

printf -v manifest '{\n  "format": "%s",\n  "created_utc": "%s",\n  "data_dump_started_utc": "%s",\n  "pg_dump_version": "%s",\n  "server_version": "%s",\n  "files": [' \
  "$EXPORT_FORMAT" "$started_utc" "$data_dump_started_utc" "$pg_dump_version" "$server_version"
separator=$'\n'
for file in "${DUMP_FILES[@]}"; do
  file_bytes=$(bytes_of "$work/$file") \
    || die "$EXIT_PACKAGE" "cannot read the size of $file"
  file_sha256=$(sha256_of "$work/$file") \
    || die "$EXIT_PACKAGE" "cannot compute the SHA-256 of $file"
  printf -v entry '%s    {"name": "%s", "bytes": %s, "sha256": "%s"}' \
    "$separator" "$file" "$file_bytes" "$file_sha256"
  manifest+=$entry
  separator=$',\n'
done
manifest+=$'\n  ]\n}\n'
printf '%s' "$manifest" >"$work/manifest.json" \
  || die "$EXIT_PACKAGE" "cannot write manifest.json"

# --- Output ------------------------------------------------------------------
# The SHA-256 goes to stderr, which a scheduler keeps in its own log, outside
# export storage. At restore time it shows that a file is the one this run
# wrote: the manifest inside the archive detects corruption, not replacement,
# because anyone who can write to export storage can encrypt to the public
# recipients. Each checksum is computed before the export is moved into place,
# so a run that cannot report one fails without leaving an export behind.

if ((plaintext)); then
  manifest_sha256=$(sha256_of "$work/manifest.json") \
    || die "$EXIT_PACKAGE" "cannot compute the SHA-256 of manifest.json"
  [[ ! -e $final_path ]] || die "$EXIT_PACKAGE" "an export with this name appeared while dumping: $final_path"
  mv -- "$work" "$final_path" || die "$EXIT_PACKAGE" "cannot move the export into place: $final_path"
  note "wrote plaintext export; it contains personal data and encrypted credentials, so protect it accordingly"
  note "sha256 $manifest_sha256  $export_name/manifest.json"
  printf '%s\n' "$final_path"
  exit 0
fi

note "encrypting"
partial="$out_dir/.$export_name.tar.gz.age.$$.partial"
[[ ! -e $partial ]] || die "$EXIT_PACKAGE" "a partial export with this name already exists: $partial"
# COPYFILE_DISABLE stops macOS tar from adding ._ metadata files; other
# platforms ignore it. The dump log stays out of the archive.
if ! COPYFILE_DISABLE=1 tar -C "$stage" -czf - "$export_name" | age -R "$recipients_file" -o "$partial"; then
  die "$EXIT_PACKAGE" "packaging or age encryption failed"
fi
header=""
if [[ -s $partial ]]; then
  IFS= read -r header <"$partial" || true
fi
[[ $header == "age-encryption.org/v1" ]] \
  || die "$EXIT_PACKAGE" "age did not produce an encrypted file"
encrypted_sha256=$(sha256_of "$partial") \
  || die "$EXIT_PACKAGE" "cannot compute the SHA-256 of the encrypted export"

[[ ! -e $final_path ]] || die "$EXIT_PACKAGE" "an export with this name appeared while dumping: $final_path"
mv -- "$partial" "$final_path" || die "$EXIT_PACKAGE" "cannot move the export into place: $final_path"
partial=""
cleanup
stage=""
note "wrote encrypted export; plaintext removed"
note "sha256 $encrypted_sha256  $export_name.tar.gz.age"
printf '%s\n' "$final_path"

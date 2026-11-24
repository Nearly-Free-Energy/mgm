#!/bin/sh
# Generates the Supabase database types, formatted, for the npm scripts
# db:types, db:types:check and db:types:linked.
#
#   scripts/db-types.sh write   regenerate src/lib/types/database.gen.ts from
#                               the local database
#   scripts/db-types.sh check   compare it with the local database's types;
#                               skip when no local database is running
#   scripts/db-types.sh print   print the linked project's types
#
# The pinned Supabase CLI prints the types unformatted, so they go through
# the pinned prettier with --no-semi, the style postgres-meta formats with,
# and no config file. Both run with --no-install, so a missing
# `npm install` fails here instead of fetching another version. The file is
# written only when every stage succeeds and produced something, so a failed
# run leaves it as it was.
#
# `print` is for reading the linked project, not for the committed file: the
# CLI asks Supabase's hosted generator there, not the pinned postgres-meta,
# and a project's schema can differ from the migrations. The Test gate
# compares database.gen.ts with the types the migrations make.

set -u
mode=${1:-}
case "$mode" in
  write | check) source=--local ;;
  print) source=--linked ;;
  *) echo "usage: scripts/db-types.sh write|check|print [supabase flags]" >&2; exit 2 ;;
esac
shift
out=src/lib/types/database.gen.ts

raw=$(mktemp) || exit 1
err=$(mktemp) || exit 1
types=$(mktemp) || exit 1
trap 'rm -f "$raw" "$err" "$types"' EXIT

npx --no-install supabase gen types typescript "$source" "$@" > "$raw" 2> "$err"
status=$?
if [ "$status" -ne 0 ]; then
  if [ "$mode" = check ]; then
    echo 'db:types:check: supabase not running — skipping'
    exit 0
  fi
  # With no database the CLI prints its error to stdout, so show both.
  echo "db:types: supabase gen types typescript $source $* failed (exit $status):" >&2
  cat "$raw" "$err" >&2
  exit 1
fi

if ! grep -v -e '^Connecting to' -e '^A new version' -e '^We recommend' "$raw" \
  | npx --no-install prettier --no-config --parser typescript --no-semi > "$types"; then
  echo 'db:types: prettier could not format the generated types:' >&2
  cat "$raw" >&2
  exit 1
fi
if [ ! -s "$types" ]; then
  echo 'db:types: the generated types are empty' >&2
  exit 1
fi

case "$mode" in
  write) cat "$types" > "$out" ;;
  print) cat "$types" ;;
  check)
    if ! diff "$types" "$out"; then
      echo 'database.gen.ts is out of date — run npm run db:types'
      exit 1
    fi
    ;;
esac

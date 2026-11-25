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
# The pinned Supabase CLI (3.x) prints the types unformatted on stdout and
# everything else (its target, "Connecting to", warnings) on stderr, so the
# types go through the pinned prettier with --no-semi, the style
# postgres-meta formats with, and no config file. Both run with
# --no-install, so a missing `npm install` fails here instead of fetching
# another version. --agent=no keeps the CLI's output the same when a coding
# agent runs this (its agent mode prints errors as JSON on stdout). The file
# is written only when every stage succeeds and produced something, so a
# failed run leaves it as it was.
#
# The CLI targets the local database unless told otherwise; `print` passes
# --remote, the linked project. `print` is for reading the linked project,
# not for the committed file: the CLI reads that database directly only when
# a database password resolves, and otherwise asks Supabase's hosted
# generator, and a project's schema can differ from the migrations. The Test
# gate compares database.gen.ts with the types the migrations make.

set -u
mode=${1:-}
case "$mode" in
  write | check | print) shift ;;
  *) echo "usage: scripts/db-types.sh write|check|print [supabase flags]" >&2; exit 2 ;;
esac
if [ "$mode" = print ]; then set -- --remote "$@"; fi
out=src/lib/types/database.gen.ts

raw=$(mktemp) || exit 1
err=$(mktemp) || exit 1
types=$(mktemp) || exit 1
trap 'rm -f "$raw" "$err" "$types"' EXIT

npx --no-install supabase gen types typescript --agent=no "$@" > "$raw" 2> "$err"
status=$?
if [ "$status" -ne 0 ]; then
  if [ "$mode" = check ]; then
    echo 'db:types:check: supabase not running — skipping'
    exit 0
  fi
  # Show both streams, whichever the CLI printed its error on.
  echo "db:types: supabase gen types typescript $* failed (exit $status):" >&2
  cat "$raw" "$err" >&2
  exit 1
fi

if ! npx --no-install prettier --no-config --parser typescript --no-semi < "$raw" > "$types"; then
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

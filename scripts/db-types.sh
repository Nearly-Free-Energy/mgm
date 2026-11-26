#!/bin/sh
# Generates the Supabase database types, formatted, for the npm scripts
# db:types, db:types:check and db:types:linked.
#
#   scripts/db-types.sh write   regenerate src/lib/types/database.gen.ts from
#                               the local database
#   scripts/db-types.sh check   compare it with the local database's types;
#                               skip only when there is no local database
#                               container, or no Docker
#   scripts/db-types.sh print   print the linked project's types
#
# The pinned Supabase CLI (3.x) prints the types unformatted on stdout and
# everything else (its target, "Connecting to", warnings) on stderr, so the
# types go through the pinned prettier with --no-semi, the style
# postgres-meta formats with, and no config file. Both run with
# --no-install, so npx never fetches another version; without `npm install`
# it runs a `supabase` on PATH if there is one, held to 3.x below.
# --agent=no keeps the CLI's output the same when a coding agent runs this
# (its agent mode prints errors as JSON on stdout). The file is written only
# when every stage succeeds and produced something, so a failed run leaves
# it as it was.
#
# write and check pass no target: CLI 3 reads the local database unless told
# otherwise, and `print` passes --remote, the linked project. A 2.x CLI would
# read the linked project instead, or fail when nothing is linked, and
# node_modules keeps one until `npm ci` (git checkout and the pre-commit hook
# do not reinstall), so every mode refuses a CLI older than 3. If the pin
# moves to a CLI whose default is not the local database, pass the target
# here. check skips only on the errors CLI 3.4.0's `gen types` gives when
# there is no local database container, or no Docker (not installed or not
# running), so a contributor in cloud mode, which needs no Docker, can still
# commit; any other failure, such as a config the CLI refuses, fails the hook.
# The Docker wordings are the CLI's own set: isDockerDaemonUnreachable and
# DOCKER_DAEMON_CONNECTION_FAILURE_PATTERN in
# apps/cli/src/command-internal/docker-suggest.ts@v3.4.0, and
# containerRuntimeNotFoundMessage in container-cli.ts@v3.4.0. If a later CLI
# words those errors differently, check fails instead of skipping until this
# is updated.
#
# `print` is for reading the linked project, not for the committed file: the
# CLI reads that database directly only when a database password resolves,
# and otherwise asks Supabase's hosted generator, and a project's schema can
# differ from the migrations. The Test gate compares database.gen.ts with the
# types the migrations make.

set -u
mode=${1:-}
case "$mode" in
  write | check | print) shift ;;
  *) echo "usage: scripts/db-types.sh write|check|print [supabase flags]" >&2; exit 2 ;;
esac
if [ "$mode" = print ]; then set -- --remote "$@"; fi
out=src/lib/types/database.gen.ts

version=$(npx --no-install supabase --version 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)
if [ -z "$version" ] || [ "${version%%.*}" -lt 3 ]; then
  echo "db:types: needs the pinned Supabase CLI 3.x in node_modules, which reads the local database by default; found ${version:-none}." >&2
  echo "db:types: run npm ci (git checkout and the pre-commit hook do not reinstall it), then try again." >&2
  exit 1
fi

raw=$(mktemp) || exit 1
err=$(mktemp) || exit 1
types=$(mktemp) || exit 1
trap 'rm -f "$raw" "$err" "$types"' EXIT

npx --no-install supabase gen types typescript --agent=no "$@" > "$raw" 2> "$err"
status=$?
if [ "$status" -ne 0 ]; then
  # The errors CLI 3.4.0's gen types gives when there is no local database
  # to read: no container for this project_id, a Docker or Podman daemon it
  # cannot reach, or neither binary on PATH (the header names the sources).
  if [ "$mode" = check ] && grep -qiE 'supabase start is not running|cannot connect to the docker daemon|cannot connect to podman|failed to connect to the docker api|error during connect|is the docker daemon running|permission denied while trying to connect|command not found \(podman also not found\)' "$err"; then
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

#!/usr/bin/env bash
# Build MGM's deployment asset: Vercel's prebuilt build output for one commit,
# packed as a .tar.gz with a SHA-256 checksum file, and the third-party notices
# for it, published beside it.
#
#   build-deploy-asset.sh --version <vX.Y.Z> --out <dir> [--ref <commit>]
#                         [--preview] [--allow-foreign-platform]
#
# Maintainer guide: docs/releasing.md. The Release workflow
# (.github/workflows/release.yml) runs this on a GitHub-hosted Linux x86-64
# runner and attaches the result to a GitHub release. Run it locally only to
# test the packaging or a deployment procedure; never publish a local build.
#
# An asset must embed nothing that belongs to one installation, so:
#   - it is built from the committed tree of one commit (`git archive`), never
#     from a working tree, so an .env file, a linked .vercel directory or any
#     other untracked file cannot reach it;
#   - the build runs with no Vercel login or token, placeholder project IDs,
#     and an environment built from an allowlist (`env -i`), in a temporary
#     directory with an empty HOME;
#   - the script refuses to start when the calling shell holds MGM settings
#     (NEXT_PUBLIC_*, MGM_*, SUPABASE_*) or Vercel credentials, so a configured
#     shell is noticed instead of silently ignored.

set -euo pipefail
umask 022
unset CDPATH

readonly PROG="build-deploy-asset.sh"
readonly EXIT_USAGE=2
readonly EXIT_PRECONDITION=3
readonly EXIT_BUILD=4
readonly EXIT_PACKAGE=5

# The Vercel CLI that builds the asset is locked with its whole dependency
# tree in vercel-cli/ beside this script: package.json pins `vercel` exactly
# and package-lock.json pins every package it depends on by integrity hash.
# `vercel build` loads the framework builder (@vercel/next) from that tree; the
# build info and the release notes record both versions. Change it
# deliberately (docs/releasing.md, "Maintaining the release path").
readonly VERSION_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'

usage() {
  printf '%s\n' \
    "Usage: $PROG --version <vX.Y.Z> --out <dir> [--ref <commit>] [--preview] [--allow-foreign-platform]" \
    "" \
    "Builds Vercel's prebuilt output (vercel build --prod --standalone) from the" \
    "committed tree of one commit, checks it, packs it deterministically, and" \
    "lists the third-party packages in it." \
    "Writes to DIR:" \
    "  mgm-vercel-output-<version>.tar.gz             the asset; extract it into" \
    "                                                 .vercel/output to deploy it" \
    "  mgm-vercel-output-<version>.tar.gz.sha256      its SHA-256 (sha256sum -c)" \
    "  mgm-vercel-output-<version>.build-info.json    commit, target, digest, and" \
    "                                                 the tool and runtime versions" \
    "  mgm-third-party-notices-<version>.txt          each third-party package in" \
    "                                                 the asset, with its licence" \
    "                                                 and notice texts" \
    "  mgm-third-party-notices-<version>.txt.sha256   its SHA-256" \
    "" \
    "  --version V              Release version, for example v0.0.1." \
    "  --out DIR                Directory for the files above (created if missing)." \
    "                           Existing files are never replaced." \
    "  --ref COMMIT             Commit to build (default HEAD). Uncommitted changes" \
    "                           are never included." \
    "  --preview                Build for Vercel's preview target instead of" \
    "                           production, for a smoke test that must not use" \
    "                           --prod. Adds -preview to the file names. Release" \
    "                           assets are always production builds." \
    "  --allow-foreign-platform Allow a build on a host other than Linux x86-64," \
    "                           for a local packaging test. The functions then" \
    "                           carry that host's native modules and architecture" \
    "                           and do not run on Vercel. Adds -local-<os>-<arch>" \
    "                           to the file names." \
    "  -h, --help               Show this help." \
    "" \
    "Needs git, node (the major version in .nvmrc), npm, python3, tar, and network" \
    "access to the npm registry and Google Fonts. Installs the Vercel CLI locked in" \
    "scripts/release/vercel-cli/ into a temporary directory with npm ci, without" \
    "running install scripts; no Vercel account is used." \
    "" \
    "Prints the asset's path on stdout; progress goes to stderr." \
    "" \
    "Exit codes:" \
    "  0  asset written" \
    "  2  usage error" \
    "  3  refused before building: the environment holds MGM settings or Vercel" \
    "     credentials, the host is not Linux x86-64, an output file exists, the" \
    "     commit, a required program or the Vercel CLI's lockfile is missing, or" \
    "     Node.js is not the .nvmrc version" \
    "  4  installing, building, or checking the build output failed, or a" \
    "     package in it could not be identified for the notices" \
    "  5  packing, writing the notices, checksumming, or moving the files into" \
    "     DIR failed" \
    "" \
    "See docs/releasing.md."
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

# Names an argument in an error message without repeating its value.
describe_arg() {
  local name=${1%%=*}
  local re='^--?[A-Za-z0-9][A-Za-z0-9-]*$'
  if [[ $name =~ $re ]]; then
    printf '%s' "$name"
  else
    printf '%s' "(argument not shown)"
  fi
}

sha256_of() {
  local sum re='^[0123456789abcdef]{64}$'
  if command -v sha256sum >/dev/null 2>&1; then
    sum=$(sha256sum <"$1") || return
  else
    sum=$(shasum -a 256 <"$1") || return
  fi
  sum=${sum%% *}
  [[ $sum =~ $re ]] || return 1
  printf '%s' "$sum"
}

# --- Arguments ---------------------------------------------------------------

version=""
out_dir=""
ref=""
preview=0
allow_foreign=0

while (($# > 0)); do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --preview)
      preview=1
      shift
      ;;
    --allow-foreign-platform)
      allow_foreign=1
      shift
      ;;
    --version | --out | --ref)
      if (($# < 2)) || [[ -z $2 || $2 == -* ]]; then
        die_usage "$1 needs a value"
      fi
      case $1 in
        --version)
          [[ -z $version ]] || die_usage "--version given more than once"
          version=$2
          ;;
        --out)
          [[ -z $out_dir ]] || die_usage "--out given more than once"
          out_dir=$2
          ;;
        --ref)
          [[ -z $ref ]] || die_usage "--ref given more than once"
          ref=$2
          ;;
      esac
      shift 2
      ;;
    *)
      die_usage "unknown argument: $(describe_arg "$1")"
      ;;
  esac
done

[[ -n $version ]] || die_usage "--version is required"
[[ -n $out_dir ]] || die_usage "--out is required"
[[ $version =~ $VERSION_RE ]] || die_usage "--version must look like v0.0.1 or v0.0.1-rc.1"
ref=${ref:-HEAD}

# --- Preconditions -----------------------------------------------------------

# The build never sees these: it runs under `env -i`. They are refused anyway,
# because a shell that holds them is one where an installation's settings or
# credentials are close at hand, and the person running this should notice.
refused=()
while IFS= read -r name; do
  case $name in
    NEXT_PUBLIC_* | MGM_* | SUPABASE_* | VERCEL_TOKEN | VERCEL_ORG_ID | VERCEL_PROJECT_ID)
      refused+=("$name")
      ;;
  esac
done < <(compgen -e)
if ((${#refused[@]} > 0)); then
  die "$EXIT_PRECONDITION" "refusing to build: the environment sets ${refused[*]}." \
    "A release asset must not depend on one installation's settings or credentials." \
    "Run from a shell without them, for example: env -u ${refused[0]} $PROG ..."
fi

for tool in git node npm python3 tar mktemp uname; do
  command -v "$tool" >/dev/null 2>&1 || die "$EXIT_PRECONDITION" "$tool is not installed"
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
  || die "$EXIT_PRECONDITION" "neither sha256sum nor shasum is installed"

host_os=$(uname -s)
host_arch=$(uname -m)
platform_suffix=""
if [[ $host_os != Linux || $host_arch != x86_64 ]]; then
  if ((allow_foreign == 0)); then
    die "$EXIT_PRECONDITION" "this host is $host_os $host_arch. The build copies the" \
      "host's native modules into the functions and records the host's architecture," \
      "and Vercel runs Node.js functions on Linux x86-64, so only a Linux x86-64 build" \
      "is deployable. For a local packaging test, pass --allow-foreign-platform."
  fi
  platform_suffix=$(printf '%s-%s' "$host_os" "$host_arch" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '_')
  platform_suffix="-local-$platform_suffix"
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) \
  || die "$EXIT_PRECONDITION" "$script_dir is not inside a git checkout"

cli_dir="$script_dir/vercel-cli"
[[ -f $cli_dir/package.json && -f $cli_dir/package-lock.json ]] \
  || die "$EXIT_PRECONDITION" "$cli_dir needs package.json and package-lock.json"
# npm ci refuses a lockfile that does not match package.json, so the exact
# version here is also the one the lockfile installs.
cli_pin=$(node -p 'String(require(process.argv[1]).dependencies.vercel)' "$cli_dir/package.json" 2>/dev/null) \
  || die "$EXIT_PRECONDITION" "$cli_dir/package.json is unreadable"
[[ $cli_pin =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "$EXIT_PRECONDITION" "$cli_dir/package.json must pin vercel to an exact version such as 65.1.0"
commit=$(git -C "$repo" rev-parse --verify --quiet "${ref}^{commit}") \
  || die "$EXIT_PRECONDITION" "not a commit in $repo: $ref"

if ((preview)); then
  target=preview
  variant="${version}-preview${platform_suffix}"
else
  target=production
  variant="${version}${platform_suffix}"
fi
name="mgm-vercel-output-$variant"
notices_name="mgm-third-party-notices-$variant.txt"

mkdir -p -- "$out_dir" || die "$EXIT_PRECONDITION" "cannot create $out_dir"
out_dir=$(cd -- "$out_dir" && pwd -P)
asset="$out_dir/$name.tar.gz"
checksum="$asset.sha256"
info="$out_dir/$name.build-info.json"
notices="$out_dir/$notices_name"
notices_checksum="$notices.sha256"
for file in "$asset" "$checksum" "$info" "$notices" "$notices_checksum"; do
  if [[ -e $file || -L $file ]]; then
    die "$EXIT_PRECONDITION" "$file already exists; an asset is never replaced." \
      "Use a new version, or remove the old files if they were never published."
  fi
done

nvmrc=$(git -C "$repo" show "$commit:.nvmrc" 2>/dev/null) \
  || die "$EXIT_PRECONDITION" "the commit has no .nvmrc"
node_major=${nvmrc#v}
node_major=${node_major%%[!0-9]*}
[[ -n $node_major ]] || die "$EXIT_PRECONDITION" "the commit's .nvmrc names no Node.js major version"
host_node=$(node -p 'process.versions.node.split(".")[0]')
[[ $host_node == "$node_major" ]] \
  || die "$EXIT_PRECONDITION" "Node.js $host_node is installed; this commit's .nvmrc pins $node_major"

# --- Build -------------------------------------------------------------------

tmp_root=${TMPDIR:-/tmp}
work=$(mktemp -d "${tmp_root%/}/mgm-release.XXXXXX") \
  || die "$EXIT_PRECONDITION" "cannot create a temporary directory"
# The work directory holds a full npm install; remove it however the run ends.
cleanup() {
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work/src" "$work/home" "$work/cli"

# Reuse the caller's npm cache: npm checks every cached package against the
# lockfile's integrity hash, so the cache only saves downloads.
npm_cache=$(npm config get cache 2>/dev/null || true)
[[ $npm_cache == /* ]] || npm_cache="$work/npm-cache"

# Runs a command with an environment built from scratch: an empty HOME (so no
# Vercel login, npm token or CLI config is found), the caller's PATH, and
# telemetry off. Nothing else from the caller's environment reaches the build.
clean_env() {
  env -i \
    HOME="$work/home" \
    PATH="$PATH" \
    CI=1 \
    HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    VERCEL_TELEMETRY_DISABLED=1 \
    npm_config_cache="$npm_cache" \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    "$@"
}

note "building $commit for the $target target"
git -C "$repo" archive --format=tar "$commit" | tar -xf - -C "$work/src" \
  || die "$EXIT_BUILD" "exporting $commit failed"

# npm ci installs exactly the locked tree and checks every package against
# its integrity hash. --ignore-scripts runs no package's install script. The
# locked tree builds without them: esbuild, the one package in it with an
# install script on Linux, loads its binary from its platform package without
# that script. If a CLI upgrade adds a package that needs its install script,
# the dry run's build fails; revisit this flag then.
note "installing Vercel CLI $cli_pin from its lockfile (npm ci --ignore-scripts)"
cp -- "$cli_dir/package.json" "$cli_dir/package-lock.json" "$work/cli/" \
  || die "$EXIT_BUILD" "copying the Vercel CLI's lockfile failed"
(cd "$work/cli" && clean_env npm ci --ignore-scripts --loglevel=error) >&2 \
  || die "$EXIT_BUILD" "installing Vercel CLI $cli_pin failed"
vercel="$work/cli/node_modules/.bin/vercel"
cli_version=$(cd "$work/src" && clean_env "$vercel" --version 2>/dev/null | tail -n 1) \
  || die "$EXIT_BUILD" "the Vercel CLI did not run"
[[ $cli_version == "$cli_pin" ]] \
  || die "$EXIT_BUILD" "the Vercel CLI reports version $cli_version, expected $cli_pin"

note "installing dependencies (npm ci)"
(cd "$work/src" && clean_env npm ci --loglevel=error) >&2 || die "$EXIT_BUILD" "npm ci failed"

# `vercel build` needs project settings on disk and never checks the IDs, so
# placeholders keep any real project's identity out of the asset. The settings
# match the hosting project's (Next.js preset, default install, build and
# output commands, Node.js from .nvmrc); if that project gains overrides,
# mirror them here, or the asset is built differently from how the host would
# build the same commit.
mkdir "$work/src/.vercel"
printf '{"projectId":"prj_placeholder","orgId":"team_placeholder","settings":{"framework":"nextjs","nodeVersion":"%s.x"}}\n' \
  "$node_major" >"$work/src/.vercel/project.json"

# --standalone copies every file a function needs into the output; without it
# the functions point back into this temporary directory's node_modules.
build_args=(build)
((preview)) || build_args+=(--prod)
build_args+=(--standalone)
note "running vercel ${build_args[*]}"
(cd "$work/src" && clean_env "$vercel" "${build_args[@]}") >&2 || die "$EXIT_BUILD" "vercel build failed"

# --- Check and pack ----------------------------------------------------------

check_args=(
  "$work/src/.vercel/output" "$work/$name.tar.gz"
  --info "$work/$name.build-info.json"
  --version "$version"
  --commit "$commit"
  --mtime "$(git -C "$repo" log -1 --format=%ct "$commit")"
  --target "$target"
  --node-runtime "nodejs${node_major}.x"
  --vercel-cli "$cli_version"
)
[[ -n $platform_suffix ]] || check_args+=(--require-linux-x64)
note "checking and packing the build output"
status=0
packed_sha=$(python3 -I "$script_dir/vercel_build_output.py" "${check_args[@]}") || status=$?
case $status in
  0) ;;
  4) die "$EXIT_BUILD" "the build output failed the checks above" ;;
  *) die "$EXIT_PACKAGE" "packing the build output failed" ;;
esac

# An independent SHA-256 of the archive, compared with the packer's.
sha=$(sha256_of "$work/$name.tar.gz") || die "$EXIT_PACKAGE" "computing the SHA-256 failed"
[[ $sha == "$packed_sha" ]] || die "$EXIT_PACKAGE" "the archive's SHA-256 does not match the packer's"
printf '%s  %s\n' "$sha" "$name.tar.gz" >"$work/$name.tar.gz.sha256"

# The notices go beside the asset, not into the output, which deploys as
# Vercel built it. The build directory supplies what the output leaves out:
# the packages' licence files and the source maps of the bundled code.
note "writing the third-party notices"
status=0
notices_sha=$(python3 -I "$script_dir/third_party_notices.py" "$work/src/.vercel/output" "$work/$notices_name" \
  --project "$work/src" --asset "$name.tar.gz" --version "$version" --commit "$commit") || status=$?
case $status in
  0) ;;
  4) die "$EXIT_BUILD" "a package in the build output could not be identified for the notices" ;;
  *) die "$EXIT_PACKAGE" "writing the third-party notices failed" ;;
esac
notices_check=$(sha256_of "$work/$notices_name") || die "$EXIT_PACKAGE" "computing the notices' SHA-256 failed"
[[ $notices_check == "$notices_sha" ]] || die "$EXIT_PACKAGE" "the notices' SHA-256 does not match the writer's"
printf '%s  %s\n' "$notices_sha" "$notices_name" >"$work/$notices_name.sha256"

mv -- "$work/$name.build-info.json" "$info" || die "$EXIT_PACKAGE" "moving the build info into $out_dir failed"
mv -- "$work/$name.tar.gz" "$asset" || die "$EXIT_PACKAGE" "moving the asset into $out_dir failed"
mv -- "$work/$name.tar.gz.sha256" "$checksum" || die "$EXIT_PACKAGE" "moving the checksum into $out_dir failed"
mv -- "$work/$notices_name" "$notices" || die "$EXIT_PACKAGE" "moving the notices into $out_dir failed"
mv -- "$work/$notices_name.sha256" "$notices_checksum" \
  || die "$EXIT_PACKAGE" "moving the notices' checksum into $out_dir failed"

note "asset:   $asset"
note "notices: $notices"
note "sha256:  $sha"
note "commit:  $commit ($target target, Vercel CLI $cli_version)"
if [[ -n $platform_suffix ]]; then
  note "built on $host_os $host_arch: for local tests only; its functions do not run on Vercel"
fi
printf '%s\n' "$asset"

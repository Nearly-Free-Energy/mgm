# Releasing MGM

A release of MGM carries a deployment asset: Vercel's prebuilt build output
for one commit of `main`, packed as `mgm-vercel-output-<version>.tar.gz`. Beside
it are its third-party notices, `mgm-third-party-notices-<version>.txt`, a
SHA-256 file for each, and a build-provenance attestation that covers both.
The Release workflow (`.github/workflows/release.yml`) builds them and attaches
them when a maintainer publishes a GitHub release.

**Publishing a release deploys nothing.** The workflow has no hosting
credentials and reads no secret. An operator chooses a version, verifies it,
and deploys it with their own credentials and procedure; see
[Deploying an asset](#deploying-an-asset). NFE's own deployment procedure is
kept outside this repository.

Versions are `v0.0.N` pre-releases for now. A version is never reused and an
uploaded asset is never replaced. Keep earlier releases: an operator rolls
back by deploying a previous version they verified.

> **Not yet usable.** Until the request-time configuration slice of #46 is on
> `main`, the browser code reads its Supabase settings at build time, so an
> asset built from `main` has none and cannot serve a working installation.
> Publish no release before then. Remove this note when that slice merges.

## What the asset is

- **The `.vercel/output` directory** produced by
  `vercel build --prod --standalone` (Vercel's Build Output API, version 3).
  Archive entries are relative to that directory: extract the archive into
  `.vercel/output`.
- **A production-target build.** `vercel deploy --prebuilt` accepts it only
  with `--prod`, and otherwise refuses it before uploading anything.
- **Self-contained.** `--standalone` copies every file the functions need into
  the output, so it deploys from an empty directory.
- **Built on a GitHub-hosted Linux x86-64 runner.** The build copies only the
  build host's native modules (MGM uses `argon2`) into the functions and
  records the host's architecture, and Vercel runs Node.js functions on Linux
  x86-64. The build script refuses any other host unless told the build is a
  local test.
- **Free of installation settings.** It is built from the committed tree,
  with placeholder project IDs, no Vercel account or token, and an
  environment made from an allowlist. Each installation supplies its own
  settings to its deployment.
- **Identified by its digest, not by rebuilding it.** Every Next.js build gets
  its own build ID, so two builds of one commit differ. The attestation ties
  the asset's SHA-256 to its commit and to this repository's Release workflow.
- **Published with its third-party notices.** The build copies into the
  functions only the files they load, which rarely include the npm packages'
  licence files. `mgm-third-party-notices-<version>.txt` lists every third-party package in
  the asset, with its name, version and declared licence and the full text of
  its LICENSE, LICENCE, COPYING and NOTICE files; identical texts are printed
  once. It is a separate file, not part of the archive, so the asset deploys
  exactly as Vercel built it.

## Publish a version

1. Choose a commit on `main` whose `Test`, `CodeQL` and `Build` checks passed:

   ```bash
   gh api repos/Nearly-Free-Energy/mgm/commits/<commit>/check-runs \
     --jq '.check_runs[] | "\(.name): \(.conclusion)"'
   ```

2. Write the release notes: what changed since the previous version, and what
   an operator must do with it, such as database migrations to apply before
   deploying or configuration to add. The workflow appends the asset's
   details.

3. Publish a pre-release on that commit, tagged with the new version:

   ```bash
   gh release create v0.0.N --repo Nearly-Free-Energy/mgm \
     --target <full commit SHA> --prerelease --title v0.0.N --notes-file notes.md
   ```

   `--target` creates the tag at that commit. Publishing from the web UI works
   the same way; tick **Set as a pre-release**.

4. The Release workflow starts (`gh run list --repo Nearly-Free-Energy/mgm
   --workflow release.yml`). `Build release asset` checks that the tag is a
   version and that its commit is on `main`, then builds and checks the asset.
   `Publish release asset` creates the attestation, uploads
   `mgm-vercel-output-v0.0.N.tar.gz`, `mgm-third-party-notices-v0.0.N.txt` and
   their `.sha256` files to the release, and appends a "Deployment asset"
   section to the notes. It takes a few minutes.

5. [Verify the asset](#verify-an-asset) as an operator would before you
   announce the release.

If the run fails before uploading, nothing was published: fix the cause and
re-run the failed jobs. If it fails after uploading, leave the uploaded files
alone, because an operator may already have pinned them; finish the notes by
hand or publish the next version. Never upload an asset built anywhere else:
only the workflow's build carries an attestation.

## Verify an asset

```bash
version=v0.0.N
commit=<the full commit SHA you reviewed>
gh release download "$version" --repo Nearly-Free-Energy/mgm \
  --pattern "mgm-vercel-output-$version.tar.gz*" \
  --pattern "mgm-third-party-notices-$version.txt*" --dir "mgm-$version"
cd "mgm-$version"
sha256sum -c "mgm-vercel-output-$version.tar.gz.sha256" \
  "mgm-third-party-notices-$version.txt.sha256"   # macOS: shasum -a 256 -c
gh attestation verify "mgm-vercel-output-$version.tar.gz" \
  --repo Nearly-Free-Energy/mgm \
  --signer-workflow Nearly-Free-Energy/mgm/.github/workflows/release.yml \
  --source-digest "$commit"
```

- The `.sha256` file comes from the same release as the asset, so it shows
  only that the download is intact. An operator who pinned a digest compares
  the asset's SHA-256 with the pinned value instead.
- `gh attestation verify` shows that this repository's Release workflow built
  these exact bytes from the commit given to `--source-digest`. Run it on
  `mgm-third-party-notices-$version.txt` too: the same attestation covers it.
- To confirm that the commit is on `main`, run
  `gh api repos/Nearly-Free-Energy/mgm/compare/main...$commit --jq .status`;
  it prints `behind` or `identical`.

## Deploying an asset

Each operator decides when to deploy which version. On Vercel, in outline:

1. Pin the version, commit and SHA-256 you approved, and verify the download
   as above.
2. Extract the archive into `.vercel/output` of an empty directory **outside
   any Git checkout**. Run inside a checkout, `vercel deploy` attaches that
   checkout's Git metadata (remote URL, commit, author) to the deployment.
3. Deploy with `vercel deploy --prebuilt --prod`, using your own credentials.
   Name the project with `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`; `vercel link`
   works too, but also downloads a development token into `.env.local`, so
   delete that file. Record what you deployed with `--meta`, for example
   `--meta mgmVersion=v0.0.N --meta mgmCommit=<commit>`; `vercel ls --meta`
   finds it again.

Apply any database migrations the release notes list before deploying the
application, as `docs/operating-model.md` describes.

## Build an asset locally

Do this only to test the packaging or a deployment procedure. A local build
has no attestation and must never be published.

```bash
scripts/release/build-deploy-asset.sh --version v0.0.0-test --out /tmp/mgm-asset
```

- It builds the committed tree of `HEAD`, or of `--ref <commit>`. Uncommitted
  changes are not included.
- It writes the notices file and its `.sha256` beside the asset, under the
  same version and suffixes.
- It needs Node.js from `.nvmrc`, npm, git, python3, tar, and network access
  to the npm registry and Google Fonts. It installs its pinned Vercel CLI into
  a temporary directory and takes a few minutes.
- It refuses to start while `NEXT_PUBLIC_*`, `MGM_*`, `SUPABASE_*`,
  `VERCEL_TOKEN`, `VERCEL_ORG_ID` or `VERCEL_PROJECT_ID` is set.
- On a host other than Linux x86-64 it stops unless you pass
  `--allow-foreign-platform`. That asset's name ends in `-local-<os>-<arch>`,
  and its Node.js functions do not run on Vercel.
- `--preview` builds for Vercel's preview target instead (the name gains
  `-preview`), for a smoke test that must not use `--prod`.

Pull requests that change the release path, the dependencies or the Node.js
version run the same build as a dry run in `Build release asset`. Its
artifact holds that Linux build for a day, for inspection.

## Maintaining the release path

- The Vercel CLI version is pinned in `build-deploy-asset.sh`
  (`VERCEL_CLI_VERSION`). The CLI loads the `@vercel/next` builder it depends
  on, and the release notes record both versions. Change the pin deliberately,
  in its own pull request, so the dry run shows its effect.
- The placeholder project settings in the script match the hosting project's:
  the Next.js preset, the default install, build and output commands, and
  Node.js from `.nvmrc`. If the hosting project gains overrides, mirror them
  in the script.
- Every operator's verification names `.github/workflows/release.yml`
  (`--signer-workflow`). Do not move or rename it without telling them.
- `scripts/release/third_party_notices.py` writes the notices. It finds a
  package in the asset four ways: its files are in a function's
  `node_modules`; the build's source map for a JavaScript file in the output
  names one of its modules; one of the project's stylesheets imports it; or it
  is the builder that writes the functions' launchers. Client-side bundles
  have no source maps, so a package that only browser code imports, and no
  server-rendered module does, is not found: check the notices of the dry run
  when adding one. The build fails, rather than leaving a package out, when a
  function's source map or a package's `package.json` cannot be read.
- `scripts/tests/test_build_deploy_asset.py` covers the packer's checks, the
  notices writer and the script's refusals; the `Test` workflow runs it.

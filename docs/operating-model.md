# Operating model

How MGM is built and changed. `CLAUDE.md` holds the detailed coding rules;
this page is the frame around them.

## What MGM is

MGM (Microgrid Manager) is an operating system for microgrid operators,
built as [Cordis](https://github.com/cordiverse/cordis) plugins on Next.js and
Supabase. An organization enables the plugins it needs — community
management, metering, billing, payments — and each plugin owns its routes,
tables, and capability (`src/lib/plugins/bundled.ts`,
`docs/cordis-runtime.md`). New capabilities and providers are added as
plugins, not as edits to existing ones.

## Invariants

These hold for every change. A change that needs to break one is a design
discussion first, not a PR.

1. **Organization isolation is enforced by the database.** Every table has
   Row Level Security; app-side checks are defense in depth. Policies chain
   through the helpers described in `CLAUDE.md`, whose meaning does not change.
2. **Every write enters the runtime.** A write route composes a capability or
   passes the plugin gate, so disabling a plugin really stops it
   (`route-surface.test.ts`).
3. **Vendor details stay behind provider plugins.** Billing never imports
   OpenEMS types or constructs vendor clients; payments never leak provider
   types past the capability.
4. **Credentials stay server-side and encrypted.** OpenEMS and payment secrets
   are encrypted at rest (`docs/runbooks/dek.md`) and never reach the browser.
5. **Money is reproducible.** Tariffs are pinned to a period before the first
   bill, closed periods are immutable, and a person closes a period — never a
   schedule.
6. **Releases are explicit.** A route is reachable only once it is listed in
   `src/lib/mgm/released-routes.ts`; inherited or unfinished surfaces stay
   behind it.

## Configuration

An installation is configured entirely by its server environment, read at
request time, so the same build or container image serves any installation
(#46; `docs/adr/ADR-003-runtime-public-configuration.md`; variables and the
migration from the old names in `docs/setup.md`, "Runtime configuration").

- **Public allowlist.** Exactly three values reach the browser:
  `MGM_PUBLIC_SUPABASE_URL`, `MGM_PUBLIC_SUPABASE_ANON_KEY` and the optional
  `MGM_PUBLIC_SUPABASE_COOKIE_NAME`. They are validated on the server
  (`src/lib/config/public-runtime-config.ts`) and passed from the root layout
  to `PublicRuntimeConfigProvider`. Browser code never reads `process.env`
  for them, and no new value joins the allowlist without the same review as a
  credential change.
- **Server-only settings.** `MGM_APP_URL` (public origin for payment links
  and payment-notification registration, `src/lib/config/app-url.ts`),
  `SUPABASE_INTERNAL_URL`, the service-role key, the credential encryption
  key and provider credentials are never serialized into props, HTML or
  bundles.
- **One source per request.** Browser, server and middleware (Node.js
  runtime) Supabase clients use the same validated values and cookie name;
  an internal Supabase URL on another host requires an explicit cookie name. The configuration-
  bearing root layout renders per request; it is never prerendered or served
  from a shared cache.
- **Fail clearly.** Missing or invalid settings stop the request (and, at
  server start, the server; `src/instrumentation.ts`) with an error naming the
  variable, never its value.
- **No `NEXT_PUBLIC_` for deployment settings.** Next.js inlines those at
  build time. The former `NEXT_PUBLIC_SUPABASE_*`, `NEXT_PUBLIC_APP_URL` and
  `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` names are a documented fallback for one
  release only.

## How work moves

1. **Issue.** Work starts as a GitHub issue on this repository describing the
   outcome, not the fix for an unfixed weakness (see below).
2. **Branch.** One branch per change (`codex/<topic>` or `<area>/<topic>`).
3. **Change.** Code, tests, and docs ship together: a migration ships with
   the database tests that assert it and the regenerated `database.gen.ts`,
   and a decision ships with the doc that records it.
4. **Pull request.** Signed, signed-off commits (`git commit -s -S`). The
   `Test`, `CodeQL`, and `Build` checks must pass; hosting previews are
   informational. See "Merge controls" below and `CONTRIBUTING.md`.
5. **Review.** The author, or a code owner for protected areas, reads the diff
   against the invariants above. Protected areas need approval from a code
   owner other than the author; other changes may be merged by their author
   once the checks pass. For anything touching RLS, money, credentials, or the
   runtime, also run the change against a database (`npm test` with local
   Supabase).
6. **Deploy.** Apply database migrations before deploying the app. Follow
   the runbook for the area (`docs/runbooks/`, `docs/payments-rollout.md`,
   `docs/customerapp-activation.md`).

## Merge controls

Merge control is a **maintainer social contract**, not an enforced ruleset.
GitHub does not block a merge that breaks it. Enforcement (branch protection or
a ruleset) is deferred; the decision is in launch tracker #30 § 2 and
`docs/adr/ADR-002-ci-build-gate-and-merge-controls.md`. `CLAUDE.md` §
"Required Merge Controls" has the per-check detail and `CONTRIBUTING.md` is the
contributor-facing version. Keep the three in step.

**Merger checklist.** The person who merges verifies each item and declines to
merge until it holds:

1. A pull request exists; nothing goes to `main` directly.
2. `Test`, `CodeQL` (both CodeQL entries) and `Build` are green.
3. Every commit is Verified (signed).
4. Every commit is signed off (`Signed-off-by:`). No automated DCO check
   reports this, so the merger reads the commits. A merge commit that only
   brings in `main` needs no sign-off; `git show --remerge-diff <sha>` prints
   nothing for one. A merge that resolves conflicts needs `-s`.
5. Code-owner approval for owned paths, on the final head commit, re-requested
   after any push, from someone other than the person who pushed the
   owned-path change. Reviewers suggest changes rather than pushing to the
   author's branch.
6. No rebase merging: GitHub cannot sign rebased commits. Squash or merge
   commit only.
7. Nobody force-pushes or deletes `main`.

| Check | Workflow | Notes |
|---|---|---|
| `Test` | `.github/workflows/test.yml` | types, lint, database rehearsals, full suite against a local Supabase; Node.js 24 from `.nvmrc` |
| `CodeQL` | `.github/workflows/codeql.yml` | static security analysis |
| `Build` | `.github/workflows/build.yml` | production build on Node.js 24, no hosting provider, no secrets |

Job names are the check names this checklist refers to; rename only together
with these docs.

**Code owners.** The owned areas are database migrations (including the RLS
helpers), roles, the Cordis runtime gate and plugin catalog, request
middleware, and CI workflows. The paths live in `.github/CODEOWNERS`, which is
the single list; `src/lib/__tests__/codeowners.test.ts` checks that each
pattern still matches a tracked file. Other changes may be merged by their
author once the checks pass.

**Outside contributions.** Squash-merged. Squashing does **not** waive the
signature or sign-off items: they apply to every commit on the pull request,
including ones from a fork. CLI contributors configure commit signing and use
`git commit -s`; GitHub web edits are signed by GitHub and carry the sign-off
only when the repository's web sign-off setting is on. A first-time
contributor's workflow runs wait for a maintainer to approve them; the
approving maintainer reads the diff first, especially anything under
`.github/workflows/`, before approving the run. Maintainers may merge their own
verified, signed-off commits with merge commits. For a commit that is unsigned
or lacks a sign-off, withhold the merge and ask for a correction.

**Hosting previews are informational.** A hosting-provider preview is not part
of the checklist, so a fork pull request never waits on a deployment
authorization that is not given. Keep Vercel Git Fork Protection enabled;
maintainers do not authorize hosting deployments for fork pull requests. Any
application preview uses isolated synthetic data. The `Build` job, not a
preview, is the production-build gate.

**Untrusted code gets no credentials.** The CI workflows run on the
`pull_request` event with `permissions: contents: read` and read no repository
secret (the CodeQL job also gets `security-events: write` to upload its
results, and `Test` gets `packages: read` to pull the Supabase images from
GHCR); never use `pull_request_target` to build or test fork code.

**Runtime versions.** `.nvmrc` pins Node.js 24 LTS. Each path is separate:

- **Vercel** uses `package.json` `engines.node` (`>=24 <25`) in place of the
  project's Node.js setting for builds and Functions. The project already
  builds on 24.x, so this line does not change the production runtime.
- **Container image** (`Dockerfile`): still `node:20-alpine`. Moving it to
  Node 24 is a follow-up PR, linked from #33 and covered by the container
  work in #51.
- **`Test`** and **`Build`**: Node.js 24 from `.nvmrc`.

The Cordis dependency is pinned exactly in `package.json` (currently
`4.0.0-rc.10`).

**Status.** The social contract has not yet been rehearsed with an outside
fork pull request (including the GitHub web-editor path). The rehearsal is
recorded on #33; until then treat the checklist as the agreed policy, applied
by hand.

## CI

The `Test` job starts a local Supabase with the CLI version pinned in
`package-lock.json`. It pulls service images from GHCR by setting
`SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io`, because the CLI default
(`public.ecr.aws`) rate-limits anonymous pulls from shared runners. See
`docs/adr/ADR-004-ci-supabase-image-source.md`. It logs in to GHCR with the job's read-only `GITHUB_TOKEN` (`packages: read`) first, because anonymous GHCR pulls are rate limited too. GHCR also throttles the CLI's parallel layer pulls, so the job restores the images from `actions/cache` (list in `.github/supabase-ci-images.txt`) and pre-pulls any missing one sequentially with short retries (GHCR, then the ECR mirror) before `supabase start`; refresh that list whenever the pinned CLI version changes (ADR-004, 22 Oct amendment).

## Where things are recorded

| Kind | Where |
|---|---|
| A rule every change must follow | `CLAUDE.md`, with the reason and what would make it wrong |
| A design decision | `docs/`, next to the area it governs (`entity-model.md`, `cordis-runtime.md`, …); cross-cutting decisions as an ADR in `docs/adr/` |
| An operational procedure | `docs/runbooks/` |
| Work in progress and status | GitHub issues and pull requests |
| An unfixed security weakness | A private security advisory on this repository — never an issue, PR, commit, comment, or test name |
| Strategy, pricing, customer information | Outside this public repository |

## Legacy references

MGM was forked from an earlier metering-and-billing project. Comments and
older migrations cite ticket numbers from that project's tracker (for
example `#101`, `#241`, `#321`), which is not available here. The text next
to each reference is the record; new work cites this repository's issues
and pull requests. Applied migrations are left unedited as history.

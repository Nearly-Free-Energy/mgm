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
5. **Review.** At least one reviewer reads the diff against the invariants
   above; protected areas need a code owner other than the author. For anything touching RLS, money, credentials, or the runtime, also
   run the change against a database (`npm test` with local Supabase).
6. **Deploy.** Apply database migrations before deploying the app. Follow
   the runbook for the area (`docs/runbooks/`, `docs/payments-rollout.md`,
   `docs/customerapp-activation.md`).

## Merge controls

This section is the policy; the `main` ruleset is its enforcement, applied by
a repository admin (the decision and its rationale are in
`docs/adr/ADR-002-ci-build-gate-and-merge-controls.md`). `CLAUDE.md` §
"Required Merge Controls" has the per-check detail and `CONTRIBUTING.md` is
the contributor-facing version. Keep the three in step.

**Required on `main`:** a pull request; the status checks `Test`, `CodeQL`,
and `Build`; verified commit signatures; DCO sign-off; force-push and branch
deletion blocked.

| Check | Workflow | Notes |
|---|---|---|
| `Test` | `.github/workflows/test.yml` | types, lint, database rehearsals, full suite against a local Supabase |
| `CodeQL` | `.github/workflows/codeql.yml` | static security analysis |
| `Build` | `.github/workflows/build.yml` | production build on Node.js 24, no hosting provider, no secrets |

Job names are the required-check contexts; renaming one silently un-requires it.

**Code owners.** Approval from a code owner other than the author is required
for database migrations (including the RLS helpers in `00002_rls.sql`),
`src/lib/roles.ts`, the Cordis runtime gate (`src/lib/runtime/`,
`src/lib/plugins/state.ts`), request middleware (`src/middleware.ts`,
`src/lib/mgm/released-routes.ts`), and `.github/workflows/`. The paths live in
`.github/CODEOWNERS`. Other changes may be merged by their author once the
required checks pass.

**Outside contributions.** Squash-merged. Squashing does **not** bypass the
signature or sign-off requirements: they apply to every commit on the pull
request, including ones from a fork. CLI contributors configure commit signing
and use `git commit -s`; GitHub web edits are signed by GitHub and carry the
sign-off when compulsory web sign-off is enabled. Maintainers may merge their
own signed commits with merge commits. There is no routine admin bypass.

**Hosting previews are informational.** A hosting-provider preview is never a
required check, so a fork pull request never waits on a deployment
authorization. Any application preview uses isolated synthetic data. The
`Build` job, not a preview, is the production-build gate.

**Untrusted code gets no credentials.** The CI workflows run on the
`pull_request` event with `permissions: contents: read` and read no repository
secret; never use `pull_request_target` to build or test fork code.

**Runtime versions.** CI and application builds target Node.js 24 LTS
(`.nvmrc`, `package.json` `engines`). The Cordis dependency is pinned exactly
in `package.json` (currently `4.0.0-rc.10`). The container image and the `Test`
job remain on Node.js 20 until a deliberate runtime change moves them.

**Status.** The ruleset has not yet been verified against a fork pull request.
Until it is rehearsed (signed and signed-off commits merge after checks and
review; unsigned or unsigned-off commits stay blocked, including via the
GitHub web editor), treat the controls above as the intended policy rather
than as proven behaviour.

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

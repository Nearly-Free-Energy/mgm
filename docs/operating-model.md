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
   `Test` and `CodeQL` checks and the Vercel preview must pass; see
   `CLAUDE.md` § "Required Merge Controls".
5. **Review.** At least one reviewer reads the diff against the invariants
   above. For anything touching RLS, money, credentials, or the runtime, also
   run the change against a database (`npm test` with local Supabase).
6. **Deploy.** Apply database migrations before deploying the app. Follow
   the runbook for the area (`docs/runbooks/`, `docs/payments-rollout.md`,
   `docs/customerapp-activation.md`).

## CI

The `Test` job starts a local Supabase with the CLI version pinned in
`package-lock.json`. It pulls service images from GHCR by setting
`SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io`, because the CLI default
(`public.ecr.aws`) rate-limits anonymous pulls from shared runners. See
`docs/adr/ADR-004-ci-supabase-image-source.md`. It logs in to GHCR with the job's read-only `GITHUB_TOKEN` (`packages: read`) first, because anonymous GHCR pulls are rate limited too. GHCR also throttles the CLI's parallel layer pulls, so the job restores the images from `actions/cache` (list in `.github/supabase-ci-images.txt`) and pre-pulls any missing one sequentially with short retries (GHCR, then the ECR mirror) before `supabase start`; refresh that list whenever the pinned CLI version changes (ADR-004, 22 Oct amendment).

## Security fixes

A fix for a security weakness that is not yet public (reported privately or
found by a maintainer) replaces steps 1 and 4 of "How work moves" with the
sequence in `SECURITY.md`. It starts from a draft security advisory, not an
issue, and is developed and reviewed in the advisory's temporary private
fork. GitHub runs no CI or status checks on pull requests there, so the
checks are run by hand:

- A change to an area that needs another maintainer's review as an ordinary
  pull request, such as database migrations, RLS helpers, or CI workflows,
  needs that maintainer's approval in the advisory before it merges.
- Immediately before merging, the maintainer who merges reviews the full
  diff of every open pull request in the private fork at its current head.
  On exactly those commits with current `main` merged in, they run every
  step of every job that `.github/workflows/` runs on pull requests to
  `main`, except CodeQL, in order and with the Node.js version and
  environment variables that job sets, plus any release build checks. That
  is more than `npm test`: the `Test` job also runs database rehearsals and
  script tests against its local Supabase. They use a disposable local
  environment with synthetic data on a machine they control, and record the
  tested commit and the results privately. This step defers to the workflow
  files so that it changes when they do; if a pull-request check ever runs
  outside `.github/workflows/`, add it here.
- They confirm every commit is signed and signed off, and do not merge if
  any head has moved since the review.
- CodeQL is a deliberate exception to the merge controls, which otherwise
  require it to pass before merging: it cannot run in the private fork. It
  runs on `main` after the merge, and the maintainer who merged checks its
  result on the merge commit before the patch release is published.

The patch release and the draft advisory are prepared before the merge.
After it, the patch release is published and its artifacts are verified
usable before the advisory is published; if that fails, the advisory stays
in draft until the release is repaired and verified again. No installation
is upgraded ahead of the release. Before 0.1.0 there is no patch release: the
merged commit on `main` takes its place, as `SECURITY.md` describes.

## Where things are recorded

| Kind | Where |
|---|---|
| A rule every change must follow | `CLAUDE.md`, with the reason and what would make it wrong |
| A design decision | `docs/`, next to the area it governs (`entity-model.md`, `cordis-runtime.md`, …) |
| An operational procedure | `docs/runbooks/` |
| Work in progress and status | GitHub issues and pull requests |
| A security weakness whose advisory is not yet published | A private security advisory on this repository (`SECURITY.md`) — never an issue, PR, commit, comment, or test name |
| Strategy, pricing, customer information | Outside this public repository |

## Legacy references

MGM was forked from an earlier metering-and-billing project. Comments and
older migrations cite ticket numbers from that project's tracker (for
example `#101`, `#241`, `#321`), which is not available here. The text next
to each reference is the record; new work cites this repository's issues
and pull requests. Applied migrations are left unedited as history.

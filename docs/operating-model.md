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

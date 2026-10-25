# ADR-003: Request-time public runtime configuration

## Status: Accepted; amended 2026-10-24 (see "Amendment, 2026-10-24" below)

## Context

MGM is to ship as an installable release on two paths: Vercel and a published
container image, each against the operator's own Supabase project (RFC #30,
section 3). The container acceptance criterion requires one immutable image
digest to serve independent installations without rebuilding or rewriting
bundled JavaScript.

Until now the Supabase URL, anon key and cookie name were `NEXT_PUBLIC_*`
variables. Next.js inlines those into the browser bundle (and server code) at
build time, so the Dockerfile took them as build arguments and every
installation needed its own image. The payment origin had the same problem:
payment links, the provider return URL and the payment notification (IPN)
registration read `NEXT_PUBLIC_APP_URL` or `NEXT_PUBLIC_PAYMENT_CALLBACK_URL`,
and one path fell back to a hard-coded localhost URL.

Constraints: privileged values (service-role key, credential encryption key,
provider credentials) must never be serialized to the browser; a response
carrying one installation's configuration must never be prerendered or shared
from a cache; missing settings must fail clearly without logging secrets; and
existing installations must keep working until they adopt the release.
Organization isolation, Cordis write gates, provider-neutral billing and
human-only period close are unaffected and must stay so.

## Decision

1. **Allowlisted public configuration, read per request.** The server reads
   `MGM_PUBLIC_SUPABASE_URL`, `MGM_PUBLIC_SUPABASE_ANON_KEY` and optional
   `MGM_PUBLIC_SUPABASE_COOKIE_NAME` (no `NEXT_PUBLIC_` prefix, so never
   inlined) and validates them in `src/lib/config/public-runtime-config.ts`:
   absolute http(s) URL without credentials, query or fragment; a key that is
   either `sb_publishable_…` or a JWT whose role is `anon` (everything else is
   refused); a restricted cookie-name character set. Errors name the
   variable, never the value.
2. **Root layout as the request-time boundary.** `src/app/layout.tsx` calls
   `connection()` and is `force-dynamic`, then passes only the three public
   values to `PublicRuntimeConfigProvider`. The provider re-picks the
   allowlisted fields and records them for the browser client factories
   (`src/lib/supabase/client.ts`, `recovery-client.ts`), which no longer read
   `process.env`. *(Amended 2026-10-24: the guard on what reaches the page is
   the layout and its test, not the provider; see below.)*
3. **One configuration for server, middleware and browser.** The server
   client, the session middleware and the service-role client use the same
   validated values and cookie name. `SUPABASE_INTERNAL_URL` remains a
   server-only connection override and never enters the public config.
   Because `@supabase/ssr` derives its default cookie name from the URL it is
   given, an internal URL on a different host than the public URL requires
   `MGM_PUBLIC_SUPABASE_COOKIE_NAME`; the configuration is refused otherwise.
   The middleware runs on the Node.js runtime (`runtime: "nodejs"` in
   `src/middleware.ts`), so it reads the real process environment like the
   rest of the server.
4. **Server-only `MGM_APP_URL`.** The installation's public origin, validated
   as an https origin (http only for localhost, 127.0.0.1 and [::1]), read per call by
   `src/lib/config/app-url.ts`, and used for payment links,
   `/payment/callback` and `/api/payments/ipn` registration. It is never sent
   to the browser. The localhost fallback is removed. `src/instrumentation.ts`
   validates it, and the Supabase settings, at server start (skipped during
   `next build`). An invalid Supabase setting rejects `register()`, so every
   request fails with 500 while the process keeps running; an invalid
   `MGM_APP_URL` is logged and payments fail closed. No `process.exit()`
   (it would break Vercel).
5. **No deployment build arguments.** The Dockerfile drops the
   `NEXT_PUBLIC_SUPABASE_*` arguments; Compose and `setup.sh` write the new
   names as runtime environment.
6. **One-release compatibility.** When neither new Supabase name is set, the
   old `NEXT_PUBLIC_SUPABASE_*` names are read as a complete set (never mixed
   with new names) with a deprecation warning at server start and on first use in each server
   bundle; `MGM_APP_URL` falls
   back to `NEXT_PUBLIC_APP_URL`, then the origin of
   `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` (with a startup warning naming the old
   variable); the payment return URL keeps the full
   legacy `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` exactly. A legacy cookie name next
   to new Supabase names is refused rather than silently ignored. The
   fallback is removed in the next release. This was chosen over a hard cut because it lets an existing
   Vercel installation take the release before renaming its variables.
   *(Ended 2026-10-24: v0.0.1 and v0.0.2 were the compatibility releases;
   later releases no longer read the old names. See below.)*

## Consequences

Better:

- One build or image serves any installation; configuration changes need a
  restart or redeploy of settings, not a rebuild.
- The set of values that reaches the browser is explicit, typed and tested;
  a misconfigured service-role key is refused instead of published.
- Payment URLs and notification registration follow the installation they run
  in, and a missing origin fails instead of pointing payers at localhost.

Worse, or to watch:

- Every page is rendered per request. The layout already read request headers,
  so this formalises existing behaviour, but static optimisation of pages is
  not available.
- The browser configuration is held in a module-level store written during the
  provider's render so that factory functions called from event handlers can
  reach it. This is correct only because each server process serves one
  installation; multi-tenant hosting in one process would need a
  request-scoped store. A browser client created outside the root layout's tree fails with
  a clear error rather than using a stale value.
- During the compatibility release the legacy `NEXT_PUBLIC_*` names are read
  through an alias of `process.env` (`readEnv()` in both config modules), so
  Next.js does not inline build-time values into server, middleware or
  instrumentation bundles. If Next starts tracing aliases of `process.env`,
  revisit; verify by grepping `.next/server` after a build with the old names
  set. *(Corrected 2026-10-24: see below.)*
- The session middleware moves from the Edge runtime to Node.js. Node.js
  middleware is supported for `middleware.ts` by the installed Next.js 16;
  renaming to `proxy.ts` (Node.js only) is a later mechanical change.
  *(Corrected 2026-10-24: it is more than a rename; see below.)*
  Container verification (tracked separately under RFC #30) still confirms
  two distinct configurations on one image digest.
- The database test helpers read `MGM_PUBLIC_SUPABASE_ANON_KEY`, falling back
  to `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`testAnonKey()` in `rls.helpers.ts`)
  because CI still exports the old name; renaming that export is a follow-up
  (with #67). `setup.sh` must not write the old name back: Next.js would
  build its value into the bundles again. *(Done 2026-10-24: see below.)*

## Amendment, 2026-10-24: the compatibility window ends (#79)

v0.0.1 and v0.0.2 were the compatibility releases of decision 6, and the
installations running them have moved to the `MGM_*` names. So the
follow-ups from the review of #64 land together with the removal of the
fallback:

1. **The old names are no longer read.** MGM reads only
   `MGM_PUBLIC_SUPABASE_URL`, `MGM_PUBLIC_SUPABASE_ANON_KEY`, the optional
   `MGM_PUBLIC_SUPABASE_COOKIE_NAME` and `MGM_APP_URL`.
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `NEXT_PUBLIC_SUPABASE_COOKIE_NAME`, `NEXT_PUBLIC_APP_URL` and
   `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` configure nothing. The payment return
   URL is always the `MGM_APP_URL` origin plus `/payment/callback`; a custom
   callback path is not carried over. Missing or invalid `MGM_*` values fail
   exactly as in decision 4. The rules that only existed because two sets
   could be mixed (the set selection, refusing a cookie name from the other
   set) are gone with it.
2. **A forgotten rename is named, not guessed at.** Silently ignoring an old
   name would leave an operator with only "Missing required runtime
   configuration: MGM_…". So at server start (`src/instrumentation.ts`,
   `src/lib/config/retired-names.ts`) MGM logs one warning for each old name
   that is set while its replacement is not, naming both variables and never
   the value. An old name set next to its replacement is ignored silently.
   The warning checks only whether the variable is set, through a
   non-literal key (`env[name]`): Next.js replaces literal
   `process.env.NEXT_PUBLIC_*` reads with build-time values in server bundles
   too, so a literal read would report the build machine's variables in every
   installation. What keeps build-time values out is the non-literal key,
   not the `process.env` alias the original text credits. If Next.js starts
   inlining computed `process.env` reads, revisit.
3. **The config modules are `server-only`.** `public-runtime-config.ts`,
   `app-url.ts` and `retired-names.ts` import `server-only`. Next.js builds
   the middleware and instrumentation as server code, so this fails
   `next build` only for a client import (the module comment that said the
   middleware bundle ruled it out was wrong). Browser code imports the
   `PublicRuntimeConfig` type alone.
4. **Guard test.** `src/lib/__tests__/no-browser-env-config.test.ts` fails
   when any source file reads an old name from `process.env`, when a file
   other than the two config modules reads the current settings from it, or
   when a browser file ("use client" or a browser client factory) names a
   setting or imports a value from a config module.
5. **What guards the page payload (decision 2).** The provider's re-pick runs
   after Next.js has serialized the layout's props into the page, so it
   protects only the context value and the browser store. The guard on what
   reaches the page is the root layout passing the fresh three-field object
   that `parsePublicRuntimeConfig` returns, checked by
   `src/app/__tests__/root-layout.test.tsx`.
6. **`proxy.ts` is more than a rename.** Next.js 16 fails `next build` on any
   route segment config in a Proxy file ("Route segment config is not allowed
   in Proxy file"). Moving to `proxy.ts` therefore also means deleting
   `runtime: "nodejs"` from the middleware's `config` and the
   `config.runtime` assertion in `src/lib/__tests__/middleware.test.ts`.
7. **CI and the build.** The `Build` check runs `next build` with no Supabase
   or application-URL variables (the placeholders are removed). The `Test`
   check exports the local anon key as `MGM_PUBLIC_SUPABASE_ANON_KEY`, and
   `testAnonKey()` reads only that name. The release build keeps refusing to
   run with any `NEXT_PUBLIC_*` variable set.

Upgrade steps are in `docs/setup.md`, "Upgrading from v0.0.1 or v0.0.2".

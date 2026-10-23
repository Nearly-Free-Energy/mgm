# ADR-003: Request-time public runtime configuration

## Status: Accepted

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
   `process.env`.
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
   as an https origin (http only for localhost/127.0.0.1), read per call by
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
   with new names) with a one-time deprecation warning; `MGM_APP_URL` falls
   back to `NEXT_PUBLIC_APP_URL`, then the origin of
   `NEXT_PUBLIC_PAYMENT_CALLBACK_URL`; the payment return URL keeps the full
   legacy `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` exactly. A legacy cookie name next
   to new Supabase names is refused rather than silently ignored. The
   fallback is removed in the next release. This was chosen over a hard cut because it lets an existing
   Vercel installation take the release before renaming its variables.

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
- During the compatibility release a legacy `NEXT_PUBLIC_*` value present at
  build time can still be inlined into server code by Next.js. Only the new
  names are guaranteed request-time; operators should rename before the
  fallback is removed.
- The session middleware moves from the Edge runtime to Node.js. Node.js
  middleware is supported for `middleware.ts` by the installed Next.js 16;
  renaming to `proxy.ts` (Node.js only) is a later mechanical change.
  Container verification (tracked separately under RFC #30) still confirms
  two distinct configurations on one image digest.
- The database test harness still reads `NEXT_PUBLIC_SUPABASE_ANON_KEY` as a
  test-only variable; renaming it touches the CI workflow and is left to a
  follow-up.

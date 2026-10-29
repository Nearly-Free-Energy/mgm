# ADR-001: Cordis as MGM's in-process runtime, with conditions

## Status: Proposed (draft for review by Aaron and Hillary)

## Context
MGM is built as capabilities (community management, metering, billing, billing review, payments) that must be enabled per organization, run in isolation per request, and never leak between organizations. Aaron's PR #23 runs them on one Cordis runtime per process, with an isolated child scope per API call and a per-organization plugin gate that fails closed. An independent review of #23 found no cross-organization path and no scope-lifetime break (one P2 on a route the new test wrongly counted as gated, fixed in #29, and four P3). Release 2 (OpenEMS metering as a plugin, issue #4) is the first feature that depends on the plugin model, so we need a firm position before building on it.

Facts that shape the decision:
- Cordis is a context-based plugin framework with dependency injection, scoped services and lifecycle cleanup. MGM pins `cordis` at exactly `4.0.0-rc.12` (since #81), a release candidate.
- Cordis has had stable majors since 2022 (the last is 3.18.1, September 2024), and upstream publishes the 4.0 release candidates as npm `latest`. No 4.0.0 has shipped yet. The risk is change between candidates: rc.11 moved `ctx.root`, and rc.11 and rc.12 fixed three disposal bugs that MGM's request scopes depend on.
- The community is small and the project is maintained by a few people, so the bus factor is low. Other projects have vendored it, which shows use but is not a guarantee of support.
- A scope that is never disposed lives as long as the process and can hold a caller's database client.

## Decision
Adopt Cordis as MGM's in-process capability runtime, inside MGM's own boundary, under these conditions:

1. **Boundary.** Route handlers (`src/app/`), database code (`src/lib/supabase/`) and each capability's domain files (`capability.ts`, `repository.ts`, `types.ts`) never import Cordis. Only the runtime (`src/lib/runtime/`, `src/lib/cordis/`) and each capability's wiring (`compose.ts`, `scope.ts`, plugin files) do. The `compose*` functions and `gateRoute()`/`checkGate()` are the contract; replacing Cordis means rewriting what is behind them. The capabilities' import-boundary tests enforce the domain-file rule, and a matching test should enforce it for `src/app/`.
2. **Pin and track.** Keep `cordis` pinned exactly (now `4.0.0-rc.12`, #81). Every bump re-runs the full suite, including the `rls` project and the runtime scope tests in `src/lib/runtime/__tests__/` that assert the Cordis behaviour the request scopes rely on. Move to 4.0.0 when it ships, under the same tests. Revisit this ADR, and choose between staying pinned, vendoring Cordis, or replacing the runtime behind the boundary, if any of these happens: upstream publishes no release for six months; a bump breaks behaviour MGM relies on and the fix can't stay behind the boundary; or a security fix ships only in a version we can't adopt.
3. **Fail closed, everywhere.** A gate or plugin-state read that fails blocks writes. Every route that writes or calls OpenEMS or payments with stored credentials is gated or goes through a composer that enforces plugin state.
4. **Disposal is enforced, not remembered.** A static test requires every scope opened by a composer to be disposed in a `finally`, and one concurrency test uses the real composers.
5. **Database gate tests run in CI.** The row-level-security and gate database tests run against a local Supabase in CI, so a skipped project cannot hide a regression.
6. **No secrets in platform plugins.** Platform plugins hold no request data, credentials or database clients; provider factories receive the caller's row-level-security client.
7. **Scope of use.** Cordis stays inside MGM. It is not adopted in the logger, the gateway or the OpenEMS fork.

### Conditions already met

| Item | Met by |
|---|---|
| 3. Fail closed | #29: composers return `503` when plugin state can't be read, and `regenerate-preview` is gated |
| 4. Disposal enforced | #29: `scope-dispose.test.ts` and `compose-concurrency.test.ts` |
| 5. Database tests in CI | 30e23d9 (31 Jul): the database-backed suites run in the `Test` gate |
| 6. No secrets in platform plugins | #23 |
| Watch: GET routes that call OpenEMS | #23: `EXTERNAL_GETS` in `route-surface.test.ts` |

Still open: the `src/app/` import-boundary test (condition 1). Conditions 2 and 7 are ongoing practice.

## Consequences
- Better: per-organization isolation by construction, adding a metering or payment provider is a new plugin, and disabling a plugin keeps data.
- Worse: a pre-release dependency, extra concepts for new contributors, and per-request scope setup cost (measure p95 on Vercel before Release 2 goes live).
- Watch: leaks from undisposed scopes, upstream release cadence (the longest gap so far was 296 days, 4.0.0-beta.5 to beta.6; 62 days across the release candidates), and gate gaps on new routes.
- Accepting this with rc.12 named also answers the "Cordis 0.1 decision" that #30 sends to #56.
- Revisit this ADR at Release 2 sign-off, when Cordis 4.0.0 ships, or when a condition 2 trigger fires.

# ADR-001: Cordis as MGM's in-process runtime, with conditions

## Status: Proposed (draft for review by Aaron and Hillary)

## Context
MGM is built as capabilities (community management, metering, billing, billing review, payments) that must be enabled per organization, run in isolation per request, and never leak between organizations. Aaron's PR #23 runs them on one Cordis runtime per process, with an isolated child scope per API call and a per-organization plugin gate that fails closed. An independent review of #23 found no cross-organization path and no scope-lifetime break (one P2 on a route the new test wrongly counts as gated, four P3). Release 2 (OpenEMS metering as a plugin, issue #4) is the first feature that depends on the plugin model, so we need a firm position before building on it.

Facts that shape the decision:
- Cordis is a context-based plugin framework with dependency injection, scoped services and lifecycle cleanup. MGM pins `cordis` at exactly `4.0.0-rc.10`, a release candidate.
- The community is small and the project is maintained by a few people, so the bus factor is low. Other projects have vendored it, which shows use but is not a guarantee of support.
- A scope that is never disposed now lives as long as the process and can hold a caller's database client.

## Decision
Adopt Cordis as MGM's in-process capability runtime, inside MGM's own boundary, under these conditions:

1. **Boundary.** Cordis is used only under `src/lib/runtime/` and `src/lib/cordis/`. Route handlers, database code and the public API never import Cordis types. The five composers and `gateRoute()` are the contract; replacing Cordis means rewriting what is behind them.
2. **Pin and track.** Keep the exact version pinned. Move to a stable 4.x when it ships, and re-run the full test suite on every bump, including the `rls` database project and the runtime scope tests in `src/lib/runtime/__tests__/` that assert the Cordis behaviour the request scopes rely on (as mgm#81 did for rc.12). If no stable 4.x appears within six months or upstream maintenance stops, replace the runtime behind the boundary (the composers stay).
3. **Fail closed, everywhere.** A gate or plugin-state read that fails blocks writes. Every route that writes or calls OpenEMS or payments with stored credentials is gated or goes through a composer that enforces plugin state. Fix the review's P2 (`regenerate-preview`) before merging #23.
4. **Disposal is enforced, not remembered.** A static test requires every scope opened by a composer to be disposed in a `finally`, and one concurrency test uses the real composers.
5. **Database gate tests run in CI.** The row-level-security and gate database tests run against a local Supabase in CI, so a skipped project cannot hide a regression.
6. **No secrets in platform plugins.** Platform plugins hold no request data, credentials or database clients; provider factories receive the caller's row-level-security client (already true in #23).
7. **Scope of use.** Cordis stays inside MGM. It is not adopted in the logger, the gateway or the OpenEMS fork.

## Consequences
- Better: per-organization isolation by construction, adding a metering or payment provider is a new plugin, and disabling a plugin keeps data.
- Worse: a pre-release dependency, extra concepts for new contributors, and per-request scope setup cost (measure p95 on Vercel before Release 2 goes live).
- Watch: leaks from undisposed scopes, upstream maintenance, and gate gaps on new routes (the surface test must also cover GET routes that call OpenEMS).
- Revisit this ADR at Release 2 sign-off and when Cordis 4 ships stable.

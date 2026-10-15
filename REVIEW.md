# REVIEW.md

**Security findings.** This repository is public. If a finding is an exploitable weakness in code that is already merged (for example a gate bypass or an RLS gap on main), do not describe the exploit in a PR comment; say only that a private security advisory is needed (see `AGENTS.md`).

Rules for reviewing pull requests in this repository. Read `CLAUDE.md` first. This repository is public: flag any customer name, phone number, email address, meter serial tied to a person, or money amount in code, tests, docs, comments or PR text.

## Always flag (blocking)
- **Tenancy and the plugin gate.** Every route that writes, or that calls OpenEMS or payments with stored credentials (including GET), must go through a composer that enforces plugin state or call `gateRoute()` and return its result. Gate failures fail closed. Check that nothing is cached without every key (organization, plugin, user).
- **Scope lifetime.** Every scope opened by a composer is disposed in a `finally`. Route handlers and UI code never import Cordis; runtime wiring and plugin definitions stay in the runtime and plugin directories named in `CLAUDE.md` (see ADR-001 once merged).
- **Billing correctness.** Tariff pinning, close-period audit and idempotency must not change silently. A closed period is never re-priced. Bill total = (tier charges + service charge) x 1.18, i.e. VAT-inclusive (18% VAT); a household with readings in the period must never be dropped from a bill.
- **Row-level security.** New tables and views have RLS and tests. Service-role access in request paths is allowed only where `CLAUDE.md` documents the structural reason (for example unauthenticated provider callbacks); flag any other use.
- **Behaviour change without a test.** Error codes and statuses of existing routes stay the same unless the PR says otherwise.

## Also check
- Migrations are forward-only, reviewed for locks, and ordered correctly.
- New routes are listed with an owner in the plugin catalog (`src/lib/plugins/bundled.ts`) so `route-surface.test.ts` passes.
- Database tests (RLS, gate) ran in CI, not skipped.

## Skip
- Style nits and naming taste. (Comment wording is only a finding where `CLAUDE.md` prescribes it, such as service-role exemptions.)

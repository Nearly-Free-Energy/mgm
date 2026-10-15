# REVIEW.md

Rules for reviewing pull requests in this repository. Read `CLAUDE.md` first. This repository is public: flag any customer name, phone number, email address, meter serial tied to a person, or money amount in code, tests, docs, comments or PR text.

## Always flag (blocking)
- **Tenancy and the plugin gate.** Every route that writes, or that calls OpenEMS or payments with stored credentials (including GET), must go through a composer that enforces plugin state or call `gateRoute()` and return its result. Gate failures fail closed. Check that nothing is cached without every key (organization, plugin, user).
- **Scope lifetime.** Every scope opened by a composer is disposed in a `finally`. No Cordis types outside `src/lib/runtime/` and `src/lib/cordis/` (see ADR-001).
- **Billing correctness.** Tariff pinning, close-period audit and idempotency must not change silently. A closed period is never re-priced. Bill total = (tier charges + service charge) x VAT; a household with readings in the period must never be dropped from a bill.
- **Row-level security.** New tables and views have RLS and tests; service-role access is not used from request paths.
- **Behaviour change without a test.** Error codes and statuses of existing routes stay the same unless the PR says otherwise.

## Also check
- Migrations are forward-only, reviewed for locks, and ordered correctly.
- The route inventory and plugin catalog list new routes with an owner.
- Database tests (RLS, gate) ran in CI, not skipped.

## Skip
- Style nits, naming taste, comment wording.

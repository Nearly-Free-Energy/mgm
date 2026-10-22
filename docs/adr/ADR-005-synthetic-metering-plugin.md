# ADR-005: Synthetic metering plugin

## Status: Accepted

## Context

Operators evaluating MGM need a meaningful sample bill without physical meters
or an OpenEMS account (issue #44, launch tracker #30). A repository fixture
provider (`FixtureMeteringProvider`) already exists for tests. Demonstration
data must be obviously fake, reproducible, selected explicitly, and must not
weaken organization isolation, the Cordis write gates, provider-neutral
billing or human-only period close.

## Decision

- **Provider.** `synthetic-metering` is a platform plugin shaped exactly like
  `openems-metering`: it registers a `synthetic` factory in the root
  `meteringProviders` registry with a `supports()` selector. It builds on
  `FixtureMeteringProvider` (generated fixtures served by the existing fixture
  path) rather than duplicating it. Billing is unchanged and sees only
  `MeteringProvider`.
- **Deterministic generator.** Readings are a pure function of (seed, meter,
  day). Missing data is `null`, never zero: a missing opening or closing
  reading yields `null`; interior gaps do not hide consumption because meters
  are cumulative registers. No readings are stored.
- **Explicit selection, two keys.** The provider answers only for a microgrid
  holding a `SYNTHETIC-EDGE-*` edge, and only when the organization enabled
  the plugin; both are read through the caller's RLS-scoped client. A
  synthetic microgrid with the plugin off fails closed (409), never falling
  back to OpenEMS. The provider also refuses any device without
  `SYNTHETIC-` identifiers, so it cannot fabricate usage for a real meter.
- **Off by default (the one schema change).** Every bundled plugin treats a
  missing `mgm_plugins` row as enabled. A demonstration plugin must not. A new
  migration (`20261022090000_synthetic_metering_plugin.sql`) whitelists the
  plugin name in the existing CHECK constraints and
  `fn_mgm_set_plugin_enabled` (required for any new bundled plugin) and makes
  `mgm_plugin_enabled_for_org` return false for a missing
  `synthetic-metering` row. The catalog gains an optional `defaultEnabled`
  flag mirroring this. No table is created or altered; other plugins behave
  as before.
- **Dataset is not a migration.** `supabase/scripts/load-synthetic-demo.sql`
  creates a demonstration community, microgrid, edge, 8 meters and 8
  households in one named organization, only when run by an operator with an
  explicit confirmation flag. It is separate from migrations and from
  operator-specific provisioning, and stores no readings.

## Consequences

- Better: an evaluator can produce a reproducible sample bill with no
  external credentials, including missing-data cases.
- Better: no new architecture, routes or tables; the plugin owns none, so the
  route-surface gate is unaffected.
- Worse: the plugin name list is duplicated in SQL and in `bundled.ts`, as for
  every plugin; the default-off rule is now in both places and must stay in
  step (covered by a unit test on the TypeScript side).
- Watch: a synthetic microgrid is selected ahead of the OpenEMS fallback, so
  keep demonstration data in its own microgrid. Do not freeze future metering
  plugin ownership boundaries on this design.
- No Structurizr DSL exists in this repository, so none was updated.

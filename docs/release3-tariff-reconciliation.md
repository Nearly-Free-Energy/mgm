# Release 3 tariff migration and historical periods

The MGM pilot Supabase project had **zero billing periods and zero billed
periods** when checked on 2026-09-29, before this migration was deployed.
Other installations may contain billed periods from the older schema.

The migration does not guess the tariff for a billed or closed period. Older
tariff rows could have been edited in place, so the newest row is not evidence
of the original rate. Their bill and audit records remain in the database,
but the period page, PDF/CSV, and regeneration return an explicit
reconciliation error until a verified tariff version is pinned.

For each affected period, an operator should compare the original invoice or
MBE source and line-item calculations against the historical tariff. If the
matching version no longer exists, reconstruct it as a new `rate_schedules`
row and independently verify the figures. Then use the privileged SQL template
in [`supabase/scripts/reconcile-historical-period-tariff.sql`](../supabase/scripts/reconcile-historical-period-tariff.sql)
with the period UUID, verified schedule UUID, and a review/ticket reference.
It validates microgrid ownership, pins once, and appends a
`tariff_reconciled` audit event. Run it through a database-owner connection,
not the application or Data API. A normal manager cannot pin billed history.

An empty draft can move to a new tariff version. Preview and write call
`fn_pin_billing_period_rate_schedule`, which locks the period, selects the
latest schedule, and updates the pin only before any line item is written.
After the first bill, and after closure, the pin is immutable. The period
page, PDF, and CSV read only that pinned version.

Generation passes the selected tariff ID to the bill-write RPC. That RPC
locks the period and rejects a stale calculation before writing a line item
if another request re-pinned the empty draft in the meantime.

Release 3's create/close RPCs are granted to `authenticated` but use
`user_can_access_microgrid`, whose current definition allows only a
`super_admin` or an `org_manager` for the microgrid's organization. The RLS
policies on the period and audit tables apply inside these invoker functions.
Any future microgrid-scoped role must explicitly revisit this authorization
contract before being added to that helper.

# Entity model

How MGM's data is shaped, and why. The schema itself is the source of
truth (`supabase/migrations/`, typed in `src/lib/types/database.gen.ts`);
this page records the reasoning that the schema cannot.

## Hierarchy

```
Organization ─▶ Community ─▶ Microgrid ─▶ Edge ─▶ Device
                              │
                              └▶ Tenant ─▶ tenant_devices (M:N to Device, effective-dated)
                                     └▶ user_roles tenant rows (people who sign in to its data)
```

- **Organization** — the operator business (a microgrid entrepreneur or
  developer). It is the unit of access control, plugin enablement, payment
  merchant accounts, and API tokens.
- **Community** — a place an organization serves. Invoice branding and the
  payment-account override live here.
- **Microgrid** — one electrical system with its own currency, timezone,
  tariff, billing periods, and OpenEMS backend connection. All edges under a
  microgrid share one OpenEMS backend.
- **Edge** — one OpenEMS Edge (gateway) registered from the backend's Discover
  list.
- **Device** — a component on an edge. `device_type` mirrors OpenEMS's
  component model; `consumption_meter` is the billable kind.
- **Tenant** — a customer of the microgrid. A tenant is linked to its
  meters through `tenant_devices`, whose assignments carry
  `effective_from` (inclusive) and `effective_to` (exclusive, `NULL` = current),
  so a period is billed against the meter that was actually connected.

Addresses live at organization, community, and microgrid level, and
optionally on a tenant. `microgrids` uses structured address columns
(`address_city`, `address_region`, `address_country`, `lat`, `lng`).

## Naming

A tenant is a customer the microgrid bills: a family, a shop, or an
institution. MGM uses the word in that sense only. The operator business is
an organization, never a tenant, even where hosting vocabulary would say
"multi-tenant".

Tenants were called households until
`20261116230000_rename_households_to_tenants.sql` renamed the tables
(`households`, `household_devices`, `household_users`), the `household_id`
columns, and the functions and messages that used the word. Migrations
applied before that file use the old name, and bills generated before it keep
`household_name` in their audit details. `tenant_users` (formerly
`household_users`) was never written and was dropped by
`20261118100100_tenant_role_access.sql`; tenant access is a role row (see
"Roles").

## Why this shape

- **Access follows the organization.** Every Row Level Security policy
  resolves a row up the chain to its organization (`user_can_access_org`,
  `user_can_access_microgrid`). Keeping one owner per row makes that chain
  unambiguous and keeps policies simple. See `CLAUDE.md` § "RLS helper
  functions" before touching them.
- **Configuration is per microgrid.** OpenEMS connections, tariffs, currency,
  and timezone differ between sites of the same organization, so they live on
  the microgrid, never on a global default.
- **Devices generalize meters.** Generation, storage, and grid meters are
  recorded alongside consumption meters so the same model serves monitoring
  and billing; only consumption meters are billed.
- **Meter assignments are dated, not overwritten.** Meters get swapped. Dated
  assignments let a closed period be reproduced exactly and let billing refuse
  overlapping or missing assignments.

## Roles

`user_roles` holds `(user_id, role, scope_type, scope_id)` rows, and a user
may hold several. Three roles ship:

- `super_admin` — staff, all organizations (`scope_type = 'org'`,
  `scope_id` NULL);
- `org_manager` — staff, one organization (`scope_type = 'org'`);
- `tenant` — someone who rents a unit, one row per unit
  (`scope_type = 'tenant'`, `scope_id` = `tenants.id`). It is not staff: a
  tenant reads their own tenant row, its meter assignments and those meters,
  and nothing else (`CLAUDE.md` § "RLS helper functions").

`user_roles_role_scope_type_consistent` pins each role to its scope type and
rejects any role it does not list. A manager who also rents holds a staff row
and a tenant row, so "has a role row" no longer means "is staff": a staff
check filters on the staff roles or the org scope. Further roles —
`microgrid_manager`, `community_admin`, `region_admin` — are future
extensions by enum addition; before adding one, read `CLAUDE.md` on why a
scoped configuration role was added and then removed.

## Decision: tenant access

Decided 17 November 2026 (RFC mgm#197, decisions 1 and 2). The people on a
tenant's account are **Supabase Auth users** who sign in by email link at the
same deployment, as staff do. A signed, single-purpose link without a login
(the other option considered, as the payment link `/p/<slug>` works) suits a
receipt, but not a month of daily use someone returns to, and it cannot carry
bills or payment later.

Their access is a `user_roles` row with `role = 'tenant'` and
`scope_type = 'tenant'`, not a separate join table, so sign-in, the layout and
the host read one table. `tenant_users`, which had been reserved for this,
was dropped (`20261118100100_tenant_role_access.sql`).

- Organization managers give and remove access from the tenant record
  (`fn_tenant_access_grant`, `fn_tenant_access_revoke`,
  `fn_tenant_access_list`); tenants never register themselves and never appear
  on the Users page, also after their access ends (`tenant_access_accounts`
  remembers who has been a tenant). Matching on `tenants.primary_email` would
  turn a contact field into a credential, so access is always granted
  explicitly. The grant is made by the access route with the service role, on
  the manager's behalf, for the account of the address the manager typed; no
  signed-in caller names an account by id.
- A tenant role row is removed with its tenant: `user_roles.scope_tenant_id`
  references `tenants` with `ON DELETE CASCADE`.
- Tenants read no microgrid, edge, community or organization row. The few
  microgrid fields their pages need come from `fn_tenant_home`.

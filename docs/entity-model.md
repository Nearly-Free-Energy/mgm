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
- `tenant` — someone who rents a unit, one row per unit, as many units as
  they rent, in any organizations (`scope_type = 'tenant'`, `scope_id` =
  `tenants.id`). It is not staff: a tenant reads their own tenant rows,
  their meter assignments and those meters, and nothing else (`CLAUDE.md`
  § "RLS helper functions").

Staff is not a role (`user_role` has no `staff` value): it means holding a
`user_roles` row whose role is not `tenant` (`super_admin`, `org_manager`, or
the inert `ems_operator`), now. `staff_access_accounts` records history: the
accounts that have ever held such a row. `src/lib/roles.ts` holds the
definition.

`user_roles_role_scope_type_consistent` pins each role to its scope type and
rejects any role it does not list. A tenant who is later made staff holds a
tenant row and a staff row (and a manager who rents may be given tenant
access on the same address, below), so "has a role row" no longer means "is
staff": a staff check filters on the staff roles or the org scope. Further
roles —
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
  signed-in caller names an account by id. Tenant access does not depend on
  organization roles: the grant looks only at the manager's authority, the
  unit and the account, so a manager who rents may be given the unit on the
  same address, and a person may rent several units, each with its own
  meters, in different organizations.
- The Users page never touches tenant rows. Removing someone's staff access
  there leaves the units they rent. Inviting an address whose only rows
  are tenant rows is a role change, so only a super admin's invitation
  makes it staff, through `fn_change_user_role`, which keeps the tenant
  rows; an org manager gets the answer any account with other access gets
  and nothing is written, so no answer tells them that the address is a
  tenant's. The invite route never calls `fn_finalize_user_invitation` for
  an account that holds any role row. Once their staff role is removed,
  by the Users page or any other path, they are exactly a tenant who never
  had one: their tenant rows untouched, given further units like any
  tenant, off the Users page, and kept to tenant pages. Their session
  is not ended; only `fn_tenant_access_revoke` ends sessions, when it
  removes a person's last row (`DELETE /api/users/[id]` ends none). The
  Users page lists current staff through their own rows, and an account
  left with no rows at all if it has ever been staff
  (`staff_access_accounts`, `20261118140000_tenant_app_plugin.sql`) or
  never held tenant access.
- A tenant role row is removed with its tenant: `user_roles.scope_tenant_id`
  references `tenants` with `ON DELETE CASCADE`.
- Tenants read no microgrid, edge, community or organization row. The few
  microgrid fields their pages need come from `fn_tenant_home`.

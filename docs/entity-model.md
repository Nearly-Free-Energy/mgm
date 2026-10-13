# Entity model

How MGM's data is shaped, and why. The schema itself is the source of
truth (`supabase/migrations/`, typed in `src/lib/types/database.gen.ts`);
this page records the reasoning that the schema cannot.

## Hierarchy

```
Organization ─▶ Community ─▶ Microgrid ─▶ Edge ─▶ Device
                              │
                              └▶ Household ─▶ household_devices (M:N to Device, effective-dated)
                                     └▶ household_users (M:N to auth.users)
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
- **Household** — a customer of the microgrid. A household is linked to its
  meters through `household_devices`, whose assignments carry
  `effective_from` (inclusive) and `effective_to` (exclusive, `NULL` = current),
  so a period is billed against the meter that was actually connected.

Addresses live at organization, community, and microgrid level, and
optionally on a household. `microgrids` uses structured address columns
(`address_city`, `address_region`, `address_country`, `lat`, `lng`).

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

`user_roles` holds `(user_id, role, scope_type, scope_id)` rows. Two roles
ship: `super_admin` (all organizations) and `org_manager` (one organization,
`scope_type = 'org'`). A user may hold several rows. Further roles —
`microgrid_manager`, `community_admin`, `region_admin`, `tenant` — are future
extensions by enum addition; before adding one, read `CLAUDE.md` on why a
scoped configuration role was added and then removed.

## Open decision: household (tenant) access

`household_users` exists so a household member could sign in and see their
own bills (`docs/tenant-api.md` sketches the endpoints). The original
write-up of this decision is no longer available; these are the two
realistic options, and neither is built:

- **A — household members are Supabase Auth users**, linked through
  `household_users`, with RLS letting them read their own household's rows.
- **B — no household login**; households reach their bill and payment link
  through a signed, single-purpose link (as the payment link `/p/<slug>` does
  today), and only operators have accounts.

Choose one before implementing household-facing endpoints, and record the
decision here.

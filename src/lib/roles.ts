/**
 * roles.ts — centralised role constants.
 *
 * Import these constants instead of spelling out the string literals inline.
 * The drift-prevention test (src/lib/__tests__/roles.test.ts) asserts that
 * every constant here is a real `user_role` enum value in database.gen.ts, and
 * that the two enum values this file deliberately does NOT declare stay
 * undeclared.
 *
 * Staff is not a role (user_role has no staff value): it means holding a
 * user_roles row whose role is not tenant, now. staff_access_accounts
 * records history: accounts that have ever held such a row. This is the
 * definition the rest of the code and docs point to; in application code it
 * is `staffRoles` / `rolesIncludeStaff` (@/lib/auth/access).
 *
 * Three roles are in use. The two staff roles, `super_admin` and
 * `org_manager`, are both at `scope_type = 'org'`. `tenant` (RFC mgm#197) is
 * at `scope_type = 'tenant'`, one row per unit a person rents, in any number
 * of organizations; it is granted from the tenant record
 * (`fn_tenant_access_grant`), never from the Users page, and it is not
 * staff. Tenant access does not depend on staff rows: a person may hold a
 * staff row and tenant rows at once, and keeps their tenant rows when their
 * staff rows are removed. So "has a role row" does not mean "is staff":
 * staff checks filter on the staff roles or the org scope. The CHECK
 * `user_roles_role_scope_type_consistent` (migration 20261118100100) pins
 * each role to its scope type; if it stops doing so, filtering on the scope
 * type stops being enough.
 *
 * The `ems_operator` role value and the `microgrid` scope type are inert
 * residue from #316, removed from the permission model by #321 (migration
 * 00053) — an org manager configures OpenEMS on any microgrid in their own
 * org, which is `user_can_access_microgrid` and needs no role of its own. The
 * enum values themselves cannot be removed: `ALTER TYPE … ADD VALUE` is not
 * reversible. Do not add constants for them; nothing should grant or read them.
 *
 * DO NOT add client-side canAccessX() helpers here — RLS owns access checks
 * server-side. Client-side checks invite drift and false confidence.
 */
import type { UserRole, RoleScopeType } from "@/lib/types/domain";

// `satisfies` rather than a `: UserRole` annotation: it still fails the build
// if the value stops being a valid role, but keeps each constant's narrow
// literal type. Callers that annotate a narrower union (e.g. the settings
// pages' `"super_admin" | "org_manager"` caller-role prop) would otherwise
// break every time a role is added, which is noise rather than signal.
export const SUPER_ADMIN = "super_admin" satisfies UserRole;
export const ORG_MANAGER = "org_manager" satisfies UserRole;
export const TENANT = "tenant" satisfies UserRole;

export const SCOPE_ORG = "org" satisfies RoleScopeType;
export const SCOPE_TENANT = "tenant" satisfies RoleScopeType;

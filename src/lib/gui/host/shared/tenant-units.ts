/**
 * Which of a person's units a tenant view is about (RFC mgm#197 § 4): the
 * `unit` query parameter when it names one of their own tenant rows, else
 * their only unit. Pure and client-safe: it reads only the role rows the
 * caller already holds.
 *
 * This picks; it does not authorize. The loader authorizes the unit again
 * through composeTenantApp (@/lib/tenant-app/compose), which reads the
 * caller's tenant row and the unit with their own session. A tenant row is a
 * `user_roles` row with role `tenant`, scope `tenant` and a `tenants.id` as
 * its scope id; `user_roles_role_scope_type_consistent` (20261118100100)
 * pins that pair, and if it stops doing so, check both fields here as now.
 */
import { SCOPE_TENANT, TENANT } from "@/lib/roles";
import type { UserRoleRecord } from "@/lib/types/domain";

/** The search parameter naming the unit (a `tenants.id`) a tenant view shows. */
export const TENANT_UNIT_PARAM = "unit";

type RoleRow = Pick<UserRoleRecord, "role" | "scope_type" | "scope_id">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The units the person holds a tenant row for, lowercased, sorted and each once. Staff rows never count. */
export function tenantUnitIds(roles: readonly RoleRow[]): string[] {
  const ids = new Set<string>();
  for (const r of roles) {
    if (r.role === TENANT && r.scope_type === SCOPE_TENANT && r.scope_id) ids.add(r.scope_id.toLowerCase());
  }
  return [...ids].sort();
}

/**
 * The unit a tenant view shows, or why there is none:
 * - `none`: the person holds no tenant row;
 * - `unknown`: the request names something other than one of their units,
 *   or names more than one;
 * - `choose`: no unit was named and the person has several, so they pick
 *   (the host offers a picker, as /go does for places).
 */
export type TenantUnitChoice =
  | { ok: true; tenantId: string }
  | { ok: false; reason: "none" | "unknown" | "choose" };

export function chooseTenantUnit(roles: readonly RoleRow[], requested: readonly string[]): TenantUnitChoice {
  const units = tenantUnitIds(roles);
  if (units.length === 0) return { ok: false, reason: "none" };
  if (requested.length > 1) return { ok: false, reason: "unknown" };
  if (requested.length === 1) {
    const id = requested[0].toLowerCase();
    return UUID_RE.test(id) && units.includes(id) ? { ok: true, tenantId: id } : { ok: false, reason: "unknown" };
  }
  return units.length === 1 ? { ok: true, tenantId: units[0] } : { ok: false, reason: "choose" };
}

/**
 * Where a person whose rows are all tenant rows starts (RFC mgm#197 § 4):
 * the tenant app's home, the page of the `tenant.home` view in the catalog
 * (TENANT_APP_PLUGIN in @/lib/plugins/bundled). The (gui) layout sends them
 * here from `/`, and the tenant manifest points each unit here. If the home
 * page moves, change this; tenant-units.test.ts fails while it names no
 * tenant-app page a view serves.
 */
export const TENANT_START_PAGE = "/my";

/**
 * `href` (a same-origin path, with or without a query) with its `unit`
 * parameter set to `tenantId`, every other parameter and any fragment kept.
 * The picker for a person with several units links each unit this way.
 */
export function withUnit(href: string, tenantId: string): `/${string}` {
  const hash = href.indexOf("#");
  const fragment = hash < 0 ? "" : href.slice(hash);
  const bare = hash < 0 ? href : href.slice(0, hash);
  const at = bare.indexOf("?");
  const path = at < 0 ? bare : bare.slice(0, at);
  const search = new URLSearchParams(at < 0 ? "" : bare.slice(at + 1));
  search.set(TENANT_UNIT_PARAM, tenantId);
  return `${path.startsWith("/") ? path : `/${path}`}?${search.toString()}${fragment}` as `/${string}`;
}

/**
 * The tenant home for one unit: TENANT_START_PAGE naming the unit when the
 * person has several (a page with no `unit` asks them to choose), and bare
 * when it is their only one.
 */
export function unitHomeHref(tenantId: string, several: boolean): `/${string}` {
  return several ? withUnit(TENANT_START_PAGE, tenantId) : TENANT_START_PAGE;
}

/** The units a path's query names with `unit`, for chooseTenantUnit. */
export function unitsNamedBy(pathWithQuery: string | null | undefined): string[] {
  if (!pathWithQuery) return [];
  const bare = pathWithQuery.split("#", 1)[0];
  const at = bare.indexOf("?");
  return at < 0 ? [] : new URLSearchParams(bare.slice(at + 1)).getAll(TENANT_UNIT_PARAM);
}

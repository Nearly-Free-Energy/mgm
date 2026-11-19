/**
 * Per-request organization scopes on the MGM runtime
 * (docs/cordis-runtime.md § "Two lifetimes").
 *
 * `openOrganizationScope` creates an isolated child of the root, provides
 * `mgmRequest` in it, and lets the caller load capability plugins that
 * inject it. Isolation gives every request its own slot for each
 * request-level service, so concurrent requests on one warm instance never
 * collide or see each other's capability. `dispose()` unloads the
 * capabilities and the request fiber in reverse order.
 */
import "server-only";

import type { Context, Fiber, Plugin } from "cordis";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { ORG_MANAGER, SCOPE_ORG, SCOPE_TENANT, SUPER_ADMIN, TENANT } from "@/lib/roles";
import type { TenantUnit } from "@/lib/tenant-app/types";
import type { UserRoleRecord } from "@/lib/types/domain";
import { getMgmRuntime, requireActive, type MgmRuntime } from "./root";
import type { MgmRequest } from "./services";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every service a request may provide. Each gets a fresh isolation key per
 * request. A capability plugin that provides a name missing here would
 * share one slot across concurrent requests — Cordis rejects the second
 * provide, so the omission fails loudly rather than leaking.
 */
export const REQUEST_SERVICES = [
  "mgmRequest",
  "organizationScope",
  "communityManagement",
  "meteringScope",
  "meteringRegistry",
  "metering",
  "billingScope",
  "billing",
  "billingReview",
  "paymentsScope",
  "paymentProviders",
  "payments",
  "tenantAppScope",
  "tenantApp",
] as const;

export type OrganizationAccess =
  | { ok: true; user: User; roles: UserRoleRecord[] }
  | { ok: false; reason: "invalid_org" | "unauthenticated" | "forbidden" };

/**
 * The shared authorization step every organization-scoped composer runs:
 * UUID check, authenticated user, super_admin or org_manager of the org.
 * RLS stays authoritative; this produces actionable errors before a query.
 */
export async function authorizeOrganization(
  supabase: SupabaseClient,
  organizationId: string
): Promise<OrganizationAccess> {
  if (!UUID_RE.test(organizationId)) return { ok: false, reason: "invalid_org" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: "unauthenticated" };
  const roles = await getCurrentUserRoles(supabase, user);
  const canAccess =
    roles.some((role) => role.role === SUPER_ADMIN) ||
    roles.some(
      (role) =>
        role.role === ORG_MANAGER &&
        role.scope_type === SCOPE_ORG &&
        role.scope_id === organizationId
    );
  if (!canAccess) return { ok: false, reason: "forbidden" };
  return { ok: true, user, roles };
}

export type TenantAccess =
  | { ok: true; user: User; roles: UserRoleRecord[]; unit: TenantUnit }
  | { ok: false; reason: "invalid_tenant" | "unauthenticated" | "forbidden" | "unavailable" };

/** A row of `fn_tenant_home` (20261118100100_tenant_role_access.sql). */
type TenantHomeRow = {
  tenant_id: string;
  display_name: string;
  unit_label: string | null;
  microgrid_id: string;
  microgrid_name: string;
  timezone: string;
  currency: string;
  organization_id: string;
};

/**
 * The authorization step of a tenant's request (RFC mgm#197 § 3): UUID
 * check, authenticated user, the caller's own `tenant` row for this tenant,
 * then the unit from `fn_tenant_home`, which names its organization. Staff
 * rows do not count: a super admin or org manager reads a unit through the
 * staff pages, never as its tenant, as `user_can_access_tenant` decides.
 *
 * Everything is read with the caller's own client. The role row comes
 * through "Users can view their own roles" (00002_rls.sql), and the unit
 * through `fn_tenant_home`, which answers only a caller who holds a tenant
 * row for it; it is the tenant's only view of the microgrid, since no tenant
 * policy exists on `microgrids`. If either stops answering the tenant, this
 * refuses every tenant. A failed read of either answers "unavailable", so a
 * transient error is never read as a unit the caller does not hold.
 *
 * The plugin gate is the composer's next step (composeTenantApp), as it is
 * after authorizeOrganization, so its codes and copy stay the gate's own.
 */
export async function authorizeTenant(
  supabase: SupabaseClient,
  tenantId: string
): Promise<TenantAccess> {
  if (!UUID_RE.test(tenantId)) return { ok: false, reason: "invalid_tenant" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: "unauthenticated" };
  // Read here, not through getCurrentUserRoles, which answers a failed read
  // with no rows: a tenant must be asked to retry, not told the unit is gone.
  let roles: UserRoleRecord[];
  try {
    const { data, error } = await supabase
      .from("user_roles")
      .select("*")
      .eq("user_id", user.id)
      .returns<UserRoleRecord[]>();
    if (error) return { ok: false, reason: "unavailable" };
    roles = data ?? [];
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const holdsUnit = roles.some(
    (role) =>
      role.role === TENANT && role.scope_type === SCOPE_TENANT && role.scope_id === tenantId
  );
  if (!holdsUnit) return { ok: false, reason: "forbidden" };

  let rows: unknown;
  try {
    const { data, error } = await supabase.rpc("fn_tenant_home", { _tenant_id: tenantId });
    if (error) return { ok: false, reason: "unavailable" };
    rows = data;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const row = (Array.isArray(rows) ? rows[0] : null) as TenantHomeRow | null | undefined;
  // No row: the access was removed, or the unit deleted, since the role read.
  if (!row || row.tenant_id !== tenantId) return { ok: false, reason: "forbidden" };
  return {
    ok: true,
    user,
    roles,
    unit: {
      tenantId: row.tenant_id,
      displayName: row.display_name,
      unitLabel: row.unit_label,
      microgridId: row.microgrid_id,
      microgridName: row.microgrid_name,
      timezone: row.timezone,
      currency: row.currency,
      organizationId: row.organization_id,
    },
  };
}

export const RequestScopePlugin = {
  name: "mgm-request",
  apply(ctx: Context, request: MgmRequest) {
    ctx.provide("mgmRequest", request);
  },
} satisfies Plugin.Object<MgmRequest>;

export type OrganizationScope = {
  runtime: MgmRuntime;
  /** The isolated request context. */
  ctx: Context;
  request: MgmRequest;
  /** Load a capability plugin into this request and wait until it is active. */
  load<T>(plugin: Plugin.Object<T>, config: T): Promise<Fiber>;
  load(plugin: Plugin.Object<void>): Promise<Fiber>;
  /** Unload every plugin loaded for this request, newest first. */
  dispose(): Promise<void>;
};

/**
 * Low-level constructor: callers must authorize the request before opening
 * it. For every composer but two, `request.organizationId` and `roles` are
 * organization access the composer authorized with authorizeOrganization,
 * and the capability plugins (community-management, metering, billing,
 * billing-review, payments) rely on that. composePaymentsPublic opens one
 * with no user for the payment the request names. composeTenantApp opens
 * one for a tenant, who may hold no access to the organization, with only
 * their tenant rows, and loads nothing but TenantAppPlugin into it; no
 * other capability plugin may be loaded into such a scope.
 */
export async function openOrganizationScope(
  request: MgmRequest,
  options: {
    /** Extra request-level service names to isolate (tests, new plugins). */
    isolate?: readonly string[];
  } = {}
): Promise<OrganizationScope> {
  const runtime = await getMgmRuntime();
  let ctx = runtime.root;
  for (const name of [...REQUEST_SERVICES, ...(options.isolate ?? [])]) {
    ctx = ctx.isolate(name);
  }

  const fibers: Fiber[] = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const fiber of [...fibers].reverse()) {
      try {
        await fiber.dispose();
      } catch {
        // Keep unloading the rest; a failed unload must not pin others.
      }
    }
  };

  const load = async (plugin: Plugin.Object<unknown>, config?: unknown) => {
    if (disposed) throw new Error("Request scope has been disposed");
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    return requireActive(fiber, plugin.name ?? "anonymous");
  };

  try {
    await load(RequestScopePlugin, request);
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    runtime,
    ctx,
    request,
    load: load as OrganizationScope["load"],
    dispose,
  };
}

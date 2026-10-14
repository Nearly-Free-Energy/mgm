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
import { ORG_MANAGER, SCOPE_ORG, SUPER_ADMIN } from "@/lib/roles";
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
  const roles = await getCurrentUserRoles(supabase);
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

/** Low-level constructor: callers must authorize the request before opening it. */
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

import "server-only";

/**
 * Whether each plugin is live for one organization, for the GUI host.
 *
 * Reads through the plugin gate (checkGate in src/lib/runtime/gate.ts),
 * asked as a write on the organization, so each answer and its refusal copy
 * are the gate's own. Each plugin is read at most once per gate, on one
 * client of the caller's own session; nothing is kept between requests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { rolesCanAccessOrg } from "@/lib/auth/access";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { checkGate, type GateDecision } from "@/lib/runtime/gate";
import { tenantUnitIds } from "../shared/tenant-units";
import { requireIssued, type HostContext } from "./access";

export type PluginGate = (plugin: MgmPluginName) => Promise<GateDecision>;

/** Each plugin's decision for `organizationId`, asked at most once, on one client. */
function memoGate(ctx: HostContext, organizationId: string): PluginGate {
  let client: Promise<SupabaseClient> | null = null;
  const decisions = new Map<MgmPluginName, Promise<GateDecision>>();
  return (plugin) => {
    let decision = decisions.get(plugin);
    if (!decision) {
      client ??= ctx.newClient();
      decision = client.then((supabase) =>
        checkGate(supabase, {
          plugin,
          target: { kind: "organization", id: organizationId },
          method: "GET",
          access: "write",
        }),
      );
      decisions.set(plugin, decision);
    }
    return decision;
  };
}

/**
 * The gate for `organizationId`. Throws when the caller's roles do not reach
 * it: resolveTargetOrganization (runtime/gate.ts) returns an organization
 * target's id unchecked, so the host must have resolved and checked the
 * organization first. If that starts checking visibility, revisit.
 */
export function pluginGate(ctx: HostContext, organizationId: string): PluginGate {
  requireIssued(ctx);
  if (!rolesCanAccessOrg([...ctx.access.roles], organizationId)) {
    throw new Error("GUI host: plugin state asked for an organization the caller cannot access");
  }
  return memoGate(ctx, organizationId);
}

/**
 * The gate for the organization of one of the caller's own units (RFC
 * mgm#197 § 4), for a person who reaches it as its tenant rather than as
 * staff. Throws unless the caller holds a tenant row for `unit.tenantId`.
 * `unit.organizationId` must be what `fn_tenant_home` returned for that unit
 * on this request (readTenantUnits in ./units.ts), since nothing here checks
 * it: a tenant reads no organization row to check it against.
 *
 * Asked with the tenant's own client, as composeTenantApp
 * (@/lib/tenant-app/compose) asks it: `mgm_plugin_enabled_for_org` answers
 * any signed-in caller, tenant-only accounts included, about any
 * organization, so its answer is not scoped to the caller's organizations
 * and the check above is what limits what is asked. If it starts checking
 * the caller's organization access, every decision here becomes the gate's
 * 503, and the person is shown no tenant entry.
 */
export function unitPluginGate(ctx: HostContext, unit: { tenantId: string; organizationId: string }): PluginGate {
  requireIssued(ctx);
  if (!tenantUnitIds(ctx.access.roles).includes(unit.tenantId.toLowerCase())) {
    throw new Error("GUI host: plugin state asked for a unit the caller does not hold");
  }
  return memoGate(ctx, unit.organizationId);
}

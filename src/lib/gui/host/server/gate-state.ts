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
import { MGM_BUNDLED_PLUGINS, type MgmPluginName } from "@/lib/plugins/bundled";
import { checkGate, type GateDecision } from "@/lib/runtime/gate";
import { livePlugins } from "../shared/manifest-model";
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

/** What one organization of the caller's units has live (unitOrganizationPlugins). */
export type UnitOrganizationPlugins = Readonly<{
  /** The plugins live there, each with its dependencies, as livePlugins decides. */
  live: ReadonlySet<MgmPluginName>;
  /**
   * The plugins live there if every state the gate could not read (its 503)
   * were on: what is not in it is off there for certain.
   */
  possiblyLive: ReadonlySet<MgmPluginName>;
}>;

/**
 * What each organization of `units` has live, by organization id, each
 * asked once through the gate of one unit there (unitPluginGate), with the
 * person's own session. A gate that throws rejects that organization's entry
 * only. The tenant manifest's nav (unitsGate in ./manifest.ts) and the unit
 * picker (./render-view.tsx) both read this, so they agree on where a plugin
 * is live; if one of them stops reading it, they can disagree.
 */
export async function unitOrganizationPlugins(
  ctx: HostContext,
  units: readonly { tenantId: string; organizationId: string }[],
): Promise<Map<string, PromiseSettledResult<UnitOrganizationPlugins>>> {
  const byOrganization = new Map<string, { tenantId: string; organizationId: string }>();
  for (const unit of units) if (!byOrganization.has(unit.organizationId)) byOrganization.set(unit.organizationId, unit);
  const settled = await Promise.allSettled(
    [...byOrganization.values()].map(async (unit) => {
      const gate = unitPluginGate(ctx, unit);
      const decisions = await Promise.all(MGM_BUNDLED_PLUGINS.map(async (p) => [p.name, await gate(p.name)] as const));
      return {
        live: livePlugins(Object.fromEntries(decisions.map(([name, d]) => [name, d.ok]))),
        possiblyLive: livePlugins(Object.fromEntries(decisions.map(([name, d]) => [name, d.ok || d.status === 503]))),
      };
    }),
  );
  return new Map([...byOrganization.keys()].map((id, i) => [id, settled[i]]));
}

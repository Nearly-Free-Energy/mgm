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
import { requireIssued, type HostContext } from "./access";

export type PluginGate = (plugin: MgmPluginName) => Promise<GateDecision>;

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

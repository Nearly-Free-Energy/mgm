import "server-only";

/**
 * What the GUI host gives an agent client (RFC #259 § 2; ADR-007 decisions
 * 1, 4 and 5; ADR-008 decision 6): the assistant bridge, acting as the
 * signed-in person. Middleware lets one reach only the catalog and the view
 * route (AGENT_ROUTES in @/lib/runtime/agent-routes), and the host's other
 * routes refuse it again (openHostRequest in ./http.ts). On those two:
 *
 * - the catalog gives it an organization's catalog only, never one for
 *   `entity=` (buildActionCatalog in ./catalog.ts), so it is never told
 *   about a tenant, a bill, a payment or a person by id, and no action's
 *   available() is asked, whose copy can name amounts;
 * - the view route gives it only an organization's view marked
 *   `agent: "read"` (dispatchView in ./view.ts), and answers every other
 *   view, tenant views included, as a page that does not exist;
 * - each of them first asks the assistant plugin's gate for the
 *   organization, as a write (assistantGate below).
 *
 * prepareAction (./prepare.ts) refuses an agent client too, so no proposal
 * an assistant makes is prepared in its own session.
 */
import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { requireIssued, type HostContext } from "./access";
import { pluginGate } from "./gate-state";
import type { HostFailure } from "./view";

/** The assistant plugin's catalog name (ADR-007 decision 5). Not bundled yet. */
export const ASSISTANT_PLUGIN: string = "assistant";

/** The host's refusal of an agent client where it may not go. */
export const AGENT_REFUSED: HostFailure = Object.freeze({
  ok: false,
  status: 403,
  code: "gui_agent_refused",
  message: "An assistant cannot use this.",
});

/**
 * The refusal while no assistant plugin is installed: the code the plugin
 * gate gives a plugin that is off (`assistant_disabled`, codePrefix in
 * @/lib/runtime/gate), since a plugin that is not installed cannot be on.
 */
export const ASSISTANT_NOT_INSTALLED: HostFailure = Object.freeze({
  ok: false,
  status: 409,
  code: "assistant_disabled",
  message: "The assistant is not turned on for this organization.",
});

/** True when `ctx` is an agent client's. */
export function isAgentCaller(ctx: HostContext): boolean {
  return ctx.caller.kind === "agent";
}

/**
 * Null when the assistant may take a step in `organizationId`, else the
 * refusal. ADR-007 decision 5: every assistant step, one that only reads
 * included, asks the gate with `access: "write"` and is refused while the
 * plugin is off for the organization; pluginGate (./gate-state.ts) asks
 * every plugin as a write. The route does not know who is calling, so the
 * host asks this from the context the resolver gave it, once the
 * organization is known and checked (pluginGate throws otherwise).
 *
 * No `assistant` plugin is bundled yet, so this refuses every agent step:
 * agent.test.ts fails once one is, so that whoever adds it settles what a
 * marked view gives an agent client beyond its own model (its actions, and
 * the views attached to or embedded in it: ADR-007 decision 7) before this
 * lets one through.
 */
export async function assistantGate(ctx: HostContext, organizationId: string): Promise<HostFailure | null> {
  requireIssued(ctx);
  const assistant = MGM_BUNDLED_PLUGINS.find((plugin) => plugin.name === ASSISTANT_PLUGIN);
  if (!assistant) return ASSISTANT_NOT_INSTALLED;
  const decision = await pluginGate(ctx, organizationId)(assistant.name);
  return decision.ok ? null : { ok: false, status: decision.status, code: decision.code, message: decision.message };
}

import "server-only";

/**
 * The checks the host makes before it offers an action, each answered as a
 * refusal or nothing: whether the action's route is part of this release,
 * and what the plugin gate answers for the action's plugin. The action
 * catalog (./catalog.ts) lists both as each action's reasons. Prepare
 * (./prepare.ts) refuses with gateRefusal only: an action whose route is not
 * released it answers with its own NOT_FOUND (404 gui_not_found), as it
 * answers an action no plugin contributes, so the catalog's
 * gui_not_released is not what prepare sends for the same action. If prepare
 * comes to call releaseFailure, its 404's code changes to gui_not_released:
 * change the `installed` row of the catalog's table in
 * docs/cordis-runtime.md, which notes the difference.
 *
 * Takes the gate's decision as an argument and never names the registry, so
 * it stays unprivileged.
 */
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { codePrefix, type GateDecision } from "@/lib/runtime/gate";
import type { AvailabilityCheck } from "../../contract";
import type { ActionDef } from "../../surface";

/** One check that refused an action: which, and the status, code and copy it refused with. */
export type CheckFailure = {
  check: Extract<AvailabilityCheck, "installed" | "enabled" | "healthy">;
  status: number;
  code: string;
  message: string;
};

/**
 * What the plugin gate's decision means for one action of `plugin`, or null
 * when it does not refuse it. A decision of null is a gate that threw: it
 * refuses as the gate's own 503 would, with the gate's code
 * (`<prefix>_gate_unavailable`, codePrefix in src/lib/runtime/gate.ts).
 *
 * An action declaring whilePluginOff: "enabled" goes to a route that
 * accepts it while its plugin is off (a PaymentExemption in UNGATED_WRITES,
 * which gui-surface.test.ts requires, on a route file route-surface.test.ts
 * holds to no gate call), so the gate's 409 does not refuse it; any other
 * answer still does. If the route starts gating, remove the field.
 */
export function gateRefusal(
  decision: GateDecision | null,
  def: Pick<ActionDef, "whilePluginOff">,
  plugin: MgmPluginName,
): CheckFailure | null {
  if (decision === null) {
    return {
      check: "healthy",
      status: 503,
      code: `${codePrefix(plugin)}_gate_unavailable`,
      message: "Could not check whether this part of MGM is enabled.",
    };
  }
  if (decision.ok) return null;
  if (decision.status === 409) {
    if (def.whilePluginOff === "enabled") return null;
    return { check: "enabled", status: 409, code: decision.code, message: decision.message };
  }
  return { check: "healthy", status: decision.status, code: decision.code, message: decision.message };
}

/**
 * A refusal when the route `path` is not part of the release installed here
 * (src/lib/mgm/released-routes.ts). Its code is the one a view whose page is
 * not released answers with (NOT_RELEASED in ./view.ts), so the catalog and
 * the view route say "not part of this release" with one code; if that one
 * changes, change this. Prepare does not call it (see above), and answers
 * such an action with gui_not_found.
 */
export function releaseFailure(path: string): CheckFailure | null {
  if (isReleasedRoute(path)) return null;
  return {
    check: "installed",
    status: 404,
    code: "gui_not_released",
    message: "This action is not part of the MGM release installed here.",
  };
}

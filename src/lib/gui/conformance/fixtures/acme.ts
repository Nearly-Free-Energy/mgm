/**
 * A plugin no GUI was written for, "Acme", offering one action on every core
 * entity kind. withPoke merges it into a model through the host's own merge
 * (appendTargetedActions), so a GUI is checked against exactly what the host
 * would send: a "Poke · Acme" control on the view's entity and on each row.
 */
import { CORE_ENTITY_KINDS, type MgmPluginName } from "@/lib/plugins/bundled";
import type { ViewModel } from "../../contract";
import { appendTargetedActions, type MergeAction } from "../../host/shared/merge-actions";

/** Not in the catalog, so the merge shows its name as given ("from": "Acme"). */
const ACME = "Acme" as MgmPluginName;
export const POKE_ACTION = "acme.poke";
export const POKE_LABEL = "Poke · Acme";

const POKES: readonly MergeAction[] = CORE_ENTITY_KINDS.map((kind) => ({
  plugin: ACME,
  def: {
    id: POKE_ACTION,
    title: POKE_LABEL,
    target: kind,
    path: "/api/acme/poke/[id]",
    method: "POST",
    risk: "write",
    confirm: "confirm",
    bind: { path: { id: kind } },
  },
}));

/** The model with acme.poke offered on its entity and on each row's, as the host merges it. */
export function withPoke(model: ViewModel): ViewModel {
  return appendTargetedActions(model, {
    // The view's own plugin: any bundled plugin other than Acme.
    plugin: "metering",
    actions: POKES,
    scope: {},
    gate: new Map([[ACME, { ok: true }]]),
    isReleased: () => true,
  }).model;
}

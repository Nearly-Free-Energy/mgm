/**
 * Which component draws a view model: the GUI's bespoke renderer for that
 * view when it reads the model's `ext` version, else the GUI's View, else
 * the host's RawView. RawView is chosen when the model's kind arrived in a
 * contract version after the lowest one the GUI's range admits, because a
 * GUI built against that version cannot know the kind. Pure: the caller
 * maps "raw" to RawView, so this module imports no client code.
 */
import { GUI_KINDS_SINCE, type GuiPlugin, type Id, type SyncComponent, type ViewModel, type ViewProps } from "../../contract";
import { compareVersions, parseCaretRange } from "./contract-range";

export type RendererChoice =
  | { source: "renderer"; id: Id; Component: SyncComponent<ViewProps> }
  | { source: "view"; Component: SyncComponent<ViewProps> }
  | { source: "raw" };

const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

export type KindsSince = Readonly<Record<string, string>>;

/** The version an `ext` schema names ("metering.site-day@1" → 1), or null. */
export function extVersion(schema: string): number | null {
  const at = schema.lastIndexOf("@");
  const version = at < 0 ? NaN : Number(schema.slice(at + 1));
  return Number.isInteger(version) && version >= 0 ? version : null;
}

/** Whether a GUI declaring `range` knows `kind`. An unlisted kind or a malformed range is unknown. */
export function knowsKind(range: string, kind: string, kindsSince: KindsSince = GUI_KINDS_SINCE): boolean {
  const since = own(kindsSince, kind) ? kindsSince[kind] : undefined;
  if (!since) return false;
  try {
    return compareVersions(since, parseCaretRange(range).min.join(".")) <= 0;
  } catch {
    return false;
  }
}

export function pickRenderer(
  gui: Pick<GuiPlugin, "contract" | "View" | "renderers">,
  model: ViewModel,
  kindsSince: KindsSince = GUI_KINDS_SINCE,
): RendererChoice {
  const bespoke = gui.renderers && own(gui.renderers, model.view) ? gui.renderers[model.view] : undefined;
  const version = model.ext ? extVersion(model.ext.schema) : null;
  if (bespoke && version !== null && bespoke.reads.includes(version)) {
    return { source: "renderer", id: model.view, Component: bespoke.Component };
  }
  return knowsKind(gui.contract, model.kind, kindsSince) ? { source: "view", Component: gui.View } : { source: "raw" };
}

/**
 * The compiled-in GUIs' entry points, by the names src/gui/meta.ts gives
 * them. Host pages import this to render the GUI MGM_GUI selects
 * (src/lib/config/gui.ts); nothing else does, so a GUI's components reach
 * only the pages that render it (gui-boundary.test.ts, rule gui-installed).
 */
import type { GuiPlugin } from "@/lib/gui/contract";
import { GridtopGui } from "./gridtop";
import type { GuiName } from "./meta";

export const INSTALLED_GUIS: Readonly<Record<GuiName, GuiPlugin>> = {
  gridtop: GridtopGui,
};

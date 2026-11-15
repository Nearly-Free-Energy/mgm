/**
 * Gridtop, the default interface: its metadata, its frame, the kit's view
 * renderer, and its bespoke renderers. The host links its stylesheet
 * (GuiMeta.styles).
 */
import type { GuiPlugin } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GRIDTOP_META } from "./meta";
import { GRIDTOP_RENDERERS } from "./renderers";
import { GridtopShell } from "./shell/shell";

export const GridtopGui = {
  ...GRIDTOP_META,
  Shell: GridtopShell,
  View: kit.KitView,
  renderers: GRIDTOP_RENDERERS,
} satisfies GuiPlugin;

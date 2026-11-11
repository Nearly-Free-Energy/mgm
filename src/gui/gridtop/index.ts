/**
 * Gridtop, the default interface: its metadata, its frame, and the kit's
 * view renderer. The host links its stylesheet (GuiMeta.styles).
 */
import type { GuiPlugin } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GRIDTOP_META } from "./meta";
import { GridtopShell } from "./shell/shell";

export const GridtopGui = {
  ...GRIDTOP_META,
  Shell: GridtopShell,
  View: kit.KitView,
} satisfies GuiPlugin;

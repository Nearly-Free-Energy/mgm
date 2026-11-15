/**
 * Gridtop, the default interface: its metadata, its frame, the kit's view
 * renderer, and its own renderers for the views listed in
 * ./renderers/reads.ts. The host links its stylesheet (GuiMeta.styles).
 */
import type { GuiPlugin } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GRIDTOP_META } from "./meta";
import { RENDERER_READS } from "./renderers/reads";
import { SiteDayRenderer } from "./renderers/site-day";
import { GridtopShell } from "./shell/shell";

export const GridtopGui = {
  ...GRIDTOP_META,
  Shell: GridtopShell,
  View: kit.KitView,
  renderers: {
    "metering.site-day": { reads: RENDERER_READS["metering.site-day"], Component: SiteDayRenderer },
  },
} satisfies GuiPlugin;

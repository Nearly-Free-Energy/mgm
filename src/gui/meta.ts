/**
 * The GUIs compiled into this build, by name. The runtime root installs each
 * one at start-up (guiInstallPlugin in src/lib/runtime/root.ts) without
 * importing React: an entry is a package's meta.ts, which imports only types
 * from @/lib/gui/contract (gui-boundary.test.ts). The key, GuiMeta.name and
 * the Cordis plugin name are one identifier, and MGM_GUI selects one by it
 * (src/lib/config/gui.ts).
 */
import type { GuiMeta } from "@/lib/gui/contract";
import { GRIDTOP_META } from "./gridtop/meta";

export const GUI_META = {
  gridtop: GRIDTOP_META,
} as const satisfies Readonly<Record<string, GuiMeta>>;

export type GuiName = keyof typeof GUI_META;

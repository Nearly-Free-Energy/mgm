/**
 * The GUIs compiled into this build, by name. The runtime root installs each
 * one at start-up (guiInstallPlugin in src/lib/runtime/root.ts) without
 * importing React: an entry is a package's meta.ts, which imports only types
 * from @/lib/gui/contract (gui-boundary.test.ts). The key, GuiMeta.name and
 * the Cordis plugin name are one identifier.
 */
import type { GuiMeta } from "@/lib/gui/contract";

export const GUI_META: Readonly<Record<string, GuiMeta>> = {};

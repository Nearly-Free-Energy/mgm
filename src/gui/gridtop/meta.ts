/**
 * Gridtop, the default interface. Read at start-up without React, so this
 * file imports only types from the contract (gui-boundary.test.ts).
 */
import type { GuiMeta } from "@/lib/gui/contract";

export const GRIDTOP_META = {
  name: "gridtop",
  title: "Gridtop",
  version: "0.1.0",
  contract: "^0.1",
  styles: "./styles.css",
  dependencies: ["clsx", "lucide-react"],
} as const satisfies GuiMeta;

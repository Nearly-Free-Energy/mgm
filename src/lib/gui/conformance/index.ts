/**
 * The conformance kit every interface plugin runs in its own tests:
 *
 *   import { describeGuiConformance } from "@/lib/gui/conformance";
 *   describeGuiConformance(myGui);
 *
 * It renders the GUI inside the real kit with a runtime that records every
 * kit call, and asserts what the contract asks of a GUI. Only test files
 * import it (gui-boundary.test.ts).
 */
import { describe, it } from "vitest";
import type { GuiPlugin } from "../contract";
import { registerConformance } from "./describe";

export { WIDTHS, type CheckId, type Finding } from "./checks";
export { crawl, type Reachable } from "./crawl";
export { MANIFEST_FIXTURES, PAGE_MODEL, type ManifestFixture } from "./fixtures/manifests";
export { ModelView, recordingRuntime, renderShell, settle, type Recorded, type Rendered } from "./harness";

/** One `describe` per GUI and one `it` per check; the GUI must match its entry in GUI_META. */
export function describeGuiConformance(gui: GuiPlugin): void {
  registerConformance(gui, {}, { describe, it });
}

/** Gridtop against the GUI conformance kit (src/lib/gui/conformance). */
import { afterAll, beforeAll, vi } from "vitest";
import { describeGuiConformance } from "@/lib/gui/conformance";
import { GridtopGui } from "..";

// The crawl presses "Open in new window", and jsdom has no window.open.
beforeAll(() => {
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describeGuiConformance(GridtopGui);

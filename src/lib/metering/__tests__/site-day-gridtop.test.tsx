// @vitest-environment jsdom
/**
 * The `metering.site-day` examples drawn by Gridtop, which picks its own
 * renderer for them: each state drawn as expected, and each passing the
 * conformance kit's model checks with acme.poke merged in. Kept here because
 * a GUI package's tests may not import a capability's examples
 * (gui-boundary.test.ts, rule 8).
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { GridtopGui } from "@/gui/gridtop";
import { ModelView, checkModel, renderInKit, withPoke } from "@/lib/gui/conformance";
import type { ViewModel } from "@/lib/gui/contract";
import { SYNTHETIC_NOTICE } from "@/lib/gui/host/server/view";
import { SITE_DAY_EXAMPLES } from "../surface/examples";

const NAMES = ["a clear day", "a day with cuts and dark time", "a site with no battery", "no site devices"];
const EXAMPLES = SITE_DAY_EXAMPLES.map((model, i) => [NAMES[i], model] as const);
const text = () => document.body.textContent ?? "";
const count = (needle: string) => text().split(needle).length - 1;

async function draw(model: ViewModel) {
  await renderInKit(<ModelView gui={GridtopGui} model={model} />);
}

// The renderer is a chunk of its own: load it once, so the model checks see it drawn on their first render.
beforeAll(async () => {
  await draw(SITE_DAY_EXAMPLES[0]);
  await waitFor(() => expect(document.querySelector("[data-tile]")).not.toBeNull());
  cleanup();
}, 30_000);

describe("the site-day examples in Gridtop", () => {
  it("covers each state: three generated days and no site devices", () => {
    expect(SITE_DAY_EXAMPLES.map((m) => (m.ext?.data as { state: string }).state)).toEqual(["day", "day", "day", "no-site-devices"]);
  });

  // The host's own notice, so the renderer's check on its wording is tested against the real text.
  it.each(EXAMPLES.slice(0, 3))("draws %s with the tiles, marked synthetic once in a band", async (_, model) => {
    expect(model.notice).toEqual(SYNTHETIC_NOTICE);
    await draw(model);
    expect(document.querySelector("[data-tile='solar']")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Previous day" })).toBeTruthy();
    expect(count(SYNTHETIC_NOTICE.text)).toBe(1);
    expect(count("Synthetic data: generated for demonstration")).toBe(0);
    // One mark per figure; the time without grid power is not shown when there is no cut count.
    expect(document.querySelectorAll('[title="Synthetic"]').length).toBeGreaterThanOrEqual(model.body.tiles.length - 1);
    cleanup();
  });

  it("draws no site devices as the empty state, with the Edges link as its button", async () => {
    const model = SITE_DAY_EXAMPLES[3];
    await draw(model);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Register the battery and grid meter");
    expect(screen.getByRole("link", { name: "Go to Edges" }).getAttribute("href")).toMatch(/\/setup\/edges$/);
    expect(document.querySelector("[data-tile]")).toBeNull();
    expect(text()).not.toMatch(/synthetic/i);
    cleanup();
  });

  it.each(EXAMPLES)(
    "passes the model checks for %s, with acme.poke",
    async (name, model) => {
      const findings = await checkModel(GridtopGui, withPoke(model), name);
      const lines = findings.map((f) => `${f.check}: ${f.fixture}: ${f.message}`);
      expect(lines, lines.join("\n")).toEqual([]);
    },
    60_000,
  );
});

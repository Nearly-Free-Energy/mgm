/**
 * Today's tiles on Gridtop: Gridtop draws a page's view with the kit's view,
 * picked as production picks it, so the views attached to Today as tiles
 * load after the first paint and draw in cards below its body, each with a
 * link to its page, and one that cannot be loaded leaves the page and the
 * other tiles in place.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderModel } from "@/lib/gui/conformance";
import type { ViewModel } from "@/lib/gui/contract";
import { GridtopGui } from "..";

const ORG = "00000000-0000-4000-8000-000000000001";
const PERIODS = `/billing?org=${ORG}`;
const OPERATIONS = `/microgrids/m1/operations?org=${ORG}`;

const base = { type: "view", org: ORG, trail: [], actions: [], links: [], attached: [] } as const;

const TODAY = {
  ...base,
  view: "org.today",
  kind: "collection",
  title: "Today",
  body: { columns: [{ key: "title", label: "Signal", type: "text", priority: 1 }], rows: [], empty: { title: "Nothing needs you right now." } },
  attached: [
    { view: "billing.current-periods", title: "Current billing periods", href: PERIODS, hint: "tile" },
    { view: "metering.site-day", title: "Operations", href: OPERATIONS, hint: "tile" },
  ],
} as unknown as ViewModel;

const CURRENT_PERIODS = {
  ...base,
  view: "billing.current-periods",
  kind: "collection",
  title: "Current billing periods",
  body: {
    columns: [{ key: "microgrid", label: "Microgrid", type: "text", priority: 1 }],
    rows: [{ id: "m1", href: "/microgrids/m1/billing", cells: { microgrid: { t: "text", text: "Kasana East" } }, actions: [] }],
    empty: { title: "No microgrids yet" },
  },
} as unknown as ViewModel;

describe("Gridtop: tiles on Today", () => {
  it("draws each tile below Today's body with a link to its page, and keeps the page and the others when one cannot be loaded", async () => {
    // The Operations tile has no answer, so the harness answers it 404.
    const { log } = await renderModel(GridtopGui, TODAY, undefined, { [PERIODS]: CURRENT_PERIODS });
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
    const region = screen.getByRole("region", { name: "At a glance" });
    expect(await within(region).findByRole("link", { name: "Kasana East" })).toBeTruthy();
    await waitFor(() => expect(within(region).queryAllByRole("status", { busy: true })).toHaveLength(0));
    expect(within(region).queryByRole("link", { name: "Kasana East" })).toBeTruthy();
    expect(region.querySelector('[data-gui-tile="metering.site-day"]')?.textContent).not.toContain("Kasana East");
    expect(within(region).getByRole("link", { name: "Open Current billing periods" }).getAttribute("href")).toBe(PERIODS);
    expect(within(region).getByRole("link", { name: "Open Operations" }).getAttribute("href")).toBe(OPERATIONS);
    expect([...log.loadView].sort()).toEqual([OPERATIONS, PERIODS].sort());
    // The tiles are drawn on the page, not listed again as related views.
    expect(screen.queryByRole("navigation", { name: "Related views" })).toBeNull();
  });
});

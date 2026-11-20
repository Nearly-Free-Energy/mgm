/**
 * Today's tiles on Gridtop: Gridtop draws a page's view with the kit's view
 * (GridtopGui.View), so the views attached to Today as tiles load after the
 * first paint and draw in cards below its body, and one that fails leaves
 * the page and the other tiles in place.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ViewModel } from "@/lib/gui/contract";
import { KitRuntimeProvider } from "@/lib/gui/host/client/kit-runtime";
import { model, recordingRuntime } from "@/lib/gui/host/client/__tests__/kit-test-utils";
import { GridtopGui } from "..";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null, useRouter: () => ({}) }));

const ORG = "00000000-0000-4000-8000-000000000001";
const PERIODS = `/billing?org=${ORG}` as const;
const OTHER = `/microgrids/m1/operations?org=${ORG}` as const;

const TODAY = model({
  view: "org.today",
  kind: "collection",
  title: "Today",
  body: { columns: [{ key: "title", label: "Signal", type: "text", priority: 1 }], rows: [], empty: { title: "Nothing needs you right now." } },
  attached: [
    { view: "billing.current-periods", title: "Current billing periods", href: PERIODS, hint: "tile" },
    { view: "metering.site-day", title: "Operations", href: OTHER, hint: "tile" },
  ],
} as Partial<ViewModel>);

const PERIODS_MODEL = model({
  view: "billing.current-periods",
  kind: "collection",
  title: "Current billing periods",
  body: {
    columns: [{ key: "microgrid", label: "Microgrid", type: "text", priority: 1 }],
    rows: [{ id: "m1", href: "/microgrids/m1/billing", cells: { microgrid: { t: "text", text: "Kasana East" } }, actions: [] }],
    empty: { title: "No microgrids yet" },
  },
} as Partial<ViewModel>);

describe("Gridtop: tiles on Today", () => {
  it("draws each tile below Today's body with a link to its page, and keeps the page and the others when one fails", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes(encodeURIComponent(PERIODS))
        ? Response.json(PERIODS_MODEL)
        : Response.json({ code: "gui_view_refused", error: "Operations could not be loaded right now." }, { status: 503 }),
    );
    const runtime = recordingRuntime({ fetch });
    render(
      <KitRuntimeProvider runtime={runtime}>
        <GridtopGui.View model={TODAY} />
      </KitRuntimeProvider>,
    );
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Tiles" });
    expect(await within(region).findByRole("link", { name: "Kasana East" })).toBeTruthy();
    expect(await within(region).findByText("Operations could not be loaded right now.")).toBeTruthy();
    expect(within(region).getByRole("link", { name: "Open Current billing periods" }).getAttribute("href")).toBe(PERIODS);
    expect(within(region).getByRole("link", { name: "Open Operations" }).getAttribute("href")).toBe(OTHER);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The tiles are drawn on the page, not listed again as related views.
    expect(screen.queryByRole("navigation", { name: "Related views" })).toBeNull();
  });
});

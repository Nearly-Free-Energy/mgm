/**
 * The views attached to a page's view as sections: Gridtop's frame loads
 * each after the first paint with kit.loadView and draws it below the page,
 * with Gridtop's renderer for it or the kit's view, each in its own boundary.
 */
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderShell, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import type { ActionResult, ModelOf, ViewModel, ViewState } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "..";
import { rendererFor } from "../shell/section-list";
import { EAST, EAST_TRAIL, KASANA, ORG, placesFixture } from "./places-fixture";

const SAVINGS_HREF = "/microgrids/m1/operations/savings?date=2026-11-05" as const;

const PAGE: ViewModel = {
  type: "view",
  view: "metering.site-day",
  kind: "record",
  title: "Operations",
  org: "o1",
  trail: [],
  body: { sections: [] },
  actions: [],
  links: [],
  attached: [
    { view: "community.microgrid", title: "Microgrid", href: "/microgrids/m1", hint: "tab" },
    { view: "billing.savings", title: "What the site saved", href: SAVINGS_HREF, hint: "section" },
  ],
};

const savings = (data: unknown, schema: `${string}.${string}@${number}` = "billing.savings@1"): ModelOf<"metrics"> => ({
  type: "view",
  view: "billing.savings",
  kind: "metrics",
  title: "What the site saved",
  org: "o1",
  trail: [],
  body: { tiles: [{ key: "day.solar", label: "Solar savings, 5 Nov", value: { t: "text", text: "UGX 660" } }] },
  actions: [],
  links: [],
  attached: [],
  ext: { schema, data: data as never },
});
const READY = savings({
  state: "ready",
  synthetic: false,
  columns: [{ id: "day", label: "5 Nov", sub: null }],
  rows: [{ id: "solar", label: "Solar savings ≈", sub: null, strong: false }],
  warnings: [],
  notes: [],
});

const fixture = (): ManifestFixture =>
  placesFixture({
    pathname: "/microgrids/m1/operations",
    initial: { view: "metering.site-day", title: "Operations", trail: EAST_TRAIL, tabs: [], scope: { organization: ORG, community: KASANA, microgrid: EAST } },
  });

function withPage(model: ViewModel | null) {
  const real = kit.useView;
  vi.spyOn(kit, "useView").mockImplementation((): ViewState => ({ ...real(), model }));
}
const answer = (out: ViewModel | ActionResult | Promise<ViewModel | ActionResult>) =>
  vi.spyOn(kit, "loadView").mockImplementation(async () => out);

let rendered: Rendered | null = null;
async function shell() {
  rendered = await renderShell(GridtopGui, fixture(), <p>The page</p>);
  return rendered;
}

beforeAll(async () => {
  await Promise.all([import("../shell/section-list"), import("../renderers/savings/savings-view")]);
});
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.restoreAllMocks();
});

describe("Gridtop's attached sections", () => {
  it("loads each section once, by its href with the page's date, and draws it below the page with Gridtop's renderer", async () => {
    withPage(PAGE);
    const load = answer(READY);
    await shell();
    const table = await screen.findByRole("table");
    expect(load.mock.calls).toEqual([[SAVINGS_HREF]]);
    const main = screen.getByRole("main");
    const page = screen.getByText("The page");
    expect(main.contains(table)).toBe(true);
    expect(page.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What the site saved" })).toBeTruthy();
  });

  it("shows a loading block until the section arrives", async () => {
    withPage(PAGE);
    let resolve: (m: ViewModel) => void = () => {};
    answer(new Promise<ViewModel>((r) => (resolve = r)));
    await shell();
    await waitFor(() => expect(screen.getByRole("status", { name: "Loading What the site saved" })).toBeTruthy());
    resolve(READY);
    await screen.findByRole("table");
    expect(screen.queryByRole("status", { name: "Loading What the site saved" })).toBeNull();
  });

  it("shows the host's message in place of a refused section, and keeps the page", async () => {
    withPage(PAGE);
    answer({ type: "result", ok: false, status: 503, code: "gui_view_refused", message: "Could not load the savings settings" });
    await shell();
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load the savings settings");
    expect(screen.getByText("The page")).toBeTruthy();
  });

  it("says a section could not be loaded when the request fails, and keeps the page", async () => {
    withPage(PAGE);
    vi.spyOn(kit, "loadView").mockImplementation(async () => {
      throw new Error("offline");
    });
    await shell();
    expect((await screen.findByRole("alert")).textContent).toBe("This section could not be loaded.");
    expect(screen.queryByRole("status", { name: "Loading What the site saved" })).toBeNull();
    expect(screen.getByText("The page")).toBeTruthy();
  });

  it("loads the new day's section when the page's date changes, and drops the old day's figures", async () => {
    const NEXT_HREF = "/microgrids/m1/operations/savings?date=2026-11-06" as const;
    let page: ViewModel = PAGE;
    const real = kit.useView;
    vi.spyOn(kit, "useView").mockImplementation((): ViewState => ({ ...real(), model: page }));
    const next = savings({ ...(READY.ext!.data as object), columns: [{ id: "day", label: "6 Nov", sub: null }] });
    const load = vi.spyOn(kit, "loadView").mockImplementation(async (href) => (href === NEXT_HREF ? next : READY));
    await shell();
    await screen.findByRole("columnheader", { name: "5 Nov" });
    page = { ...PAGE, attached: PAGE.attached.map((a) => (a.hint === "section" ? { ...a, href: NEXT_HREF } : a)) };
    await rendered!.goTo("/microgrids/m1/operations");
    await screen.findByRole("columnheader", { name: "6 Nov" });
    expect(load.mock.calls).toEqual([[SAVINGS_HREF], [NEXT_HREF]]);
    expect(screen.queryByRole("columnheader", { name: "5 Nov" })).toBeNull();
  });

  it("loads a section again when the page's model is refreshed at the same href, and keeps the old figures until the new ones arrive", async () => {
    let page: ViewModel = PAGE;
    const real = kit.useView;
    vi.spyOn(kit, "useView").mockImplementation((): ViewState => ({ ...real(), model: page }));
    const updated = savings({ ...(READY.ext!.data as object), columns: [{ id: "day", label: "5 Nov, so far", sub: null }] });
    let resolve: (m: ViewModel) => void = () => {};
    const load = vi
      .spyOn(kit, "loadView")
      .mockImplementationOnce(async () => READY)
      .mockImplementationOnce(() => new Promise<ViewModel>((r) => (resolve = r)));
    await shell();
    await screen.findByRole("columnheader", { name: "5 Nov" });
    // What kit.refresh() or a finished action leaves: a new page model, the same section href.
    page = { ...PAGE };
    await rendered!.goTo("/microgrids/m1/operations");
    await waitFor(() => expect(load.mock.calls).toEqual([[SAVINGS_HREF], [SAVINGS_HREF]]));
    expect(screen.getByRole("columnheader", { name: "5 Nov" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading What the site saved" })).toBeNull();
    resolve(updated);
    await screen.findByRole("columnheader", { name: "5 Nov, so far" });
    expect(screen.queryByRole("columnheader", { name: "5 Nov" })).toBeNull();
  });

  it("contains a section that fails to draw, and keeps the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withPage(PAGE);
    // Version 1 by name, but not its shape: the renderer throws.
    answer(savings({ state: "ready" }));
    await shell();
    await screen.findByText("What the site saved could not be shown.");
    expect(screen.getByText("The page")).toBeTruthy();
  });

  it("draws a section with no renderer for its ext version with the kit's view", async () => {
    withPage(PAGE);
    answer(savings({ state: "ready" }, "billing.savings@2"));
    await shell();
    await waitFor(() => expect(document.querySelector('[data-gui-view="billing.savings"]')).not.toBeNull());
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("loads nothing on a page outside the contract, or for views attached as tabs only", async () => {
    const load = answer(READY);
    withPage(null);
    await shell();
    rendered!.unmount();
    vi.mocked(kit.useView).mockRestore();
    withPage({ ...PAGE, attached: PAGE.attached.filter((a) => a.hint === "tab") });
    await shell();
    expect(load).not.toHaveBeenCalled();
  });

  it("picks Gridtop's renderer only for an ext version it reads", () => {
    expect(rendererFor(READY, GridtopGui.renderers!)).toBe(GridtopGui.renderers!["billing.savings"]);
    expect(rendererFor(savings({}, "billing.savings@2"), GridtopGui.renderers!)).toBeNull();
    expect(rendererFor({ ...READY, ext: undefined }, GridtopGui.renderers!)).toBeNull();
    expect(rendererFor({ ...READY, view: "acme.notes" }, GridtopGui.renderers!)).toBeNull();
  });
});

/**
 * Gridtop's renderer of `billing.savings@1`: the Operations page's savings
 * table drawn from the tiles and the ext, the setup note with its link, and
 * nothing for the unavailable state. Models are written here, since a GUI's
 * tests import no capability (gui-boundary.test.ts); the view's own examples
 * go through every installed GUI in src/lib/gui/__tests__/view-examples.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelView, checkModel, renderModel, renderShell, withPoke, POKE_LABEL } from "@/lib/gui/conformance";
import type { ActionResult, GuiKit, LinkRef, ModelOf, Value, ViewModel, ViewState } from "@/lib/gui/contract";
import { kit as realKit } from "@/lib/gui/kit";
import { GridtopGui } from "..";
import { EAST, EAST_TRAIL, KASANA, ORG, placesFixture } from "./places-fixture";
import SavingsView from "../renderers/savings/savings-view";

const money = (v: number): Value => ({ t: "money", v, currency: "UGX", text: `UGX ${v.toLocaleString("en-GB")}`, derived: true });
const EMPTY: Value = { t: "empty", text: "—" };
const tile = (key: string, value: Value) => ({ key, label: key, value });

function model(over: Partial<ModelOf<"metrics">> & { ext: ModelOf<"metrics">["ext"] }): ModelOf<"metrics"> {
  return {
    type: "view",
    view: "billing.savings",
    kind: "metrics",
    title: "What the site saved",
    org: "o1",
    entity: { kind: "microgrid", id: "00000000-0000-4000-8000-0000000000b1", label: "North" },
    trail: [],
    body: { tiles: [] },
    actions: [],
    links: [],
    attached: [],
    ...over,
  };
}

const READY = model({
  body: {
    tiles: [
      tile("day.solar", money(660)),
      tile("day.arbitrage", EMPTY),
      tile("day.total", money(661)),
      tile("day.lights-on", { t: "percent", v: 98.25, text: "98.3%" }),
      tile("month.solar", money(3960)),
      tile("month.arbitrage", money(-310)),
      tile("month.total", money(3650)),
      tile("month.lights-on", { t: "percent", v: 99, text: "99.0%" }),
      tile("since.solar", money(120400)),
      tile("since.arbitrage", money(18220)),
      tile("since.total", money(138620)),
      tile("since.lights-on", EMPTY),
    ],
  },
  ext: {
    schema: "billing.savings@1",
    data: {
      state: "ready",
      synthetic: false,
      columns: [
        { id: "day", label: "5 Nov", sub: null },
        { id: "month", label: "November so far", sub: null },
        { id: "since", label: "Since start", sub: "from 1 Oct 2026" },
      ],
      rows: [
        { id: "solar", label: "Solar savings ≈", sub: "valued at the grid rate of each hour, since 1 Oct 2026", strong: false },
        { id: "arbitrage", label: "Arbitrage gain ≈", sub: "not counted: no start date set", strong: false },
        { id: "total", label: "Total saved", sub: null, strong: true },
        { id: "lights-on", label: "Lights on (%)", sub: null, strong: false },
      ],
      warnings: [
        "3 days had no grid tariff in force and are left out of the money figures.",
        "Since start covers at most a year: days before 6 Nov 2025 are not read.",
      ],
      notes: ["Solar savings is every kWh.", "Arbitrage gain is the battery.", "Solar that charged the battery."],
    },
  },
});

const SETUP = model({
  body: { tiles: [{ key: "setup", label: "Count what the site saves", value: { t: "text", text: "Enter the grid tariff." } }] },
  links: [{ id: "billing.setup-rates", label: "Go to Setup > Rates", href: "/microgrids/m1/setup/rates" }],
  ext: { schema: "billing.savings@1", data: { state: "setup", synthetic: false, title: "Count what the site saves", text: "Enter the grid tariff." } },
});

const UNAVAILABLE = model({ ext: { schema: "billing.savings@1", data: { state: "unavailable", synthetic: false } } });

const markSynthetic = (m: ModelOf<"metrics">): ModelOf<"metrics"> => ({
  ...m,
  body: { ...m.body, tiles: m.body.tiles.map((t) => ({ ...t, value: { ...t.value, synthetic: true } })) },
  ext: { ...m.ext!, data: { ...(m.ext!.data as object), synthetic: true } },
});

/** Renders as production picks the renderer, and waits for the table, which loads on demand. */
async function draw(m: ViewModel) {
  const rendered = await renderModel(GridtopGui, m);
  await screen.findByText("What the site saved", {}, { timeout: 5000 }).catch(() => null);
  return rendered;
}

// The renderer loads the table on its first use; the static import of it
// above means each render finds it ready.
afterEach(() => document.body.replaceChildren());

describe("the savings renderer", () => {
  it("is Gridtop's renderer for billing.savings, reading ext version 1", () => {
    expect(GridtopGui.renderers?.["billing.savings"]?.reads).toEqual([1]);
  });

  it("draws the page's table from the tiles by key, with its headings, warnings and notes", async () => {
    const { log, unmount } = await draw(READY);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Figure", "5 Nov", "November so far", "Since startfrom 1 Oct 2026"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      "Solar savings ≈valued at the grid rate of each hour, since 1 Oct 2026",
      "Arbitrage gain ≈not counted: no start date set",
      "Total saved",
      "Lights on (%)",
    ]);
    const cells = (i: number) => within(rows[i]).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(0)).toEqual(["UGX 660estimated", "UGX 3,960estimated", "UGX 120,400estimated"]);
    expect(cells(1)).toEqual(["—", "UGX -310estimated", "UGX 18,220estimated"]);
    expect(cells(3)).toEqual(["98.3%", "99.0%", "—"]);
    expect(screen.getByText("3 days had no grid tariff in force and are left out of the money figures.")).toBeTruthy();
    expect(screen.getByText("Since start covers at most a year: days before 6 Nov 2025 are not read.")).toBeTruthy();
    for (const note of ["Solar savings is every kWh.", "Arbitrage gain is the battery.", "Solar that charged the battery."]) {
      expect(screen.getByText(note)).toBeTruthy();
    }
    expect(table.parentElement?.className).toContain("gt:overflow-x-auto");
    expect(log.act).toEqual([]);
    unmount();
  });

  it("marks each synthetic figure", async () => {
    const { unmount } = await draw(markSynthetic(READY));
    expect(within(screen.getAllByRole("row")[1]).getAllByText("Synthetic")).toHaveLength(3);
    unmount();
  });

  it("shows the setup note with its link to Setup > Rates, and no other control", async () => {
    const { unmount } = await draw(SETUP);
    await screen.findByText("Count what the site saves");
    expect(screen.getByText("Enter the grid tariff.")).toBeTruthy();
    expect(screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Go to Setup > Rates", "/microgrids/m1/setup/rates"],
    ]);
    unmount();
  });

  it("draws nothing while the day above explains why there are no figures", async () => {
    const { unmount } = await renderModel(GridtopGui, UNAVAILABLE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.body.textContent).toBe("");
    unmount();
  });

  it("leaves a later ext version, and a model with none, to the kit's view", async () => {
    for (const m of [{ ...READY, ext: { ...READY.ext!, schema: "billing.savings@2" as const } }, { ...READY, ext: undefined }]) {
      const { unmount } = await renderModel(GridtopGui, m);
      expect(document.querySelector('[data-gui-view="billing.savings"]')).not.toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
      unmount();
    }
  });

  it("offers the model's actions, calling kit.act with the exact ref only when pressed", async () => {
    const poked = withPoke(READY);
    expect(poked.actions.map((a) => a.action)).toEqual(["acme.poke"]);
    const { log, unmount } = await draw(poked);
    expect(log.act).toEqual([]);
    screen.getByRole("button", { name: POKE_LABEL }).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.act).toEqual([poked.actions[0]]);
    unmount();
  });

  it.each([
    ["ready", READY],
    ["ready, synthetic", markSynthetic(READY)],
    ["setup", SETUP],
    ["unavailable", UNAVAILABLE],
  ])("passes the conformance view checks, with acme.poke offered: %s", async (name, m) => {
    const poked = withPoke(m);
    expect(poked.actions).toHaveLength(1);
    expect(await checkModel(GridtopGui, poked, name)).toEqual([]);
  });
});

/** A kit for drawing the table directly: `page` is the page's own model, act and open are recorded. */
function fakeKit(page: ViewModel | null, result: ActionResult = { type: "result", ok: true }) {
  const kit = {
    useView: () => ({ model: page }) as ViewState,
    act: vi.fn(async () => result),
    open: vi.fn<(link: LinkRef) => Promise<void>>(async () => {}),
    Link: ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => (
      <a href={href} className={className}>
        {children}
      </a>
    ),
  };
  return kit as typeof kit & GuiKit;
}
const MORE: LinkRef = { id: "acme.more", label: "More", href: "/microgrids/m1/more" };
const TOUCH = "gt:pointer-coarse:min-h-11";

describe("the savings table's own controls", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not press a disabled action, and says why it is disabled", () => {
    const poked = withPoke(READY);
    const disabled = { ...poked, actions: [{ ...poked.actions[0], enabled: false, reason: "Not now." }] };
    const kit = fakeKit(null);
    render(<SavingsView model={disabled} kit={kit} />);
    const button = screen.getByRole("button", { name: POKE_LABEL }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(kit.act).not.toHaveBeenCalled();
    expect(screen.getByText("Not now.")).toBeTruthy();
  });

  it("shows a failed action's message, but nothing when the person cancels", async () => {
    const poked = withPoke(READY);
    const cancelled = fakeKit(null, { type: "result", ok: false, status: 0, code: "cancelled", message: "Cancelled." });
    const { unmount } = render(<SavingsView model={poked} kit={cancelled} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: POKE_LABEL })));
    expect(cancelled.act).toHaveBeenCalledWith(poked.actions[0]);
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();
    const failed = fakeKit(null, { type: "result", ok: false, status: 503, code: "gui_action_failed", message: "Could not poke." });
    render(<SavingsView model={poked} kit={failed} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: POKE_LABEL })));
    expect(screen.getByRole("alert").textContent).toBe("Could not poke.");
  });

  it("opens a link through the kit, but leaves a modified click to the browser", () => {
    const kit = fakeKit(null);
    render(<SavingsView model={{ ...READY, links: [MORE] }} kit={kit} />);
    const link = screen.getByRole("link", { name: "More" });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      fireEvent.click(link, modifier);
    }
    expect(kit.open).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(kit.open).toHaveBeenCalledWith(MORE);
  });

  it("leaves the controls and the setup link to the window bar on the page's own view", () => {
    const poked = withPoke(READY);
    const { unmount } = render(<SavingsView model={{ ...poked, links: [MORE] }} kit={fakeKit(poked)} />);
    expect(screen.queryByRole("button", { name: POKE_LABEL })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    unmount();
    render(<SavingsView model={SETUP} kit={fakeKit(SETUP)} />);
    expect(screen.getByText("Count what the site saves")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("gives every control a 44 px touch target on a coarse pointer", () => {
    const { unmount } = render(<SavingsView model={{ ...withPoke(READY), links: [MORE] }} kit={fakeKit(null)} />);
    expect(screen.getByRole("button", { name: POKE_LABEL }).className).toContain(TOUCH);
    expect(screen.getByRole("link", { name: "More" }).className).toContain(TOUCH);
    unmount();
    render(<SavingsView model={SETUP} kit={fakeKit(null)} />);
    expect(screen.getByRole("link", { name: "Go to Setup > Rates" }).className).toContain(TOUCH);
  });
});

describe("the savings page in the shell", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  const fixture = () =>
    placesFixture({
      pathname: "/microgrids/m1/operations/savings",
      initial: { view: "billing.savings", title: "Savings", trail: EAST_TRAIL, tabs: [], scope: { organization: ORG, community: KASANA, microgrid: EAST } },
    });
  /** Renders the shell with `m` as the page's view, and waits for the renderer's chunk to draw `shows`. */
  async function page(m: ViewModel, shows: string) {
    const real = realKit.useView;
    vi.spyOn(realKit, "useView").mockImplementation((): ViewState => ({ ...real(), model: m }));
    await renderShell(GridtopGui, fixture(), <ModelView gui={GridtopGui} model={m} />);
    await waitFor(() => expect(screen.getByText(shows)).toBeTruthy());
  }

  // Gridtop draws the page with its own renderer, which leaves the page's controls to the window bar.
  it("offers each action and link once, from the window bar", async () => {
    const m = { ...withPoke(READY), links: [MORE] };
    await page(m, "Since start");
    const bar = document.querySelector<HTMLElement>("[data-window-bar]")!;
    expect(within(bar).getByRole("button", { name: "Actions" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: POKE_LABEL })).toHaveLength(1);
    expect(within(bar).getByRole("button", { name: POKE_LABEL })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "More" })).toHaveLength(1);
  });

  it("offers the setup link once, from the window bar", async () => {
    await page(SETUP, "Count what the site saves");
    const bar = document.querySelector<HTMLElement>("[data-window-bar]")!;
    expect(screen.getAllByRole("link", { name: "Go to Setup > Rates" })).toHaveLength(1);
    expect(within(bar).getByRole("link", { name: "Go to Setup > Rates" })).toBeTruthy();
  });
});

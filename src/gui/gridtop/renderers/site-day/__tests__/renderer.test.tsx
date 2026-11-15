/**
 * Gridtop's renderer for `metering.site-day@1`: when Gridtop picks it, what
 * it draws around the tiles, how it writes, and that inside the shell
 * nothing is drawn twice.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelView, POKE_ACTION, POKE_LABEL, renderInKit, renderShell, withPoke, type Recorded } from "@/lib/gui/conformance";
import type { ActionRef, ActionResult, LinkRef, ViewModel, ViewState } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "../../..";
import { EAST, EAST_TRAIL, KASANA, ORG, placesFixture } from "../../../__tests__/places-fixture";
import { GRIDTOP_RENDERERS, drawnBespoke } from "../..";
import { readSiteDayExt } from "../ext";
import { SiteDayView } from "../renderer";
import { MG, NOTES, SYNTHETIC_NOTICE, dayModel, noSiteDevicesModel } from "./site-day-fixture";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

async function draw(model: ViewModel): Promise<Recorded> {
  const rendered = await renderInKit(<SiteDayView model={model} kit={kit} />);
  unmount = rendered.unmount;
  return rendered.log;
}
const text = () => document.body.textContent ?? "";
const count = (needle: string) => text().split(needle).length - 1;

const DISABLED: ActionRef = { action: "metering.refresh", params: { microgrid: MG }, label: "Refresh", enabled: false, reason: "Metering is off" };
const EXPORT: LinkRef = { id: "metering.export", label: "Export CSV", href: `/microgrids/${MG}/operations?format=csv`, download: { mime: "text/csv", filename: "day.csv" } };
const RATES: LinkRef = { id: "metering.rates", label: "Rates", href: `/microgrids/${MG}/setup/rates` };
const SHARE: LinkRef = { id: "metering.share", label: "Share", href: `/microgrids/${MG}/operations`, share: { title: "Operations", text: "The day" } };
const OUTSIDE: LinkRef = { id: "metering.call", label: "Call the operator", href: "tel:+10000000000" };
const FAILED: ActionResult = { type: "result", ok: false, status: 500, code: "failed", message: "Refresh failed" };
const CANCELLED: ActionResult = { type: "result", ok: false, status: 0, code: "cancelled", message: "Cancelled" };
const versioned = (schema: `${string}.${string}@${number}`): ViewModel => ({ ...dayModel(), ext: { ...dayModel().ext!, schema } });

describe("Gridtop's site-day renderer", () => {
  it("is registered for version 1 in the table the window bar checks, which marks it as placing its own controls", () => {
    expect(GridtopGui.renderers).toBe(GRIDTOP_RENDERERS);
    expect(GRIDTOP_RENDERERS["metering.site-day"].reads).toEqual([1]);
    expect(drawnBespoke(dayModel())).toBe(true);
    expect(drawnBespoke(versioned("metering.site-day@2"))).toBe(false);
    expect(drawnBespoke({ ...dayModel(), ext: undefined })).toBe(false);
    expect(drawnBespoke({ ...dayModel(), view: "billing.periods" })).toBe(false);
    // Drawn bespoke too, but on its own page it leaves its controls to the window bar.
    expect(drawnBespoke({ view: "billing.savings", ext: { schema: "billing.savings@1", data: {} } })).toBe(false);
  });

  it("draws version 1 itself, once its chunk loads, and leaves @2 or no ext to the kit's view", async () => {
    unmount = (await renderInKit(<ModelView gui={GridtopGui} model={dayModel()} />)).unmount;
    await waitFor(() => expect(document.querySelector("[data-tile='solar']")).not.toBeNull());
    unmount();
    for (const model of [versioned("metering.site-day@2"), { ...dayModel(), ext: undefined }]) {
      unmount = (await renderInKit(<ModelView gui={GridtopGui} model={model} />)).unmount;
      expect(document.querySelector("[data-tile]")).toBeNull();
      expect(document.querySelector("[data-gui-kind='metrics']")).not.toBeNull();
      unmount();
    }
    unmount = null;
  });

  it("draws a model whose ext it cannot read with the kit's view", async () => {
    await draw({ ...dayModel(), ext: { schema: "metering.site-day@1", data: { state: "day" } } });
    expect(document.querySelector("[data-tile]")).toBeNull();
    expect(document.querySelector("[data-gui-kind='metrics']")).not.toBeNull();
  });

  it.each([
    ["an outside day href", { dayHref: "https://example.org/x" }],
    ["a synthetic flag that is not a boolean", { synthetic: "yes" }],
    ["a note that is not text", { notes: [1] }],
    ["a date with text around it", { date: "x2026-11-05" }],
    ["a today with text around it", { today: "2026-11-07x" }],
  ])("reads no ext with %s", (_, data) => {
    expect(readSiteDayExt(dayModel({ ext: data }).ext)).toBeNull();
  });

  it("reads the ext as the server sends it", () => {
    expect(readSiteDayExt(dayModel().ext)).toMatchObject({ state: "day", date: "2026-11-05", dayHref: `/microgrids/${MG}/operations` });
    expect(readSiteDayExt(noSiteDevicesModel().ext)).toMatchObject({ state: "no-site-devices" });
  });

  it("heads the day without the zone the window bar shows, and keeps the title for assistive tech", async () => {
    await draw(dayModel());
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("gt:sr-only");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Thu, 05 Nov 2026");
  });

  // Legacy: "shows the partial-day note for today, up to the time read".
  it("heads today with how far it was read", async () => {
    await draw(dayModel({ date: "2026-11-07", subtitle: "Today so far, up to 14:30 · Africa/Kampala" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Today so far, up to 14:30");
  });

  // Legacy: footnote, missing-data note and definitions; now the server's notes.
  it("prints the notes", async () => {
    await draw(dayModel({ notes: ["No data for 30m.", ...NOTES] }));
    expect(text()).toContain("No data for 30m.");
    expect(text()).toContain("Times are Africa/Kampala.");
  });

  it("calls nothing on mount, and acts with the very ref the model gave", async () => {
    const poked = withPoke(dayModel());
    const log = await draw(poked);
    expect(log.act).toEqual([]);
    const ref = poked.actions.find((a) => a.action === POKE_ACTION)!;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: POKE_LABEL })));
    expect(log.act).toHaveLength(1);
    expect(log.act[0]).toBe(ref);
  });

  it("shows why an action is unavailable instead of offering it, and ties the reason to the button", async () => {
    const log = await draw(dayModel({ actions: [DISABLED] }));
    const button = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe("Metering is off");
    await act(async () => fireEvent.click(button));
    expect(log.act).toEqual([]);
  });

  it("marks a danger action with the destructive tone", async () => {
    await draw(dayModel({ actions: [{ ...DISABLED, enabled: true, reason: undefined, tone: "danger", label: "Clear" }] }));
    expect(screen.getByRole("button", { name: "Clear" }).className).toContain("gt:text-destructive-fg");
  });

  describe("an action's outcome", () => {
    const poked = () => withPoke(dayModel());
    const poke = () => screen.getByRole("button", { name: POKE_LABEL }) as HTMLButtonElement;
    async function drawActing(result: Promise<ActionResult>) {
      const actSpy = vi.fn<(ref: ActionRef) => Promise<ActionResult>>(() => result);
      unmount = (await renderInKit(<SiteDayView model={poked()} kit={{ ...kit, act: actSpy }} />)).unmount;
      return actSpy;
    }

    it("shows a failed action's message", async () => {
      await drawActing(Promise.resolve(FAILED));
      await act(async () => fireEvent.click(poke()));
      expect(screen.getByRole("status").textContent).toBe("Refresh failed");
    });

    it("says nothing when the person cancels", async () => {
      await drawActing(Promise.resolve(CANCELLED));
      await act(async () => fireEvent.click(poke()));
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("holds the button while the action runs, so a second press sends nothing", async () => {
      let finish: (r: ActionResult) => void = () => {};
      const actSpy = await drawActing(new Promise<ActionResult>((resolve) => (finish = resolve)));
      await act(async () => fireEvent.click(poke()));
      expect(poke().disabled).toBe(true);
      expect(poke().getAttribute("aria-busy")).toBe("true");
      await act(async () => fireEvent.click(poke()));
      expect(actSpy).toHaveBeenCalledTimes(1);
      await act(async () => finish({ type: "result", ok: true }));
      expect(poke().disabled).toBe(false);
    });
  });

  it("offers each link the picker does not place, once: a page as a link; a download, a share or an outside target through kit.open", async () => {
    const log = await draw(dayModel({ links: [EXPORT, SHARE, OUTSIDE, RATES, ...dayModel().links] }));
    expect(screen.getAllByRole("link", { name: "Rates" }).map((a) => a.getAttribute("href"))).toEqual([RATES.href]);
    expect(screen.getAllByRole("link", { name: "Previous day" })).toHaveLength(1);
    for (const ref of [EXPORT, SHARE, OUTSIDE]) {
      expect(screen.queryByRole("link", { name: ref.label })).toBeNull();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: ref.label })));
    }
    expect(log.open).toEqual([EXPORT, SHARE, OUTSIDE]);
  });

  it("lists views attached as tiles, and leaves tabs to the window bar and sections to the content frame", async () => {
    await draw(
      dayModel({
        attached: [
          { view: "billing.savings", title: "Savings", href: `/microgrids/${MG}/operations/savings`, hint: "section" },
          { view: "acme.notes", title: "Notes", href: `/microgrids/${MG}/notes`, hint: "tab" },
          { view: "acme.log", title: "Log", href: `/microgrids/${MG}/log`, hint: "tile" },
        ],
      }),
    );
    const related = within(screen.getByRole("navigation", { name: "Related views" }));
    expect(related.getByRole("link", { name: "Log" }).getAttribute("href")).toBe(`/microgrids/${MG}/log`);
    expect(related.queryByRole("link", { name: "Savings" })).toBeNull();
    expect(related.queryByRole("link", { name: "Notes" })).toBeNull();
  });

  // Legacy: "labels a synthetic day with a Synthetic data banner" and "shows no Synthetic data banner for a day read from meters".
  it("bands a synthetic day once, and never a measured one", async () => {
    await draw(dayModel({ synthetic: true }));
    expect(count("Synthetic data: generated for demonstration, not measured")).toBe(1);
    unmount?.();
    await draw(dayModel({ synthetic: true, notice: SYNTHETIC_NOTICE }));
    expect(count(SYNTHETIC_NOTICE.text)).toBe(1);
    expect(count("Synthetic data: generated for demonstration")).toBe(0);
    unmount?.();
    await draw(dayModel());
    expect(text()).not.toMatch(/synthetic/i);
  });

  it("shows any other notice, and still bands a synthetic day under it", async () => {
    await draw(dayModel({ synthetic: true, notice: { tone: "info", text: "Readings arrive every 5 minutes." } }));
    expect(count("Readings arrive every 5 minutes.")).toBe(1);
    expect(count("Synthetic data: generated for demonstration, not measured")).toBe(1);
  });

  it(`shows the legacy empty state when no battery or grid meter is registered`, async () => {
    await draw(noSiteDevicesModel());
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(`Register the battery and grid meter`);
    expect(text()).toContain(`This view reads the site's battery and grid meter from OpenEMS.`);
    expect(screen.getAllByRole("link", { name: "Go to Edges" }).map((a) => a.getAttribute("href"))).toEqual([`/microgrids/${MG}/setup/edges`]);
    expect(screen.getByRole("link", { name: "Previous day" })).toBeTruthy();
    expect(document.querySelector("[data-tile]")).toBeNull();
  });

  it("uses token colour classes only", async () => {
    const palette = /\b(?:bg|text|fill|stroke|border)-(?:red|blue|green|gray|slate|zinc|amber|orange|yellow|emerald)-\d/;
    for (const model of [dayModel({ synthetic: true, actions: [DISABLED] }), noSiteDevicesModel()]) {
      await draw(model);
      expect(document.body.innerHTML).not.toMatch(palette);
      unmount?.();
    }
    unmount = null;
  });
});

describe("Gridtop's window bar over a bespoke renderer", () => {
  const fixture = () =>
    placesFixture({
      pathname: `/microgrids/m1/operations`,
      initial: { view: "metering.site-day", title: "Operations", trail: EAST_TRAIL, tabs: [], scope: { organization: ORG, community: KASANA, microgrid: EAST } },
    });
  function withModel(model: ViewModel) {
    const real = kit.useView;
    vi.spyOn(kit, "useView").mockImplementation((): ViewState => ({ ...real(), model }));
  }

  it("shows the title and subtitle, and leaves the actions and links to the renderer, so each is drawn once", async () => {
    const model = withPoke(dayModel({ links: [EXPORT, ...dayModel().links] }));
    withModel(model);
    const rendered = await renderShell(GridtopGui, fixture(), <ModelView gui={GridtopGui} model={model} />);
    unmount = rendered.unmount;
    await waitFor(() => expect(document.querySelector("[data-tile='solar']")).not.toBeNull());
    const bar = document.querySelector<HTMLElement>("[data-window-bar]")!;
    expect(bar.textContent).toContain("Operations");
    expect(bar.textContent).toContain("Thu, 05 Nov 2026 · Africa/Kampala");
    expect(within(bar).queryByRole("button", { name: "Actions" })).toBeNull();
    for (const name of [POKE_LABEL, "Export CSV"]) expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    for (const name of ["Previous day", "Today"]) expect(screen.getAllByRole("link", { name })).toHaveLength(1);
  });

  it("still shows a generic view's actions and links", async () => {
    const model = withPoke({ ...dayModel({ links: [EXPORT] }), ext: undefined });
    withModel(model);
    unmount = (await renderShell(GridtopGui, fixture(), <p>The page</p>)).unmount;
    const bar = document.querySelector<HTMLElement>("[data-window-bar]")!;
    expect(within(bar).getAllByText("Export CSV").length).toBeGreaterThan(0);
  });
});

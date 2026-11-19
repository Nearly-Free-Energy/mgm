/**
 * Gridtop's renderers for `tenant.usage-month@1` and `tenant.usage-day@1`:
 * when Gridtop picks them, when it leaves a model to the kit's view, how
 * they write, their classes, and that inside the shell nothing is drawn
 * twice and the unit is named under a staff manifest too.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANIFEST_FIXTURES, ModelView, POKE_ACTION, POKE_LABEL, renderInKit, renderShell, withPoke, type ManifestFixture } from "@/lib/gui/conformance";
import type { ActionRef, LinkRef, ModelOf, ViewModel, ViewState } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "../../..";
import { GRIDTOP_RENDERERS, drawnBespoke } from "../..";
import { UsageDayView, UsageMonthView } from "../renderer";
import { tokens } from "./classes";
import { dayHref, dayModel, mismatch, monthModel, withExt } from "./usage-fixture";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

const versioned = (model: ModelOf<"collection">, version: number): ViewModel => ({
  ...model,
  ext: { ...model.ext!, schema: `${model.view}@${version}` as `${string}.${string}@${number}` },
});
const bespoke = (name: "month" | "day") => document.querySelector(`[data-gridtop-renderer='tenant-usage-${name}']`);
/** What only the bespoke views draw: the calendar or hour list's caption, and the day's bars. */
const bespokeMarks = () => ({
  calendar: screen.queryByRole("table", { name: /^Use per day, / }),
  hours: screen.queryByRole("table", { name: /^Use per hour, / }),
  bars: document.querySelector("figure[aria-hidden='true'] svg"),
});

const DISABLED: ActionRef = { action: "acme.reset", params: {}, label: "Reset", enabled: false, reason: "Not for tenants" };

describe("registration", () => {
  it("registers both views for version 1, as views that place their own controls", () => {
    expect(GRIDTOP_RENDERERS["tenant.usage-month"].reads).toEqual([1]);
    expect(GRIDTOP_RENDERERS["tenant.usage-day"].reads).toEqual([1]);
    for (const model of [monthModel(), dayModel()]) {
      expect(drawnBespoke(model)).toBe(true);
      expect(drawnBespoke(versioned(model, 2))).toBe(false);
      expect(drawnBespoke({ ...model, ext: undefined })).toBe(false);
    }
  });
});

describe.each([
  ["month", monthModel, "calendar"] as const,
  ["day", dayModel, "hours"] as const,
])("Gridtop's tenant %s through the host's choice", (name, build, mark) => {
  it("draws version 1 itself once its chunk loads", async () => {
    unmount = (await renderInKit(<ModelView gui={GridtopGui} model={build()} />)).unmount;
    await waitFor(() => expect(bespoke(name)).not.toBeNull());
    expect(bespokeMarks()[mark]).not.toBeNull();
    if (name === "day") expect(bespokeMarks().bars).not.toBeNull();
  });

  const fallbacks: [string, () => ViewModel][] = [
    ["@2", () => versioned(build(), 2)],
    ["no ext", () => ({ ...build(), ext: undefined })],
    ["a malformed ext", () => withExt(build(), { total: null })],
    ["a problem of a kind it does not know", () => withExt(build(), { problem: { kind: "offline", title: "No data", message: "Off" } })],
    ["a missing row", () => mismatch(build(), "missing")],
    ["an extra row", () => mismatch(build(), "extra")],
    ["a row on a future bucket", () => mismatch(build(), "future")],
  ];
  it.each(fallbacks)("leaves a model with %s to the kit's view", async (_, model) => {
    unmount = (await renderInKit(<ModelView gui={GridtopGui} model={model()} />)).unmount;
    // Give a chunk that would load the time to.
    await waitFor(() => expect(document.querySelector("[data-gui-kind='collection']")).not.toBeNull());
    expect(document.querySelector("[data-gridtop-renderer]")).toBeNull();
    expect(bespokeMarks()).toEqual({ calendar: null, hours: null, bars: null });
  });
});

describe.each([
  ["month", UsageMonthView, monthModel] as const,
  ["day", UsageDayView, dayModel] as const,
])("Gridtop's tenant %s controls", (_name, View, build) => {
  async function draw(model: ViewModel) {
    const rendered = await renderInKit(<View model={model} kit={kit} />);
    unmount = rendered.unmount;
    return rendered.log;
  }

  it("calls nothing on mount, and acts with the very ref the model gave", async () => {
    const poked = withPoke(build());
    const log = await draw(poked);
    expect(log.act).toEqual([]);
    const ref = poked.actions.find((a) => a.action === POKE_ACTION)!;
    expect(ref).toBeDefined();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: POKE_LABEL })));
    expect(log.act).toHaveLength(1);
    expect(log.act[0]).toBe(ref);
  });

  it("shows why an action is unavailable instead of offering it", async () => {
    const log = await draw({ ...build(), actions: [DISABLED] });
    const button = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Not for tenants");
    await act(async () => fireEvent.click(button));
    expect(log.act).toEqual([]);
  });

  it("draws a link to a page the view already links once, and any other link among the controls", async () => {
    const model = build();
    const previous = (model.ext!.data as { previous: { href: `/${string}` } }).previous.href;
    const SAME: LinkRef = { id: "tenant.previous", label: "Earlier", href: previous };
    const HELP: LinkRef = { id: "tenant.help", label: "Help with your meter", href: "/my/help" };
    await draw({ ...model, links: [SAME, HELP] });
    expect([...document.querySelectorAll(`a[href='${previous}']`)]).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Earlier" })).toBeNull();
    const controls = screen.getByRole("region", { name: "Actions and links" });
    expect(within(controls).getByRole("link", { name: HELP.label }).getAttribute("href")).toBe("/my/help");
  });

  it("uses Gridtop's token classes only", async () => {
    const palette = /^gt:(?:[\w-]+:)*(?:bg|text|fill|stroke|border|outline)-(?:red|blue|green|gray|slate|zinc|amber|orange|yellow|emerald|white|black)\b/;
    const arbitraryColour = /^gt:(?:[\w-]+:)*(?:bg|text|fill|stroke|border)-\[/;
    const models = [withPoke(build({ synthetic: true, stale: true })), build({ problem: "unavailable" }), build({ several: true })];
    for (const model of models) {
      await draw(model);
      const article = document.querySelector("article")!;
      for (const el of [article, ...article.querySelectorAll("*")]) {
        for (const t of tokens(el)) {
          expect(t.startsWith("gt:"), `${t} on <${el.tagName.toLowerCase()}>`).toBe(true);
          expect(t).not.toMatch(palette);
          expect(t).not.toMatch(arbitraryColour);
        }
      }
      unmount?.();
    }
    unmount = null;
  });

  it("makes every link and button at least 44 px high on a touch screen, and the icon-only steps 44 px wide", async () => {
    const TALL = /^gt:(?:pointer-coarse:)?(?:min-h|h|size|leading)-(\d+)$/;
    const WIDE = /^gt:(?:pointer-coarse:)?(?:min-w|w|size)-(\d+|full)$/;
    const tall = (el: Element) => tokens(el).some((t) => Number(TALL.exec(t)?.[1] ?? 0) >= 11);
    const wide = (el: Element) => tokens(el).some((t) => {
      const m = WIDE.exec(t)?.[1];
      return m === "full" || Number(m ?? 0) >= 11;
    });
    await draw(withPoke(build({ problem: "unavailable", links: [{ id: "tenant.help", label: "Help", href: "/my/help" }] })));
    const controls = [...document.querySelectorAll("article a, article button")];
    expect(controls.length).toBeGreaterThan(4);
    for (const el of controls) expect(tall(el), el.outerHTML.slice(0, 160)).toBe(true);
    const steps = [...screen.getByRole("navigation").querySelectorAll("a")];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(wide(step), step.outerHTML.slice(0, 160)).toBe(true);
  });
});

describe("Gridtop's window bar over the tenant renderers", () => {
  /** A staff manifest (an organization to switch to) for a person who also rents a unit. */
  const staff = (): ManifestFixture => {
    const base = MANIFEST_FIXTURES[0];
    return {
      ...base,
      name: "staff and tenant",
      pathname: "/my/usage",
      initial: { ...base.initial, view: "tenant.usage-month", title: "November 2026", trail: [], tabs: [] },
    };
  };
  function withModel(model: ViewModel) {
    const real = kit.useView;
    vi.spyOn(kit, "useView").mockImplementation((): ViewState => ({ ...real(), model }));
  }

  it("shows the title and leaves the actions and links to the renderer, so each is drawn once", async () => {
    const model = withPoke({ ...monthModel(), links: [{ id: "tenant.help", label: "Help", href: "/my/help" }] });
    withModel(model);
    unmount = (await renderShell(GridtopGui, staff(), <ModelView gui={GridtopGui} model={model} />)).unmount;
    await waitFor(() => expect(bespoke("month")).not.toBeNull());
    const bar = document.querySelector<HTMLElement>("[data-window-bar]")!;
    expect(bar.textContent).toContain("November 2026");
    expect(within(bar).queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.getAllByRole("button", { name: POKE_LABEL })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Help" })).toHaveLength(1);
  });

  it("names the unit in the page for a person whose title bar shows a staff organization", async () => {
    const model = monthModel({ several: true });
    withModel(model);
    const fixture = staff();
    expect(fixture.manifest.orgs.length).toBeGreaterThan(0);
    unmount = (await renderShell(GridtopGui, fixture, <ModelView gui={GridtopGui} model={model} />)).unmount;
    await waitFor(() => expect(bespoke("month")).not.toBeNull());
    expect(bespoke("month")!.querySelector("[data-read-line]")!.textContent).toBe("Unit 7");
    expect([...bespoke("month")!.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain(dayHref("2026-11-05", { several: true }));
  });
});

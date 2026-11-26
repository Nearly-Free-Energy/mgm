/**
 * Gridtop's renderer for `billing.period-review@1`: when Gridtop picks it,
 * the copy table and the cards, what a copy writes and announces, the
 * keyboard, the controls, the empty state, the live refresh, and that inside
 * the shell nothing is drawn twice. The view's own examples go through
 * src/lib/gui/__tests__/view-examples.test.tsx.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelView, checkModel, loadLazyRenderers, renderInKit, renderShell, withPoke, type Recorded } from "@/lib/gui/conformance";
import type { ActionRef, ActionResult, LiveState, ViewModel, ViewProps, ViewState } from "@/lib/gui/contract";
import type { GuiKit } from "@/lib/gui/contract-react";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "../../..";
import { EAST, EAST_TRAIL, KASANA, ORG, placesFixture } from "../../../__tests__/places-fixture";
import { GRIDTOP_RENDERERS, drawnBespoke } from "../..";
import { copyFailed, copyFigure } from "../copy";
import { readPeriodReviewExt } from "../ext";
import PeriodReviewView, { REPEAT } from "../view";
import {
  BILLING_OFF,
  COPY_KEYS,
  EXPORT,
  GENERATE,
  HISTORY,
  MARK_PAID,
  REFRESH,
  TENANTS,
  TOTALS,
  TOTAL_FIGURES,
  billId,
  billingOffModel,
  closedModel,
  draftModel,
  noBillsModel,
  noTenantsModel,
  pdf,
  tenantHref,
  versioned,
  withFigures,
} from "./period-review-fixture";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

async function draw(model: ViewModel, use: GuiKit = kit): Promise<Recorded> {
  const rendered = await renderInKit(<PeriodReviewView model={model} kit={use} />);
  unmount = rendered.unmount;
  return rendered.log;
}
/** The live region's text, which a repeated announcement ends with REPEAT. */
const spoken = () => document.querySelector("[aria-live='polite']")?.textContent ?? "";
const said = () => spoken().replace(new RegExp(`${REPEAT}$`), "");
const region = () => screen.getByRole("region", { name: /^Bills, / });
const cards = () => screen.getByRole("list", { name: "Bills" });
const tableRow = (i: number) => within(region()).getAllByRole("row")[i + 1];
const clipboard = () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};
const key = (k: string, o: Record<string, unknown> = {}) => fireEvent.keyDown(region(), { key: k, ...o });
/**
 * The box and what follows it in the tab order inside it, as a browser has
 * it: what can take focus with Tab, leaving out the content of a closed
 * disclosure, which a browser does not reach. jsdom does not move focus on
 * Tab, so the tests read the order instead.
 */
const tabStops = () =>
  [region(), ...region().querySelectorAll<HTMLElement>("a[href], button, summary, [tabindex]")].filter(
    (el) => el.tabIndex >= 0 && !(el.tagName !== "SUMMARY" && el.closest("details:not([open])")),
  );
const DATA = draftModel().ext!.data as { rows: unknown[] };
const FAILED: ActionResult = { type: "result", ok: false, status: 500, code: "failed", message: "Could not mark the bill paid." };
const CANCELLED: ActionResult = { type: "result", ok: false, status: 0, code: "cancelled", message: "Cancelled" };

describe("Gridtop's period-review renderer: choosing it", () => {
  it("is registered for version 1 in the table the window bar checks, which marks it as placing its own controls", () => {
    expect(GRIDTOP_RENDERERS["billing.period-review"].reads).toEqual([1]);
    expect(drawnBespoke(draftModel())).toBe(true);
    expect(drawnBespoke(versioned("billing.period-review@2"))).toBe(false);
    expect(drawnBespoke({ ...draftModel(), ext: undefined })).toBe(false);
  });

  it("draws version 1 itself, once its chunk loads, and leaves @2 or no ext to the kit's view", async () => {
    unmount = (await renderInKit(<ModelView gui={GridtopGui} model={draftModel()} />)).unmount;
    await waitFor(() => expect(document.querySelector("[data-period-review]")).not.toBeNull());
    unmount();
    for (const model of [versioned("billing.period-review@2"), { ...draftModel(), ext: undefined }]) {
      unmount = (await renderInKit(<ModelView gui={GridtopGui} model={model} />)).unmount;
      expect(document.querySelector("[data-period-review]")).toBeNull();
      expect(document.querySelector("[data-gui-kind='collection']")).not.toBeNull();
      unmount();
    }
    unmount = null;
  });

  it("reads the figures as the server sends them", () => {
    expect(readPeriodReviewExt(draftModel())).toMatchObject({ columns: COPY_KEYS, totals: TOTAL_FIGURES });
    expect(readPeriodReviewExt(draftModel())!.rows.map((r) => r.id)).toEqual([0, 1, 2].map(billId));
    expect(readPeriodReviewExt(noBillsModel())).toEqual({ columns: COPY_KEYS, rows: [], totals: [] });
  });

  it.each([
    ["columns that are not the copy columns", { columns: [...COPY_KEYS].reverse() }],
    ["a row that is not the model's", { rows: [{ id: "other", figures: Array(8).fill(null) }, ...(draftModel().ext!.data as { rows: unknown[] }).rows.slice(1)] }],
    ["a row with too few figures", { rows: [0, 1, 2].map((i) => ({ id: billId(i), figures: ["1"] })) }],
    ["a grouped figure", { totals: [...TOTAL_FIGURES.slice(0, -1), "4,216,800"] }],
    ["no totals while the model has some", { totals: [] }],
    ["data that is not an object", [1, 2]],
    ["a row more than the model has", { rows: [...DATA.rows, DATA.rows[0]] }],
    ["a row fewer than the model has", { rows: DATA.rows.slice(0, 2) }],
    ["columns that are not an array", { columns: "x" }],
    ["rows that are not an array", { rows: { 0: DATA.rows[0] } }],
  ])("draws a model with %s with the kit's view", async (_, patch) => {
    const model = withFigures(patch as never);
    expect(readPeriodReviewExt(model)).toBeNull();
    await draw(model);
    expect(document.querySelector("[data-period-review]")).toBeNull();
    expect(document.querySelector("[data-gui-kind='collection']")).not.toBeNull();
  });
});

describe("Gridtop's period-review renderer: drawing", () => {
  beforeAll(async () => {
    await loadLazyRenderers(GridtopGui, [draftModel()]);
  }, 30_000);

  it.each([
    ["a draft with bills", draftModel],
    ["a closed period", closedModel],
    ["a draft with no bills", noBillsModel],
    ["no tenants", noTenantsModel],
    ["billing off", billingOffModel],
  ])("passes the conformance view checks, with acme.poke offered: %s", async (name, model) => {
    expect(await checkModel(GridtopGui, withPoke(model()), name)).toEqual([]);
  }, 60_000);

  it("draws the bills as a table, with the tenant as each row's header, and as cards, each tenant linked to its page", async () => {
    await draw(draftModel());
    const headers = within(region()).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual([...draftModel().body.columns.map((c) => c.label), "Actions"]);
    expect(within(region()).getAllByRole("rowheader").map((h) => h.textContent)).toEqual([...TENANTS]);
    expect(within(cards()).getAllByRole("listitem").filter((li) => li.parentElement === cards())).toHaveLength(3);
    for (const [i, name] of TENANTS.entries()) {
      expect(screen.getAllByRole("link", { name }).map((a) => a.getAttribute("href"))).toEqual([tenantHref(i), tenantHref(i)]);
    }
    // The table sits in a sideways-scrolling box of its own, shown from 600 px; the cards below it.
    expect(region().className).toContain("gt:overflow-x-auto");
    expect(region().parentElement!.className).toContain("gt:medium:block");
    expect(cards().parentElement!.className).toContain("gt:medium:hidden");
  });

  it("prints a bare figure without its currency, which the header names", async () => {
    await draw(draftModel());
    expect(within(region()).getByRole("columnheader", { name: "Total (UGX)" })).toBeTruthy();
    const cell = within(tableRow(0)).getByText("55,875").closest("td")!;
    expect(cell.textContent).toBe("55,875");
    const button = within(cards()).getByRole("button", { name: "Copy Total (UGX), Aisha M., 55,875" });
    expect(button.textContent).toBe("55,875");
    expect(within(cards()).getAllByText("Total (UGX)")).toHaveLength(3);
  });

  it("draws the totals once, below the table and the cards, never as a row", async () => {
    await draw(draftModel());
    const totals = document.querySelector<HTMLElement>("[data-totals]")!;
    for (const before of [region(), cards()]) expect(before.compareDocumentPosition(totals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(totals).getByText("83,626")).toBeTruthy();
    expect(within(region()).queryByText("83,626")).toBeNull();
    expect([...document.querySelectorAll("tr")].some((tr) => tr.textContent?.includes("83,626"))).toBe(false);
    // begin and end have no total.
    expect(within(totals).queryByText("Begin (kWh)")).toBeNull();
  });

  it("shows the host's notice, and why each action is unavailable, tied to its button", async () => {
    const log = await draw(billingOffModel());
    // The notice is its own element in the warning tone, not one of the reasons that share its text.
    const reasons = new Set([...document.querySelectorAll("[aria-describedby]")].map((el) => el.getAttribute("aria-describedby")));
    const notices = screen.getAllByText(BILLING_OFF).filter((el) => !reasons.has(el.id));
    expect(notices).toHaveLength(1);
    expect(notices[0].className).toContain("gt:bg-warning-muted");
    expect(notices[0].compareDocumentPosition(screen.getByRole("button", { name: REFRESH.label })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const button of [screen.getByRole("button", { name: REFRESH.label }), ...within(tableRow(0)).getAllByRole("button", { name: "Mark as paid" })]) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(BILLING_OFF);
      await act(async () => fireEvent.click(button));
    }
    expect(log.act).toEqual([]);
  });

  it("uses token colour classes only, Gridtop's prefix on every class, and a 44 px touch height on every link and disclosure", async () => {
    const palette = /\b(?:bg|text|fill|stroke|border)-(?:red|blue|green|gray|slate|zinc|amber|orange|yellow|emerald)-\d/;
    for (const model of [draftModel(), billingOffModel(), noBillsModel(), noTenantsModel()]) {
      await draw(model);
      expect(document.body.innerHTML).not.toMatch(palette);
      for (const el of document.querySelectorAll("[class]")) {
        for (const name of el.getAttribute("class")!.split(/\s+/).filter(Boolean)) expect(name.startsWith("gt:"), name).toBe(true);
      }
      for (const el of document.querySelectorAll("a, summary")) expect(el.className, el.textContent ?? "").toMatch(/gt:pointer-coarse:(min-)?h-11/);
      unmount?.();
    }
    unmount = null;
  });
});

describe("Gridtop's period-review renderer: copying", () => {
  it("copies the ext's plain figure from a table cell, and says what it copied", async () => {
    const writeText = clipboard();
    await draw(draftModel());
    const cell = within(tableRow(0)).getByText("55,875").closest("td")!;
    await act(async () => fireEvent.click(cell));
    expect(writeText).toHaveBeenCalledWith("55875");
    expect(said()).toBe("Total (UGX), Aisha M., copied 55875");
    expect(cell.textContent).toBe("55,875✓");
    // A kWh figure is copied as a plain number: no grouping, no trailing zeros.
    await act(async () => fireEvent.click(within(tableRow(0)).getByText("84.512").closest("td")!));
    expect(writeText).toHaveBeenLastCalledWith("84.512");
    expect(said()).toBe("Usage (kWh), Aisha M., copied 84.512");
  });

  it("copies on a first press without scrolling or announcing the old cursor, as a browser focuses the box before the click", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });
    try {
      const writeText = clipboard();
      await draw(draftModel());
      const cell = within(tableRow(2)).getByText("24,000").closest("td")!;
      // A browser's order: the press, the box taking focus, then the click.
      act(() => {
        fireEvent.mouseDown(cell);
        region().focus();
      });
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(said()).toBe("");
      expect(region().querySelector(".gt\\:outline-ring")).toBe(cell);
      await act(async () => fireEvent.click(cell));
      expect(writeText).toHaveBeenCalledWith("24000");
      expect(said()).toBe("Total (UGX), Carol N., copied 24000");
      expect(scrollIntoView).not.toHaveBeenCalled();
      // The keyboard scrolls again once the click is over.
      key("ArrowLeft");
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(within(tableRow(2)).getByText("20,250").closest("td"));
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("copies from a card and from the totals", async () => {
    const writeText = clipboard();
    await draw(draftModel());
    await act(async () => fireEvent.click(within(cards()).getByRole("button", { name: "Copy Total (UGX), Aisha M., 55,875" })));
    expect(writeText).toHaveBeenLastCalledWith("55875");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy total Total (UGX), 83,626" })));
    expect(writeText).toHaveBeenLastCalledWith("83626");
    expect(said()).toBe("Total Total (UGX), copied 83626");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy total Usage (kWh), 126.5" })));
    expect(writeText).toHaveBeenLastCalledWith("126.512");
    // A card's other figures copy the ext's figure too, not the text shown.
    await act(async () => fireEvent.click(within(cards()).getByRole("button", { name: "Copy Standard (UGX), Aisha M., 52,125" })));
    expect(writeText).toHaveBeenLastCalledWith("52125");
    expect(said()).toBe("Standard (UGX), Aisha M., copied 52125");
    await act(async () => fireEvent.click(within(cards()).getByRole("button", { name: "Copy Usage (kWh), Aisha M., 84.512" })));
    expect(writeText).toHaveBeenLastCalledWith("84.512");
  });

  it("says a repeated copy again, though its message is the same", async () => {
    const writeText = clipboard();
    await draw(draftModel());
    const total = screen.getByRole("button", { name: "Copy total Total (UGX), 83,626" });
    await act(async () => fireEvent.click(total));
    const first = spoken();
    await act(async () => fireEvent.click(total));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(spoken()).not.toBe(first);
    expect(said()).toBe("Total Total (UGX), copied 83626");
    await act(async () => fireEvent.click(total));
    expect(spoken()).toBe(first);
  });

  it("offers no copy for an empty cell", async () => {
    const writeText = clipboard();
    await draw(draftModel());
    // 8 figures, 4 and 8: Brian K. has no end, usage or second tier.
    expect(region().querySelectorAll("td[data-copy]")).toHaveLength(20);
    const usage = within(tableRow(1)).getAllByRole("cell")[2];
    expect(usage.textContent).toBe("—");
    expect(usage.hasAttribute("data-copy")).toBe(false);
    await act(async () => fireEvent.click(usage));
    expect(writeText).not.toHaveBeenCalled();
    expect(within(cards()).queryByRole("button", { name: /^Copy Usage \(kWh\), Brian K\./ })).toBeNull();
  });

  it("says which figure it could not copy when there is no clipboard, and marks nothing copied", async () => {
    await draw(draftModel());
    const cell = within(tableRow(0)).getByText("55,875").closest("td")!;
    await act(async () => fireEvent.click(cell));
    expect(said()).toBe(copyFailed("Total (UGX), Aisha M.", "55875"));
    expect(said()).toBe("Could not copy Total (UGX), Aisha M.: the clipboard is not available. The figure is 55875.");
    expect(document.body.textContent).not.toContain("✓");
    // A second failure is said again.
    const first = spoken();
    await act(async () => fireEvent.click(cell));
    expect(spoken()).not.toBe(first);
    expect(await copyFigure("1")).toBe(false);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => Promise.reject(new Error("denied")) }, configurable: true });
    const error = vi.spyOn(console, "error");
    expect(await copyFigure("1")).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("Gridtop's period-review renderer: the keyboard", () => {
  it("moves over the figures only, skipping the tenant, the statuses, the text and the empty cells", async () => {
    clipboard();
    await draw(draftModel());
    act(() => region().focus());
    expect(said()).toBe("Begin (kWh), Aisha M., 1,200.000");
    key("ArrowRight");
    expect(said()).toBe("End (kWh), Aisha M., 1,284.512");
    key("ArrowDown");
    expect(said()).toBe("End (kWh), Carol N., 542.000");
    key("ArrowUp");
    expect(said()).toBe("End (kWh), Aisha M., 1,284.512");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(said()).toBe("Begin (kWh), Aisha M., 1,200.000");
    for (let i = 0; i < 10; i++) key("ArrowRight");
    // The last figure is the total: past it are the statuses and the text.
    expect(said()).toBe("Total (UGX), Aisha M., 55,875");
    expect(region().querySelector(".gt\\:outline-ring")?.textContent).toBe("55,875");
    // Sideways on a row with empty cells: Brian K. has no end, usage or second tier.
    key("Home", { ctrlKey: true });
    key("ArrowDown");
    key("ArrowRight");
    expect(said()).toBe("Lifeline kWh, Brian K., 15.000");
    key("ArrowLeft");
    expect(said()).toBe("Begin (kWh), Brian K., 310.000");
    key("ArrowRight");
    key("ArrowRight");
    expect(said()).toBe("Lifeline (UGX), Brian K., 3,751");
    key("ArrowRight");
    expect(said()).toBe("Total (UGX), Brian K., 3,751");
    key("ArrowLeft");
    expect(said()).toBe("Lifeline (UGX), Brian K., 3,751");
  });

  it("scrolls the cursor's cell into view as it moves", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });
    try {
      await draw(draftModel());
      act(() => region().focus());
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(within(tableRow(0)).getByText("1,200.000").closest("td"));
      for (const k of ["ArrowRight", "PageDown", "Tab"]) key(k);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
      // End, Carol N., then Tab down to the next column's top.
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(within(tableRow(0)).getByText("84.512").closest("td"));
      key("End", { ctrlKey: true });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(within(tableRow(2)).getByText("24,000").closest("td"));
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("goes to the ends with Home and End, ten rows with Page Up and Down, and down the columns with Tab", async () => {
    clipboard();
    await draw(draftModel());
    act(() => region().focus());
    key("End");
    expect(said()).toBe("Begin (kWh), Carol N., 500.000");
    key("Home");
    expect(said()).toBe("Begin (kWh), Aisha M., 1,200.000");
    key("PageDown");
    expect(said()).toBe("Begin (kWh), Carol N., 500.000");
    key("PageUp");
    expect(said()).toBe("Begin (kWh), Aisha M., 1,200.000");
    key("End", { ctrlKey: true });
    expect(said()).toBe("Total (UGX), Carol N., 24,000");
    key("Home", { metaKey: true });
    expect(said()).toBe("Begin (kWh), Aisha M., 1,200.000");
    key("Tab");
    key("Tab");
    expect(said()).toBe("Begin (kWh), Carol N., 500.000");
    key("Tab");
    // Brian K. has no end reading.
    expect(said()).toBe("End (kWh), Aisha M., 1,284.512");
    key("Tab", { shiftKey: true });
    expect(said()).toBe("Begin (kWh), Carol N., 500.000");
  });

  it("copies with Enter, Space or C and moves on, and says where the table ends", async () => {
    const writeText = clipboard();
    await draw(draftModel());
    act(() => region().focus());
    await act(async () => key("Enter"));
    expect(writeText).toHaveBeenLastCalledWith("1200");
    expect(said()).toBe("Begin (kWh), Aisha M., copied 1200. Next: Begin (kWh), Brian K., 310.000");
    await act(async () => key(" "));
    expect(writeText).toHaveBeenLastCalledWith("310");
    await act(async () => key("c"));
    expect(writeText).toHaveBeenLastCalledWith("500");
    // From the bottom of a column to the top of the next.
    expect(said()).toBe("Begin (kWh), Carol N., copied 500. Next: End (kWh), Aisha M., 1,284.512");
    key("End", { ctrlKey: true });
    await act(async () => key("C"));
    expect(writeText).toHaveBeenLastCalledWith("24000");
    expect(said()).toBe("Total (UGX), Carol N., copied 24000. End of table");
    // Copying the last figure again is said again.
    const first = spoken();
    await act(async () => key("C"));
    expect(writeText).toHaveBeenCalledTimes(5);
    expect(spoken()).not.toBe(first);
    expect(said()).toBe("Total (UGX), Carol N., copied 24000. End of table");
    // A copy shortcut with a modifier is the browser's.
    await act(async () => key("c", { ctrlKey: true }));
    expect(writeText).toHaveBeenCalledTimes(5);
  });

  it("keeps the cursor on a figure it could not copy, and says which", async () => {
    await draw(draftModel());
    act(() => region().focus());
    await act(async () => key("c"));
    expect(said()).toBe(copyFailed("Begin (kWh), Aisha M.", "1200"));
    expect(region().querySelector(".gt\\:outline-ring")?.textContent).toBe("1,200.000");
    const writeText = clipboard();
    await act(async () => key("c"));
    expect(writeText).toHaveBeenLastCalledWith("1200");
    expect(region().querySelector(".gt\\:outline-ring")?.textContent).toBe("310.000");
  });

  it("says where the cursor is on coming back to the table", async () => {
    await draw(draftModel());
    act(() => region().focus());
    key("ArrowDown");
    key("ArrowRight");
    expect(said()).toBe("Lifeline kWh, Brian K., 15.000");
    key("Escape");
    act(() => tableRow(0).querySelector<HTMLElement>("summary")!.focus());
    const before = spoken();
    act(() => region().focus());
    expect(spoken()).not.toBe(before);
    expect(said()).toBe("Lifeline kWh, Brian K., 15.000");
  });

  it("lets Tab leave past the last figure and Shift+Tab before the first, and Escape leave at any time", async () => {
    clipboard();
    await draw(draftModel());
    act(() => region().focus());
    expect(key("Tab", { shiftKey: true })).toBe(true);
    key("End", { ctrlKey: true });
    expect(key("Tab")).toBe(true);
    expect(key("ArrowDown")).toBe(false);
    key("Escape");
    expect(document.activeElement).not.toBe(region());
  });

  it("is three stops in the tab order: the box, then the cursor row's tenant link and actions", async () => {
    await draw(draftModel());
    const stops = () => tabStops().map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(stops()).toEqual([region().getAttribute("aria-label"), "Aisha M.", "Actions for Aisha M."]);
    act(() => region().focus());
    key("End", { ctrlKey: true });
    // Past the last figure, Tab goes on to Carol N.'s link and actions, and then out of the table.
    expect(stops()).toEqual([region().getAttribute("aria-label"), "Carol N.", "Actions for Carol N."]);
    // Every row's link and disclosure is still there for a mouse.
    expect(within(region()).getAllByRole("link", { name: /^(Aisha|Brian|Carol)/ })).toHaveLength(3);
    expect(region().querySelectorAll("summary")).toHaveLength(3);
  });

  it("goes to the cursor row's actions with A", async () => {
    await draw(draftModel());
    act(() => region().focus());
    key("ArrowDown");
    expect(key("a")).toBe(false);
    expect(document.activeElement).toBe(within(tableRow(1)).getByText("Actions"));
    expect(document.activeElement!.getAttribute("aria-label")).toBe("Actions for Brian K.");
    // With a modifier it is the browser's.
    act(() => region().focus());
    expect(key("a", { ctrlKey: true })).toBe(true);
    expect(document.activeElement).toBe(region());
  });

  it("leaves a key pressed on a control inside the table to that control", async () => {
    await draw(draftModel());
    act(() => region().focus());
    const summary = within(tableRow(0)).getByText("Actions");
    const before = spoken();
    expect(fireEvent.keyDown(summary, { key: "Enter" })).toBe(true);
    expect(spoken()).toBe(before);
  });
});

describe("Gridtop's period-review renderer: the controls", () => {
  it("calls nothing on mount, and acts with the very ref the model gave", async () => {
    const poked = withPoke(draftModel());
    const log = await draw(poked);
    expect(log.act).toEqual([]);
    await act(async () => fireEvent.click(within(tableRow(0)).getByRole("button", { name: "Mark as paid" })));
    expect(log.act).toEqual([MARK_PAID(0)]);
    // Each bill's disclosure is named for its tenant.
    expect(within(tableRow(0)).getByText("Actions").getAttribute("aria-label")).toBe("Actions for Aisha M.");
  });

  it("shows a failed action's message, and nothing when the person cancels", async () => {
    await draw(draftModel(), { ...kit, act: vi.fn<(ref: ActionRef) => Promise<ActionResult>>(async () => FAILED) });
    await act(async () => fireEvent.click(within(tableRow(0)).getByRole("button", { name: "Mark as paid" })));
    expect(within(tableRow(0)).getByRole("alert").textContent).toBe(FAILED.message);
    unmount?.();
    await draw(draftModel(), { ...kit, act: vi.fn<(ref: ActionRef) => Promise<ActionResult>>(async () => CANCELLED) });
    await act(async () => fireEvent.click(within(tableRow(0)).getByRole("button", { name: "Mark as paid" })));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a success's message as a status line, and nothing for a success with none", async () => {
    const ok = (message?: string): ActionResult => ({ type: "result", ok: true, ...(message ? { message } : {}) });
    await draw(draftModel(), { ...kit, act: vi.fn<(ref: ActionRef) => Promise<ActionResult>>(async () => ok("Marked as paid.")) });
    await act(async () => fireEvent.click(within(tableRow(0)).getByRole("button", { name: "Mark as paid" })));
    expect(within(tableRow(0)).getByRole("status").textContent).toBe("Marked as paid.");
    expect(within(tableRow(0)).queryByRole("alert")).toBeNull();
    unmount?.();
    await draw(draftModel(), { ...kit, act: vi.fn<(ref: ActionRef) => Promise<ActionResult>>(async () => ok()) });
    await act(async () => fireEvent.click(within(tableRow(0)).getByRole("button", { name: "Mark as paid" })));
    expect(within(tableRow(0)).queryByRole("status")).toBeNull();
  });

  it("shows the empty state's failure beside its action", async () => {
    await draw(noBillsModel(), { ...kit, act: vi.fn<(ref: ActionRef) => Promise<ActionResult>>(async () => FAILED) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: GENERATE.label })));
    const empty = screen.getByRole("heading", { level: 2, name: "No billing data yet." }).parentElement!;
    expect(within(empty).getByRole("alert").textContent).toBe(FAILED.message);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("keeps the message of a generation pressed in the empty state once the refresh brings the bills", async () => {
    let current: ViewModel = noBillsModel();
    const useLive = vi.fn<(model: ViewModel) => LiveState>(() => ({ model: current, ageSeconds: () => null, stale: () => false, polling: "on" }));
    const message = "Generated 3 bills from meter data.";
    const generate = vi.fn<(ref: ActionRef) => Promise<ActionResult>>(async () => {
      // The host refreshes the view after a success.
      current = draftModel();
      return { type: "result", ok: true, message };
    });
    await draw(noBillsModel(), { ...kit, useLive, act: generate });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: GENERATE.label })));
    expect(generate).toHaveBeenCalledWith(GENERATE);
    expect(screen.queryByRole("heading", { level: 2, name: "No billing data yet." })).toBeNull();
    const controls = screen.getByRole("list", { name: "Period actions" }).parentElement!;
    expect(within(controls).getByRole("status").textContent).toBe(message);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("opens a download through kit.open, and a page through a link", async () => {
    const log = await draw(draftModel());
    await act(async () => fireEvent.click(screen.getByRole("link", { name: "Export CSV" })));
    await act(async () => fireEvent.click(within(tableRow(0)).getByRole("link", { name: "Download bill (PDF)" })));
    expect(log.open).toEqual([EXPORT, pdf(0)]);
    const history = screen.getAllByRole("link", { name: "View history" }).map((a) => a.getAttribute("href"));
    expect(history.filter((h) => h === HISTORY.href)).toHaveLength(1);
    expect(history).toContain(`${HISTORY.href}?tenant_id=${draftModel().body.rows[0].related![0].id}`);
  });
});

describe("Gridtop's period-review renderer: the empty state", () => {
  it("owns Generate at zero rows, with no table, cards or totals", async () => {
    await draw(noBillsModel());
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("No billing data yet.");
    expect(document.body.textContent).toContain("Generate bills from meter data to read each tenant's meter for this period and calculate their bills.");
    expect(screen.getAllByRole("button", { name: GENERATE.label })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /^Bills, / })).toBeNull();
    expect(screen.queryByRole("list", { name: "Bills" })).toBeNull();
    expect(document.querySelector("[data-totals]")).toBeNull();
    expect(screen.getByRole("link", { name: "View history" }).getAttribute("href")).toBe(HISTORY.href);
  });

  it("offers no action where the empty state has none", async () => {
    await draw(noTenantsModel());
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("No tenants configured for this microgrid.");
    // Generate is the toolbar's here, since the empty state does not offer it.
    expect(screen.getAllByRole("button", { name: GENERATE.label })).toHaveLength(1);
  });
});

describe("Gridtop's period-review renderer: the live refresh", () => {
  const liveOf = (model: ViewModel): LiveState => ({ model, ageSeconds: () => null, stale: () => false, polling: "on" });

  it("draws the model the refresh returned", async () => {
    const before = draftModel();
    const after: ViewModel = {
      ...before,
      body: { ...before.body, totals: { ...TOTALS, total: { t: "money", v: 99999, currency: "UGX", text: "99,999" } } },
      ext: { ...before.ext!, data: { ...(before.ext!.data as object), totals: [...TOTAL_FIGURES.slice(0, -1), "99999"] } },
    };
    const useLive = vi.fn<(model: ViewModel) => LiveState>(() => liveOf(after));
    const writeText = clipboard();
    await draw(before, { ...kit, useLive });
    expect(useLive).toHaveBeenCalledWith(before);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy total Total (UGX), 99,999" })));
    expect(writeText).toHaveBeenLastCalledWith("99999");
  });

  it("hands a refreshed model it cannot read to the kit's view, which does not poll again", async () => {
    const KitView = vi.fn((props: ViewProps) => <kit.KitView {...props} />);
    await draw(draftModel(), { ...kit, useLive: () => liveOf(withFigures({ columns: [] })), KitView });
    expect(document.querySelector("[data-period-review]")).toBeNull();
    expect(KitView).toHaveBeenCalled();
    expect(KitView.mock.calls[0][0].model.live).toBeUndefined();
  });
});

describe("Gridtop's window bar over the period review", () => {
  const fixture = () =>
    placesFixture({
      pathname: `/microgrids/m1/billing/p1`,
      initial: { view: "billing.period-review", title: "Billing", trail: EAST_TRAIL, tabs: [], scope: { organization: ORG, community: KASANA, microgrid: EAST } },
    });
  function withModel(model: ViewModel) {
    const real = kit.useView;
    vi.spyOn(kit, "useView").mockImplementation((): ViewState => ({ ...real(), model }));
  }

  it.each([
    ["with bills", draftModel, REFRESH.label],
    ["with no bills", noBillsModel, GENERATE.label],
  ])("shows the title and leaves the period's actions and links to the renderer, so each is drawn once: %s", async (_, model, action) => {
    withModel(model());
    unmount = (await renderShell(GridtopGui, fixture(), <ModelView gui={GridtopGui} model={model()} />)).unmount;
    await waitFor(() => expect(document.querySelector("[data-period-review]")).not.toBeNull());
    const bar = document.querySelector<HTMLElement>("[data-window-bar]")!;
    expect(bar.textContent).toContain("1 Nov 2026 – 30 Nov 2026");
    expect(within(bar).queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.getAllByRole("button", { name: action })).toHaveLength(1);
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("href") === HISTORY.href)).toHaveLength(1);
  });
});

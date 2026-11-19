/**
 * The tenant's month as Gridtop draws it: a calendar of weeks from Monday,
 * each day up to today a link to its day with the server's figure, every
 * state told apart by more than colour, the total above the calendar and
 * again below it, the problem band, the empty state and the unit's name.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInKit } from "@/lib/gui/conformance";
import type { ModelOf, ViewModel } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { UsageMonthView } from "../renderer";
import { colourClasses, tokens } from "./classes";
import { PROBLEMS, SYNTHETIC_NOTICE, monthModel } from "./usage-fixture";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

async function draw(model: ViewModel, refresh = vi.fn()) {
  const rendered = await renderInKit(<UsageMonthView model={model} kit={{ ...kit, refresh }} />);
  unmount = rendered.unmount;
  return { log: rendered.log, refresh };
}
const text = () => document.body.textContent ?? "";
const count = (needle: string) => text().split(needle).length - 1;
const article = () => document.querySelector<HTMLElement>("[data-gridtop-renderer='tenant-usage-month']")!;
const calendar = () => screen.getByRole("table", { name: /^Use per day, / });
const cellOf = (date: string) => calendar().querySelector<HTMLElement>(`a[href*='date=${date}']`)!;
const extDays = (model: ModelOf<"collection">) => (model.ext!.data as { days: { date: string; state: string; tier: number | null; href: string | null }[] }).days;

describe("Gridtop's tenant month", () => {
  it("lays the month out in weeks from Monday, with blanks before the 1st and after the last day", async () => {
    await draw(monthModel());
    const table = calendar();
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((th) => th.querySelector(".gt\\:sr-only")?.textContent)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    const weeks = table.querySelectorAll("tbody tr");
    expect(weeks).toHaveLength(6);
    // 1 November 2026 is a Sunday.
    const first = [...weeks[0].querySelectorAll("td")];
    expect(first.slice(0, 6).every((td) => td.childElementCount === 0 && !td.textContent)).toBe(true);
    expect(first[6].textContent).toContain("1 Nov 2026");
    expect(weeks[5].querySelectorAll("td")[0].textContent).toContain("30");
  });

  it("links every day up to today to its day, exactly as the ext gives it, with the date, figure and note in its name", async () => {
    const model = monthModel();
    await draw(model);
    const links = [...calendar().querySelectorAll("a")];
    const past = extDays(model).filter((d) => d.state !== "future");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(past.map((d) => d.href));
    const usage = (date: string) => model.body.rows.find((r) => r.id === date)!.cells.usage.text;
    expect(screen.getByRole("link", { name: `17 Nov 2026, ${usage("2026-11-17")}` })).toBe(cellOf("2026-11-17"));
    expect(screen.getByRole("link", { name: `18 Nov 2026, ${usage("2026-11-18")}, So far today` })).toBe(cellOf("2026-11-18"));
  });

  it("draws future days as their number alone, linking nowhere, and links only to the ext's hrefs", async () => {
    const model = monthModel();
    await draw(model);
    const future = calendar().querySelector<HTMLElement>("td[data-state='future']")!;
    expect(future.querySelector("a")).toBeNull();
    expect(future.textContent).toBe("19");
    const allowed = new Set(JSON.stringify(model.ext).match(/\/my\/usage[^"]*/g));
    for (const a of article().querySelectorAll("a")) expect(allowed.has(a.getAttribute("href")!)).toBe(true);
  });

  it("names the unit's other-unit hrefs verbatim for a person with several units", async () => {
    const model = monthModel({ several: true });
    await draw(model);
    const hrefs = [...article().querySelectorAll("a")].map((a) => a.getAttribute("href")!);
    expect(hrefs.length).toBeGreaterThan(18);
    expect(hrefs.every((h) => h.includes("&unit="))).toBe(true);
  });

  it("shades each day by its tier and marks today with a dashed edge", async () => {
    const model = monthModel();
    await draw(model);
    for (const day of extDays(model).filter((d) => d.state === "data")) {
      expect(tokens(cellOf(day.date))).toContain(`gt:bg-energy-load/${{ 1: 10, 2: 20, 3: 35, 4: 50 }[day.tier as 1]}`);
    }
    const today = tokens(cellOf("2026-11-18"));
    expect(today).toContain("gt:border-dashed");
    expect(today.some((t) => t.startsWith("gt:bg-energy-load/"))).toBe(true);
  });

  it("prints No data on a muted fill for a day not read", async () => {
    await draw(monthModel({ gap: true }));
    const cell = cellOf("2026-11-10");
    expect(cell.textContent).toContain("No data");
    expect(tokens(cell)).toEqual(expect.arrayContaining(["gt:bg-muted", "gt:border-border", "gt:text-muted-foreground"]));
    expect(tokens(cell).some((t) => t.startsWith("gt:bg-energy-load"))).toBe(false);
  });

  it("prints No meter for a day before the unit's first meter, and says so to screen readers", async () => {
    await draw(monthModel({ meterFrom: 5 }));
    const cell = cellOf("2026-11-03");
    const shown = [...cell.querySelectorAll("span")].filter((s) => !tokens(s).includes("gt:sr-only") && !s.closest(".gt\\:sr-only"));
    expect(shown.map((s) => s.textContent)).toContain("No meter");
    expect(screen.getByRole("link", { name: "3 Nov 2026, No data, No meter on this day" })).toBe(cell);
    expect(tokens(cell).some((t) => t.startsWith("gt:bg-"))).toBe(false);
  });

  it("sets one text colour per element: foreground on shaded days, muted text elsewhere, with no opacity on future days", async () => {
    await draw(monthModel({ gap: true, meterFrom: 3, synthetic: true }));
    for (const el of article().querySelectorAll("*")) {
      expect(colourClasses(el).length, el.outerHTML.slice(0, 120)).toBeLessThanOrEqual(1);
    }
    expect(colourClasses(cellOf("2026-11-05"))).toEqual(["gt:text-foreground"]);
    expect(colourClasses(cellOf("2026-11-18"))).toEqual(["gt:text-foreground"]);
    expect(colourClasses(cellOf("2026-11-10"))).toEqual(["gt:text-muted-foreground"]);
    expect(colourClasses(cellOf("2026-11-01"))).toEqual(["gt:text-muted-foreground"]);
    const future = calendar().querySelector("td[data-state='future'] > span")!;
    expect(colourClasses(future)).toEqual(["gt:text-muted-foreground"]);
    expect(tokens(future).some((t) => t.includes("opacity"))).toBe(false);
  });

  it("sets no other text colour inside a shaded day, so the synthetic mark takes the cell's foreground", async () => {
    const model = monthModel({ synthetic: true });
    await draw(model);
    const shaded = extDays(model).filter((d) => d.state === "data" || d.state === "partial");
    expect(shaded.some((d) => d.tier === 3 || d.tier === 4)).toBe(true);
    for (const day of shaded) {
      const cell = cellOf(day.date);
      expect(colourClasses(cell)).toEqual(["gt:text-foreground"]);
      expect(cell.querySelector("[title='Synthetic']")).not.toBeNull();
      for (const el of cell.querySelectorAll("*")) expect(colourClasses(el), el.outerHTML.slice(0, 120)).toEqual([]);
    }
  });

  it("draws each day's focus mark inside its cell, in the foreground colour that shows on every tier", async () => {
    await draw(monthModel());
    for (const a of calendar().querySelectorAll("a")) {
      expect(tokens(a)).toEqual(expect.arrayContaining(["gt:focus-visible:outline-offset-[-2px]", "gt:focus-visible:outline-foreground"]));
      expect(tokens(a)).not.toContain("gt:focus-visible:outline-ring");
    }
  });

  it("shows the total above the calendar and again in one footer cell after the rows", async () => {
    const model = monthModel();
    await draw(model);
    const total = model.body.totals!.usage.text;
    expect(total).toMatch(/^\d+\.\d kWh$/);
    expect(count(total)).toBe(2);
    const foot = calendar().querySelector("tfoot")!;
    const cells = foot.querySelectorAll("tr > *");
    expect(cells).toHaveLength(1);
    expect(cells[0].getAttribute("colspan")).toBe("7");
    expect(cells[0].textContent!.split("Total")).toHaveLength(2);
    expect(cells[0].textContent).toContain("So far");
    const body = calendar().querySelector("tbody")!;
    expect(body.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Caption-size figures in the cells, dense in the footer.
    expect(tokens(cellOf("2026-11-05").querySelector(".gt\\:font-semibold")!)).toContain("gt:text-caption");
    expect(tokens(foot.querySelector(".gt\\:font-semibold")!)).toContain("gt:text-dense");
  });

  it("totals No data with what it covers when a day was not read", async () => {
    await draw(monthModel({ gap: true }));
    const foot = calendar().querySelector("tfoot")!;
    expect(foot.textContent).toContain("No data");
    expect(foot.textContent).toContain("No data for 1 day");
  });

  it("marks every synthetic figure, and shows the host's notice once", async () => {
    const model = monthModel({ synthetic: true });
    await draw(model);
    for (const day of extDays(model).filter((d) => d.state !== "future")) {
      expect(cellOf(day.date).textContent).toContain("(synthetic)");
    }
    expect(calendar().querySelector("tfoot")!.textContent).toContain("(synthetic)");
    expect(count(SYNTHETIC_NOTICE.text)).toBe(1);
    expect(count("Synthetic data: generated for demonstration")).toBe(0);
  });

  it("bands a synthetic month itself when the host gave no notice", async () => {
    await draw(monthModel({ synthetic: true, notice: false }));
    expect(count("Synthetic data: generated for demonstration, not measured")).toBe(1);
  });

  it("keys the shading, and today's dashed edge while today is shown", async () => {
    await draw(monthModel());
    expect(text()).toContain("Shading shows each day's use against this month's highest day.");
    expect(text()).toContain("Today, so far");
    unmount?.();
    await draw(monthModel({ month: "2026-09" }));
    expect(text()).not.toContain("Today, so far");
  });

  it("shows a failed read in a status band with Try again, which reads the month again and writes nothing", async () => {
    const { log, refresh } = await draw(monthModel({ problem: "unavailable" }));
    const band = screen.getByRole("status");
    expect(band.textContent).toContain(PROBLEMS.unavailable.title);
    expect(band.textContent).toContain(PROBLEMS.unavailable.message);
    expect(tokens(band)).toContain("gt:text-warning-fg");
    await act(async () => fireEvent.click(within(band).getByRole("button", { name: "Try again" })));
    expect(refresh).toHaveBeenCalledOnce();
    expect(log.act).toEqual([]);
    expect(log.navigate).toEqual([]);
  });

  it.each(["limited", "not-offered"] as const)("offers no Try again for the %s problem, which another read would not clear", async (problem) => {
    await draw(monthModel({ problem }));
    const band = screen.getByRole("status");
    expect(band.textContent).toContain(PROBLEMS[problem].message);
    expect(within(band).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    ["the plain month", monthModel(), "Unit 4"],
    ["a stale read", monthModel({ stale: true }), "Unit 4 · As read at 14:20."],
    ["a failed read", monthModel({ problem: "unavailable" }), "Unit 4"],
    ["a person with several units", monthModel({ several: true }), "Unit 7"],
  ])("names the unit on a phone on %s", async (_, model, line) => {
    await draw(model);
    const read = article().querySelector<HTMLElement>("[data-read-line]")!;
    expect(tokens(read)).toContain("gt:medium:hidden");
    expect(read.textContent).toBe(line);
    expect(read.textContent).toContain(model.entity!.label);
    if (model.ext && (model.ext.data as { problem: unknown }).problem) expect(count(PROBLEMS.unavailable.message)).toBe(1);
  });

  it("marks a stale read with the stale dot", async () => {
    await draw(monthModel({ stale: true }));
    expect(article().querySelector("[data-read-line] .gt\\:bg-stale")).not.toBeNull();
  });

  it("shows the empty state with the steps, and no calendar or total, when no meter was in use", async () => {
    await draw(monthModel({ noMeter: true }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("No data");
    expect(text()).toContain("No meter of this unit was in use in this month.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(text()).not.toContain("Total");
    expect(screen.getByRole("link", { name: "October 2026" })).toBeTruthy();
  });

  it("steps between months, with an inert placeholder where there is no step", async () => {
    await draw(monthModel({ previous: null }));
    const nav = screen.getByRole("navigation", { name: "Months" });
    expect(within(nav).queryAllByRole("link")).toHaveLength(0);
    const placeholders = nav.querySelectorAll("span[aria-hidden='true']");
    expect(placeholders).toHaveLength(2);
    for (const p of placeholders) expect(tokens(p)).toContain("gt:shrink-0");
    expect(within(nav).getByRole("heading", { level: 2 }).textContent).toBe("November 2026");
    unmount?.();
    await draw(monthModel({ month: "2026-09" }));
    const steps = screen.getByRole("navigation", { name: "Months" });
    expect(within(steps).getByRole("link", { name: "August 2026" }).getAttribute("href")).toBe("/my/usage?month=2026-08");
    expect(within(steps).getByRole("link", { name: "October 2026" }).getAttribute("href")).toBe("/my/usage?month=2026-10");
  });
});

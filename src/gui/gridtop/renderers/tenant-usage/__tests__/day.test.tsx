/**
 * The tenant's day as Gridtop draws it: a bar per hour the ext gives (23,
 * 24 or 25), a list of the hours up to now with the server's labels and the
 * total after them, the steps to the previous and next day and to the
 * month, the problem band, the empty state and the unit's name.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInKit } from "@/lib/gui/conformance";
import type { ModelOf, ViewModel } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { UsageDayView } from "../renderer";
import { colourClasses, tokens } from "./classes";
import { PROBLEMS, SYNTHETIC_NOTICE, dayModel } from "./usage-fixture";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

async function draw(model: ViewModel, refresh = vi.fn()) {
  const rendered = await renderInKit(<UsageDayView model={model} kit={{ ...kit, refresh }} />);
  unmount = rendered.unmount;
  return { log: rendered.log, refresh };
}
const text = () => document.body.textContent ?? "";
const count = (needle: string) => text().split(needle).length - 1;
const article = () => document.querySelector<HTMLElement>("[data-gridtop-renderer='tenant-usage-day']")!;
const list = () => screen.getByRole("table", { name: /^Use per hour, / });
const bars = () => [...document.querySelectorAll("figure[aria-hidden='true'] svg [data-state]")];
const extHours = (model: ModelOf<"collection">) => (model.ext!.data as { hours: { start: string; label: string; state: string }[] }).hours;

describe("Gridtop's tenant day", () => {
  it.each([
    ["today in Kampala", dayModel(), 24],
    ["the day the clocks go forward", dayModel({ zone: "dst23" }), 23],
    ["the day the clocks go back", dayModel({ zone: "dst25" }), 25],
  ])("draws a slot per hour on %s, and a list row per hour up to now with the server's labels", async (_, model, hours) => {
    await draw(model);
    expect(extHours(model)).toHaveLength(hours);
    const svg = document.querySelector("figure[aria-hidden='true'] svg")!;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${hours * 10} 100`);
    const rows = [...list().querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(model.body.rows.length);
    expect(rows.map((tr) => tr.querySelector("th")!.textContent)).toEqual(model.body.rows.map((r) => r.cells.hour.text));
    // A bar or stub for every hour with a meter in force, up to now.
    expect(bars()).toHaveLength(extHours(model).filter((h) => h.state !== "future" && h.state !== "no-meter").length);
  });

  it("tells the two 01:00 hours of the long day apart by their offsets", async () => {
    await draw(dayModel({ zone: "dst25" }));
    const labels = [...list().querySelectorAll("tbody th")].map((th) => th.textContent);
    expect(labels.slice(0, 4)).toEqual(["00:00 GMT-4", "01:00 GMT-4", "01:00 GMT-5", "02:00 GMT-5"]);
    expect(labels).toHaveLength(25);
  });

  it("skips the missing hour of the short day", async () => {
    await draw(dayModel({ zone: "dst23" }));
    const labels = [...list().querySelectorAll("tbody th")].map((th) => th.textContent);
    expect(labels.slice(0, 3)).toEqual(["00:00 GMT-5", "01:00 GMT-5", "03:00 GMT-4"]);
  });

  it("draws an hour so far as a hollow dashed bar, an hour not read yet as a stub, and nothing for the hours to come", async () => {
    await draw(dayModel());
    const partial = bars().filter((b) => b.getAttribute("data-state") === "partial");
    expect(partial).toHaveLength(2);
    expect(partial[0].getAttribute("stroke-dasharray")).toBe("3 2");
    expect(partial[1].getAttribute("height")).toBe("4");
    expect(bars().filter((b) => b.getAttribute("data-state") === "data")).toHaveLength(14);
    expect(bars().some((b) => b.getAttribute("data-state") === "future")).toBe(false);
  });

  it("draws the hours of a failed read as stubs", async () => {
    await draw(dayModel({ problem: "unavailable" }));
    expect(bars().every((b) => b.getAttribute("data-state") === "no-data" && b.getAttribute("height") === "4")).toBe(true);
  });

  it("shows the notes that say an hour is still running or not read yet", async () => {
    await draw(dayModel());
    const rows = [...list().querySelectorAll("tbody tr")];
    const running = rows.filter((tr) => tr.getAttribute("data-state") === "partial");
    expect(running.map((tr) => tr.lastElementChild!.textContent)).toEqual(["So far", "Not read yet"]);
    expect(tokens(running[0].querySelector("th")!)).toContain("gt:border-dashed");
  });

  it("prints dense figures in the list and its footer, and sets one text colour per element", async () => {
    await draw(dayModel({ problem: "unavailable" }));
    for (const el of article().querySelectorAll("*")) expect(colourClasses(el).length, el.outerHTML.slice(0, 120)).toBeLessThanOrEqual(1);
    unmount?.();
    await draw(dayModel({ synthetic: true }));
    for (const el of article().querySelectorAll("*")) expect(colourClasses(el).length, el.outerHTML.slice(0, 120)).toBeLessThanOrEqual(1);
    const figures = [...list().querySelectorAll("tbody td .gt\\:font-semibold, tfoot td .gt\\:font-semibold")];
    expect(figures.length).toBeGreaterThan(10);
    for (const f of figures) {
      expect(tokens(f)).toContain("gt:text-dense");
      expect(tokens(f)).not.toContain("gt:text-caption");
    }
  });

  it("shows the total above and after the hours, with what it covers", async () => {
    const model = dayModel();
    await draw(model);
    const total = model.body.totals!.usage.text;
    expect(count(total)).toBe(2);
    const foot = list().querySelector("tfoot")!;
    expect(foot.textContent).toContain(total);
    expect(foot.textContent).toContain("So far");
    expect(list().querySelector("tbody")!.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks every synthetic figure, and shows the host's notice once", async () => {
    const model = dayModel({ synthetic: true });
    await draw(model);
    const rows = [...list().querySelectorAll("tbody tr")];
    for (const tr of rows.filter((r) => r.getAttribute("data-state") === "data")) expect(tr.textContent).toContain("(synthetic)");
    expect(list().querySelector("tfoot")!.textContent).toContain("(synthetic)");
    expect(count(SYNTHETIC_NOTICE.text)).toBe(1);
  });

  it("steps to the previous and next day and up to the month, with the ext's hrefs verbatim", async () => {
    await draw(dayModel({ zone: "dst25", several: true }));
    const nav = screen.getByRole("navigation", { name: "Days" });
    expect(within(nav).getByRole("link", { name: "31 Oct 2026" }).getAttribute("href")).toMatch(/^\/my\/usage\/day\?date=2026-10-31&unit=/);
    expect(within(nav).getByRole("link", { name: "2 Nov 2026" }).getAttribute("href")).toMatch(/^\/my\/usage\/day\?date=2026-11-02&unit=/);
    const month = screen.getByRole("link", { name: "November 2026" });
    expect(month.getAttribute("href")).toMatch(/^\/my\/usage\?month=2026-11&unit=/);
    expect(tokens(month)).toContain("gt:pointer-coarse:min-h-11");
    expect(within(nav).getByRole("heading", { level: 2 }).textContent).toBe("Sunday 1 November 2026");
  });

  it("offers no next step on today", async () => {
    await draw(dayModel());
    const nav = screen.getByRole("navigation", { name: "Days" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["←17 Nov 2026"]);
    expect(nav.querySelector("span[aria-hidden='true'].gt\\:pointer-events-none")).not.toBeNull();
  });

  it("lets a long heading wrap between steps that keep their size", async () => {
    await draw(dayModel());
    const nav = screen.getByRole("navigation", { name: "Days" });
    const heading = within(nav).getByRole("heading", { level: 2 });
    expect(tokens(heading)).toEqual(expect.arrayContaining(["gt:min-w-0", "gt:flex-1", "gt:text-center", "gt:break-words"]));
    expect(tokens(heading).some((t) => /truncate|whitespace-nowrap/.test(t))).toBe(false);
    const steps = [...nav.children].filter((el) => el !== heading);
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(tokens(step)).toContain("gt:shrink-0");
  });

  it("shows the empty state, with the steps and no bars or list, when no meter was in use", async () => {
    await draw(dayModel({ meters: 0, zone: "dst23" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("No data");
    expect(text()).toContain("No meter of this unit was in use on this day.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector("figure svg")).toBeNull();
    expect(screen.getByRole("link", { name: "March 2026" })).toBeTruthy();
  });

  it("shows a failed read with Try again, which reads the day again and writes nothing", async () => {
    const { log, refresh } = await draw(dayModel({ problem: "unavailable" }));
    const band = screen.getByRole("status");
    expect(band.textContent).toContain(PROBLEMS.unavailable.message);
    await act(async () => fireEvent.click(within(band).getByRole("button", { name: "Try again" })));
    expect(refresh).toHaveBeenCalledOnce();
    expect(log.act).toEqual([]);
  });

  it.each(["limited", "not-offered"] as const)("offers no Try again for the %s problem, which another read would not clear", async (problem) => {
    await draw(dayModel({ problem }));
    expect(screen.getByRole("status").textContent).toContain(PROBLEMS[problem].message);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    ["the plain day", dayModel(), "Unit 4"],
    ["a failed read", dayModel({ problem: "unavailable" }), "Unit 4"],
    ["a person with several units", dayModel({ several: true }), "Unit 7"],
  ])("names the unit on a phone on %s", async (_, model, line) => {
    await draw(model);
    const read = article().querySelector<HTMLElement>("[data-read-line]")!;
    expect(tokens(read)).toContain("gt:medium:hidden");
    expect(read.textContent).toBe(line);
  });
});

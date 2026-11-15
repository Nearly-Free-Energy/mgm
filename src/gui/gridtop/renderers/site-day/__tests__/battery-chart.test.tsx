/**
 * The battery chart in Gridtop: the legacy page's chart cases
 * (src/components/operations/__tests__/daily-operations.test.tsx), ported,
 * and the bands, grid and line it draws from the ext and the `soc` series.
 * The description's copy is the server's now (site-day-model.test.tsx pins
 * it); these pin that it is printed as given.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BatteryChart, type SocPoints } from "../battery-chart";
import { readSiteDayExt, type DayChart } from "../ext";
import { SOC, at, dayModel } from "./site-day-fixture";

function chartOf(ext: NonNullable<Parameters<typeof dayModel>[0]>["ext"] = {}): DayChart {
  const read = readSiteDayExt(dayModel({ ext }).ext);
  if (read?.state !== "day") throw new Error("The fixture's ext is not a readable day");
  return read;
}

function draw(chart: DayChart = chartOf(), points: SocPoints = SOC) {
  return render(<BatteryChart chart={chart} points={points} />).container;
}
const bands = (root: HTMLElement, kind: string) => [...root.querySelectorAll<SVGRectElement>(`rect[data-band='${kind}']`)];

describe("the battery chart", () => {
  // Legacy: "is an image with a description of the day".
  it("is an image labelled with the server's description of the day", () => {
    const svg = draw().querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Battery level from 00:00 to 24:00. Lowest 12% at 05:30. 2 power cuts. Houses dark for 1h 0m.");
  });

  // Legacy: "ends a complete day's description at 24:00" and "ends a partial day's description at the time read".
  it("prints a partial day's description as given, and shades the part of the day not read yet", () => {
    expect(bands(draw(), "future")).toHaveLength(0);
    const root = draw(chartOf({ partial: true, readUntil: at(14, 15), chartLabel: "Battery level from 00:00 to 14:15." }));
    expect(root.querySelector("svg")!.getAttribute("aria-label")).toBe("Battery level from 00:00 to 14:15.");
    const [future] = bands(root, "future");
    // 14:15 is 855 of the day's 1440 minutes, across the 676 units of plot from x = 36.
    expect(Number(future.getAttribute("x"))).toBeCloseTo(36 + (676 * 855) / 1440, 5);
    expect(Number(future.getAttribute("width"))).toBeCloseTo((676 * 585) / 1440, 5);
    expect(future.getAttribute("class")).toContain("gt:fill-background");
  });

  // Legacy: "breaks the battery line at a missing bin".
  it("breaks the battery line at a missing reading, drawing each reading at the middle of its bin", () => {
    const paths = [...draw().querySelectorAll("svg path")];
    expect(paths).toHaveLength(2);
    // 00:00's bin is drawn at 00:07:30; 80% sits a fifth of the 208-unit plot below its top at y = 8.
    expect(paths[0].getAttribute("d")).toBe(`M${(36 + (676 * 7.5) / 1440).toFixed(1)} ${(8 + 208 * 0.2).toFixed(1)} L${(36 + (676 * 22.5) / 1440).toFixed(1)} ${(8 + 208 * 0.22).toFixed(1)}`);
    expect(paths[1].getAttribute("d")?.match(/[ML]/g)).toEqual(["M", "L"]);
    expect(paths[0].getAttribute("class")).toContain("gt:stroke-success");
  });

  it("draws no line from a series with no readings", () => {
    expect(draw(chartOf(), [[at(0), null]]).querySelectorAll("svg path")).toHaveLength(0);
  });

  // Legacy: "replaces the chart with a note when no battery is registered".
  it("replaces the chart with the server's note when no battery is registered", () => {
    const root = draw(chartOf({ chartEmpty: "No battery is registered on this microgrid." }), []);
    expect(root.textContent).toContain("No battery is registered on this microgrid.");
    expect(root.querySelector("svg")).toBeNull();
  });

  it("bands the evening window, each cut and the dark time from the ext", () => {
    const root = draw();
    const [evening] = bands(root, "evening");
    expect(Number(evening.getAttribute("x"))).toBeCloseTo(36 + 676 * 0.75, 5);
    expect(Number(evening.getAttribute("width"))).toBeCloseTo(676 * 0.25, 5);
    const cuts = bands(root, "cut");
    expect(cuts.map((r) => r.getAttribute("class"))).toEqual(["gt:fill-warning-muted", "gt:fill-warning-muted"]);
    // The first cut is 02:00–04:30.
    expect(Number(cuts[0].getAttribute("x"))).toBeCloseTo(36 + (676 * 2) / 24, 5);
    expect(Number(cuts[0].getAttribute("width"))).toBeCloseTo((676 * 2.5) / 24, 5);
    // Dark from 23:00 to 24:00, in its own colour.
    const dark = bands(root, "dark");
    expect(dark).toHaveLength(1);
    expect(Number(dark[0].getAttribute("x"))).toBeCloseTo(36 + (676 * 23) / 24, 5);
    expect(Number(dark[0].getAttribute("width"))).toBeCloseTo(676 / 24, 5);
    expect(dark[0].getAttribute("class")).toContain("gt:fill-foreground/70");
    // No grid reading: no cut bands.
    expect(bands(draw(chartOf({ cuts: null })), "cut")).toHaveLength(0);
  });

  it("paints dark time over the cuts, and the unread part of today over both", () => {
    // Dark time falls inside a cut, so a cut painted later would hide it.
    const root = draw(chartOf({ partial: true, readUntil: at(14, 15) }));
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const [dark] = bands(root, "dark");
    const [future] = bands(root, "future");
    for (const cut of bands(root, "cut")) expect(follows(cut, dark)).toBe(true);
    expect(follows(dark, future)).toBe(true);
  });

  it("clamps spans to the day and readings to 0–100%", () => {
    const root = draw(chartOf({ cuts: [{ start: at(-1), end: at(1), label: "23:00–01:00" }] }), [[at(0), 105]]);
    const [cut] = bands(root, "cut");
    expect(Number(cut.getAttribute("x"))).toBe(36);
    expect(Number(cut.getAttribute("width"))).toBeCloseTo(676 / 24, 5);
    expect(root.querySelector("svg path")!.getAttribute("d")).toMatch(/^M[\d.]+ 8\.0$/);
  });

  it("draws each reading at the middle of a bin as long as the ext's resolution", () => {
    const d = draw(chartOf({ resolutionMinutes: 5 }), [[at(0), 50], [at(0, 5), 50]]).querySelector("svg path")!.getAttribute("d");
    expect(d).toBe(`M${(36 + (676 * 2.5) / 1440).toFixed(1)} 112.0 L${(36 + (676 * 7.5) / 1440).toFixed(1)} 112.0`);
  });

  it("draws a grid line every 20%, and the hour labels the server sent", () => {
    const root = draw();
    expect(root.querySelectorAll("svg line")).toHaveLength(6);
    const labels = [...root.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(labels).toEqual(["0", "20", "40", "60", "80", "100", "00", "03", "06", "09", "12", "15", "18", "21", "24"]);
    const hours = [...root.querySelectorAll("svg text")].slice(6);
    expect(hours.map((t) => t.getAttribute("text-anchor"))).toEqual(["start", ...Array(7).fill("middle"), "end"]);
    // 20% is four fifths of the 208-unit plot below its top at y = 8; 100% is the top.
    const lines = [...root.querySelectorAll("svg line")];
    expect([lines[1].getAttribute("y1"), lines[1].getAttribute("y2")].map(Number)).toEqual([8 + 208 * 0.8, 8 + 208 * 0.8]);
    expect(Number(lines[5].getAttribute("y1"))).toBe(8);
    expect(Number(root.querySelectorAll("svg text")[1].getAttribute("y"))).toBe(8 + 208 * 0.8 + 4);
    expect(Number(hours[4].getAttribute("x"))).toBe(36 + 338);
    expect(Number(hours[8].getAttribute("x"))).toBe(712);
  });

  it("keeps the legacy geometry, and scrolls sideways in its own positioned box on a narrow screen", () => {
    const svg = draw().querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 720 240");
    expect(svg.getAttribute("class")).toContain("gt:min-w-[560px]");
    expect(svg.parentElement!.className).toContain("gt:overflow-x-auto");
    expect(svg.parentElement!.className).toContain("gt:relative");
  });

  it("keys the bands and the line", () => {
    const key = [...draw().querySelectorAll("li")].map((li) => li.textContent);
    expect(key).toEqual(["Battery", "Power cut", "Houses dark", "Evening window"]);
  });

  // Legacy: "uses token colour classes only, no hard-coded Tailwind palette".
  it("uses token colour classes only", () => {
    const palette = /\b(?:bg|text|fill|stroke|border)-(?:red|blue|green|gray|slate|zinc|amber|orange|yellow|emerald)-\d/;
    for (const chart of [chartOf(), chartOf({ chartEmpty: "No battery is registered on this microgrid." })]) {
      expect(draw(chart).innerHTML).not.toMatch(palette);
    }
  });
});

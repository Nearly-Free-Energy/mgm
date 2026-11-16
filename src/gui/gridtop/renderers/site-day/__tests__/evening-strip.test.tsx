/**
 * The evening strip in Gridtop. Which supplies the key lists, and every
 * label, is the server's (site-day-model.test.tsx pins them); these pin how
 * the strip draws them.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EveningStrip, segmentWidths } from "../evening-strip";
import { readSiteDayExt, type DayChart } from "../ext";
import type { Tile } from "../tiles";
import { at, dayModel, text } from "./site-day-fixture";

type Options = Parameters<typeof dayModel>[0];
const modelOf = (o: Options = {}) => dayModel(o);
function chartOf(o: Options = {}): DayChart {
  const read = readSiteDayExt(modelOf(o).ext);
  if (read?.state !== "day") throw new Error("The fixture's ext is not a readable day");
  return read;
}
const tileOf = (o: Options = {}) => modelOf(o).body.tiles.find((t) => t.key === "evening-supply") as Tile;

function draw(o: Options = {}, withTile = true) {
  return render(<EveningStrip chart={chartOf(o)} tile={withTile ? tileOf(o) : undefined} />).container;
}
const strip = (root: HTMLElement) => root.querySelector<HTMLElement>('[role="img"]');
const segments = (root: HTMLElement) => [...strip(root)!.children] as HTMLElement[];

const NOT_STARTED = "The evening window has not started yet.";
const BEFORE_EVENING: Options = {
  ext: {
    partial: true,
    readUntil: at(14, 15),
    evening: [],
    legend: [
      { supply: "battery", label: "Battery", hours: "0.0 h" },
      { supply: "battery_and_grid", label: "Battery + grid", hours: "0.0 h" },
      { supply: "grid", label: "Grid alone", hours: "0.0 h" },
      { supply: "dark", label: "Dark", hours: "0.0 h" },
    ],
    eveningLabel: "Battery 0.0 h, Battery + grid 0.0 h, Grid alone 0.0 h, Dark 0.0 h",
    eveningEmpty: NOT_STARTED,
  },
  tiles: { "evening-supply": { value: text(NOT_STARTED) } },
};

describe("the evening strip", () => {
  it("is an image labelled with the server's hours of each supply", () => {
    expect(strip(draw())?.getAttribute("aria-label")).toBe("Battery 3.0 h, Battery + grid 1.0 h, Grid alone 1.0 h, Dark 1.0 h");
  });

  it("has segment widths that sum to 100% for a complete evening", () => {
    const widths = segments(draw()).map((el) => parseFloat(el.style.width));
    expect(widths).toHaveLength(4);
    expect(widths[0]).toBeCloseTo(50, 5);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
  });

  it("measures a segment against the whole window, so an evening read in part sums to less", () => {
    const chart = chartOf();
    const part = { ...chart, evening: chart.evening.slice(0, 1) };
    expect(segmentWidths(part)).toEqual([50]);
  });

  it("colours each segment by its supply and titles it with the server's label", () => {
    const shown = segments(draw());
    expect(shown.map((el) => el.className)).toEqual(["gt:bg-success", "gt:bg-success-muted", "gt:bg-warning", "gt:bg-foreground"]);
    expect(shown.map((el) => el.title)).toEqual(["Battery, 18:00–21:00", "Battery + grid, 21:00–22:00", "Grid alone, 22:00–23:00", "Dark, 23:00–00:00"]);
  });

  it("ticks the window with the server's hours", () => {
    const ticks = strip(draw())!.nextElementSibling!;
    expect([...ticks.children].map((t) => t.textContent)).toEqual(["18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "24:00"]);
  });

  it("keys the supplies the server lists, so 'No data' only when some of the evening had none", () => {
    const key = (root: HTMLElement) => [...root.querySelectorAll("li")].map((li) => li.textContent);
    expect(key(draw())).toEqual(["Battery", "Battery + grid", "Grid alone", "Dark"]);
    const withGap = draw({
      ext: {
        evening: [
          { start: at(18), end: at(23), supply: "battery", label: "Battery, 18:00–23:00" },
          { start: at(23), end: at(24), supply: "no_data", label: "No data, 23:00–00:00" },
        ],
        legend: [
          { supply: "battery", label: "Battery", hours: "5.0 h" },
          { supply: "battery_and_grid", label: "Battery + grid", hours: "0.0 h" },
          { supply: "grid", label: "Grid alone", hours: "0.0 h" },
          { supply: "dark", label: "Dark", hours: "0.0 h" },
          { supply: "no_data", label: "No data", hours: "1.0 h" },
        ],
      },
    });
    expect(key(withGap)).toEqual(["Battery", "Battery + grid", "Grid alone", "Dark", "No data"]);
    expect(segments(withGap)[1].className).toBe("gt:bg-muted");
  });

  it("heads the strip with the evening tile, and gives its summary with the hours", () => {
    const root = draw();
    expect(root.querySelector("h3")?.textContent).toBe("Who served the houses, 18:00–24:00");
    expect(root.querySelector("p")?.textContent).toBe("Battery 3.0 h · Battery + grid 1.0 h · Grid alone 1.0 h · Dark 1.0 h");
  });

  it("marks a synthetic summary", () => {
    expect(draw({ synthetic: true }).querySelector("p [title='Synthetic']")).not.toBeNull();
    expect(draw().querySelector("[title='Synthetic']")).toBeNull();
  });

  it("says the window has not started, once, in place of the strip", () => {
    const root = draw(BEFORE_EVENING);
    expect(strip(root)).toBeNull();
    expect(root.textContent!.split(NOT_STARTED)).toHaveLength(2);
    // Without the tile, the ext's own text says it.
    const bare = draw(BEFORE_EVENING, false);
    expect(bare.textContent).toBe(NOT_STARTED);
  });

  it("uses token colour classes only", () => {
    const palette = /\b(?:bg|text|fill|stroke|border)-(?:red|blue|green|gray|slate|zinc|amber|orange|yellow|emerald)-\d/;
    for (const o of [{}, BEFORE_EVENING, { synthetic: true }]) expect(draw(o).innerHTML).not.toMatch(palette);
  });
});

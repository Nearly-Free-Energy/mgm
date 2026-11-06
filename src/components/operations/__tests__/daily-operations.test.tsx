// daily-operations.test.tsx — the daily operations view (Operations tab).
//
// Renders DailyOperations with hand-built SiteDaySummary fixtures (no
// computeSiteDay) so each assertion pins one field to one piece of copy:
//   - stat tiles: solar, houses' evening use (with the battery's share), cuts, lowest battery, 17:00
//     battery, lights on; em dash and "needs …" copy when a value is null
//   - the partial-day note for today
//   - the battery chart's accessible description
//   - the evening strip's segment widths
//   - token classes only (no hard-coded Tailwind palette)
// and formatDuration on its own.

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// Mock LocaleContext so Kwh / the clock work without a real Provider.
vi.mock("@/components/format/locale-context", () => ({
  useLocale: () => ({ locale: "en-UG", currency: "UGX" }),
  LocaleProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { DailyOperations, formatDuration } from "../daily-operations";
import type { SiteDaySummary } from "@/lib/metering/site-operations";

// ── Fixtures ──────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const MIN = 60_000;
// 2026-11-05 in Africa/Kampala (UTC+3, no DST) starts at 21:00 UTC the day before.
const DAY_START = Date.parse("2026-11-04T21:00:00Z");
const at = (hour: number, minute = 0) => DAY_START + hour * HOUR + minute * MIN;

function makeDay(overrides: Partial<SiteDaySummary> = {}): SiteDaySummary {
  return {
    date: "2026-11-05",
    timezone: "Africa/Kampala",
    dayStartMs: DAY_START,
    dayEndMs: at(24),
    readUntilMs: at(24),
    knownMinutes: 1440,
    resolutionMinutes: 15,
    eveningStartMs: at(18),
    hourMarks: [0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => ({ hour, atMs: at(hour) })),
    sources: {
      battery: true,
      gridMeter: true,
      load: true,
      pv: true,
      houses: true,
      houseMetersUnreadable: 0,
    },
    solarKwh: 12.34,
    solarEstimated: false,
    eveningDischargeKwh: 4.56,
    housesEveningKwh: 3.21,
    housesEveningMetersMissing: 0,
    // Two cuts: 02:00–04:30 (150 min) and 13:00–14:40 (100 min) = 4h 10m.
    cuts: [
      { startMs: at(2), endMs: at(4, 30) },
      { startMs: at(13), endMs: at(14, 40) },
    ],
    cutMinutes: 250,
    lowestSoc: { pct: 12.4, atMs: at(5, 30), duringCut: true },
    socAtCheckHour: 63.6,
    dark: [{ startMs: at(23), endMs: at(24) }],
    darkMinutes: 60,
    noDataMinutes: 0,
    lightsOnPct: (100 * (1440 - 60)) / 1440, // 95.8333…
    soc: [
      { atMs: at(0), pct: 80 },
      { atMs: at(0, 15), pct: 78 },
      { atMs: at(0, 30), pct: null },
      { atMs: at(0, 45), pct: 70 },
      { atMs: at(1), pct: 69 },
    ],
    // 18–21 battery, 21–22 battery + grid, 22–23 grid, 23–24 dark.
    evening: [
      { startMs: at(18), endMs: at(21), supply: "battery" },
      { startMs: at(21), endMs: at(22), supply: "battery_and_grid" },
      { startMs: at(22), endMs: at(23), supply: "grid" },
      { startMs: at(23), endMs: at(24), supply: "dark" },
    ],
    eveningHours: { battery: 3, battery_and_grid: 1, grid: 1, dark: 1, no_data: 0 },
    ...overrides,
  };
}

const NULL_DAY: Partial<SiteDaySummary> = {
  sources: {
    battery: false,
    gridMeter: false,
    load: false,
    pv: false,
    houses: false,
    houseMetersUnreadable: 0,
  },
  solarKwh: null,
  solarEstimated: false,
  eveningDischargeKwh: null,
  housesEveningKwh: null,
  housesEveningMetersMissing: 0,
  cuts: null,
  cutMinutes: null,
  lowestSoc: null,
  socAtCheckHour: null,
  dark: [],
  darkMinutes: 0,
  lightsOnPct: null,
  soc: [],
};

function render(day: SiteDaySummary): { html: string; root: HTMLElement } {
  const html = renderToStaticMarkup(<DailyOperations day={day} />);
  const root = document.createElement("div");
  root.innerHTML = html;
  return { html, root };
}

/** The stat tile whose label is `label`, as text. */
function tile(root: HTMLElement, label: string): string {
  const section = Array.from(root.querySelectorAll("section")).find(
    (s) => s.querySelector("p")?.textContent === label,
  );
  if (!section) throw new Error(`No tile labelled ${label}`);
  return section.textContent ?? "";
}

/** The rendered value (second <p>) of the stat tile labelled `label`. */
function tileValue(root: HTMLElement, label: string): string {
  const section = Array.from(root.querySelectorAll("section")).find(
    (s) => s.querySelector("p")?.textContent === label,
  );
  if (!section) throw new Error(`No tile labelled ${label}`);
  return section.querySelectorAll("p")[1]?.textContent ?? "";
}

// ── formatDuration ────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it.each([
    [0, "0m"],
    [0.4, "0m"],
    [1, "1m"],
    [45, "45m"],
    [59, "59m"],
    [59.6, "1h 0m"],
    [60, "1h 0m"],
    [61, "1h 1m"],
    [250, "4h 10m"],
    [1440, "24h 0m"],
  ])("formats %s minutes as %s", (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });
});

// ── DailyOperations ───────────────────────────────────────────────────────

describe("DailyOperations", () => {
  it("shows solar, and what the houses used in the evening with the battery's share, in kWh", () => {
    const { root } = render(makeDay());
    expect(tileValue(root, "Solar")).toBe("12.3 kWh");
    expect(tile(root, "Solar")).toContain("Solar meter");
    expect(tileValue(root, "Houses used 18:00–24:00")).toBe("3.2 kWh");
    expect(tile(root, "Houses used 18:00–24:00")).toContain("Battery supplied 4.6 kWh");
    expect(tile(root, "Houses used 18:00–24:00")).not.toContain("without data");
  });

  it("notes house meters left out of the evening figure for want of data", () => {
    const one = render(makeDay({ housesEveningMetersMissing: 1 })).root;
    expect(tile(one, "Houses used 18:00–24:00")).toContain(
      "Battery supplied 4.6 kWh · 1 meter without data",
    );
    const two = render(makeDay({ housesEveningMetersMissing: 2 })).root;
    expect(tile(two, "Houses used 18:00–24:00")).toContain("2 meters without data");
  });

  it("shows an em dash when no house meter has the evening's readings", () => {
    const { root } = render(
      makeDay({ housesEveningKwh: null, housesEveningMetersMissing: 3 }),
    );
    expect(tileValue(root, "Houses used 18:00–24:00")).toBe("—");
    expect(tile(root, "Houses used 18:00–24:00")).toContain(
      "Battery supplied 4.6 kWh · 3 meters without data",
    );
  });

  it("says household meters are needed when there are none, and still gives the battery's share", () => {
    const { root } = render(
      makeDay({
        sources: {
          battery: true,
          gridMeter: true,
          load: true,
          pv: true,
          houses: false,
          houseMetersUnreadable: 0,
        },
        housesEveningKwh: null,
      }),
    );
    expect(tileValue(root, "Houses used 18:00–24:00")).toBe("—");
    expect(tile(root, "Houses used 18:00–24:00")).toContain(
      "Needs household meters · Battery supplied 4.6 kWh",
    );
  });

  it("before 18:00 today, says when the window starts instead of the battery's zero", () => {
    const { root } = render(
      makeDay({
        readUntilMs: at(17, 45),
        eveningDischargeKwh: 0,
        housesEveningKwh: null,
        housesEveningMetersMissing: 0,
      }),
    );
    expect(tileValue(root, "Houses used 18:00–24:00")).toBe("—");
    expect(tile(root, "Houses used 18:00–24:00")).toContain("From 18:00");
    expect(tile(root, "Houses used 18:00–24:00")).not.toContain("Battery supplied");
    const noMeters = render(
      makeDay({
        readUntilMs: at(17, 45),
        eveningDischargeKwh: 0,
        housesEveningKwh: null,
        sources: { ...makeDay().sources, houses: false },
      }),
    ).root;
    expect(tile(noMeters, "Houses used 18:00–24:00")).toContain(
      "Needs household meters · From 18:00",
    );
  });

  it("says no battery is registered in the evening tile when there is none", () => {
    const { root } = render(makeDay({ eveningDischargeKwh: null }));
    expect(tileValue(root, "Houses used 18:00–24:00")).toBe("3.2 kWh");
    expect(tile(root, "Houses used 18:00–24:00")).toContain("No battery registered");
    expect(tile(root, "Houses used 18:00–24:00")).not.toContain("Battery supplied");
  });

  it("marks solar as estimated when it is the balance at the inverter", () => {
    const { root } = render(makeDay({ solarEstimated: true }));
    expect(tile(root, "Solar")).toContain("≈ inverter output − grid − battery");
    expect(tile(root, "Solar")).not.toContain("Solar meter");
  });

  it("shows power cuts as 'count / duration'", () => {
    const { root } = render(makeDay());
    expect(tileValue(root, "Power cuts")).toBe("2 / 4h 10m");
    expect(tile(root, "Power cuts")).toContain("Cuts / time without grid power");
  });

  it("shows zero cuts as '0 / 0m'", () => {
    const { root } = render(makeDay({ cuts: [], cutMinutes: 0 }));
    expect(tileValue(root, "Power cuts")).toBe("0 / 0m");
  });

  it("shows the lowest battery level, its time, and whether it was in a cut", () => {
    const { root } = render(makeDay());
    expect(tileValue(root, "Lowest battery")).toBe("12%");
    expect(tile(root, "Lowest battery")).toContain("At 05:30, in a cut");
  });

  it("omits 'in a cut' when the lowest level was outside a cut", () => {
    const { root } = render(
      makeDay({ lowestSoc: { pct: 40, atMs: at(7, 15), duringCut: false } }),
    );
    expect(tileValue(root, "Lowest battery")).toBe("40%");
    expect(tile(root, "Lowest battery")).toContain("At 07:15");
    expect(tile(root, "Lowest battery")).not.toContain("in a cut");
  });

  it("shows the battery level at 17:00", () => {
    const { root } = render(makeDay());
    expect(tileValue(root, "Battery at 17:00")).toBe("64%");
    expect(tile(root, "Battery at 17:00")).toContain("Before the evening window");
  });

  it("shows lights on with one decimal and the dark time", () => {
    const { root } = render(makeDay());
    expect(tileValue(root, "Lights on")).toBe("95.8%");
    expect(tile(root, "Lights on")).toContain("Dark 1h 0m");
  });

  it("says 'No dark time' when the houses never went dark", () => {
    const { root } = render(makeDay({ dark: [], darkMinutes: 0, lightsOnPct: 100 }));
    expect(tileValue(root, "Lights on")).toBe("100.0%");
    expect(tile(root, "Lights on")).toContain("No dark time");
  });

  it("shows an em dash and what is needed when values are null", () => {
    const { root } = render(makeDay(NULL_DAY));
    for (const label of [
      "Solar",
      "Houses used 18:00–24:00",
      "Power cuts",
      "Lowest battery",
      "Battery at 17:00",
      "Lights on",
    ]) {
      expect(tileValue(root, label)).toBe("—");
    }
    expect(tile(root, "Solar")).toContain(
      "Needs a solar meter, or an inverter output meter with the battery and grid meter",
    );
    expect(tile(root, "Power cuts")).toContain("Needs a grid meter");
    expect(tile(root, "Houses used 18:00–24:00")).toContain(
      "Needs household meters · No battery registered",
    );
    expect(tile(root, "Lowest battery")).toContain("Needs a battery");
    expect(tile(root, "Battery at 17:00")).toContain("No reading at 17:00");
  });

  it("replaces the chart with a note when no battery is registered", () => {
    const { html, root } = render(makeDay(NULL_DAY));
    expect(html).toContain("No battery is registered on this microgrid.");
    expect(root.querySelector("svg")).toBeNull();
  });

  it("shows no partial-day note for a complete day", () => {
    const { html } = render(makeDay());
    expect(html).not.toContain("Today so far");
  });

  it("shows the partial-day note for today, up to the time read", () => {
    const { html } = render(
      makeDay({
        readUntilMs: at(14, 15),
        evening: [],
        eveningHours: { battery: 0, battery_and_grid: 0, grid: 0, dark: 0, no_data: 0 },
      }),
    );
    expect(html).toContain("Today so far, up to 14:15.");
    expect(html).toContain("The evening window has not started yet.");
  });

  it("notes missing data that was not counted as dark", () => {
    const { html } = render(makeDay({ noDataMinutes: 30 }));
    expect(html).toContain("No data for 30m while the grid was on");
  });

  it("omits the missing-data note when nothing was missing", () => {
    const { html } = render(makeDay());
    expect(html).not.toContain("No data for");
  });

  it("names the timezone in the footnote", () => {
    const { html } = render(makeDay());
    expect(html).toContain("Times are Africa/Kampala.");
  });

  it("says in the footnote that lights on leaves out time with no data", () => {
    const { html } = render(makeDay());
    expect(html).toContain(
      "Lights on is the share of the day that was not dark, leaving out time with no data.",
    );
  });

  it("labels the evening tile from the evening start, with an en dash", () => {
    const { root } = render(makeDay());
    const labels = Array.from(root.querySelectorAll("section")).map(
      (s) => s.querySelector("p")?.textContent,
    );
    expect(labels).toContain("Houses used 18:00\u201324:00");
    expect(labels.some((l) => l?.startsWith("Battery discharged"))).toBe(false);
    expect(labels.some((l) => l?.startsWith("Battery sold"))).toBe(false);
  });

  describe("battery chart", () => {
    it("is an image with a description of the day", () => {
      const { root } = render(makeDay());
      const svg = root.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("role")).toBe("img");
      const label = svg!.getAttribute("aria-label") ?? "";
      expect(label).toContain("Battery level from 00:00");
      expect(label).toContain("Lowest 12% at 05:30.");
      expect(label).toContain("2 power cuts.");
      expect(label).toContain("Houses dark for 1h 0m.");
    });

    it("ends a complete day's description at 24:00, as the evening strip does", () => {
      const { root } = render(makeDay());
      const label = root.querySelector("svg")!.getAttribute("aria-label") ?? "";
      expect(label).toContain("from 00:00 to 24:00.");
    });

    it("ends a partial day's description at the time read", () => {
      const { root } = render(
        makeDay({
          readUntilMs: at(14, 15),
          evening: [],
          eveningHours: { battery: 0, battery_and_grid: 0, grid: 0, dark: 0, no_data: 0 },
        }),
      );
      const label = root.querySelector("svg")!.getAttribute("aria-label") ?? "";
      expect(label).toContain("from 00:00 to 14:15.");
    });

    it("breaks the battery line at a missing bin", () => {
      const { root } = render(makeDay());
      const lines = root.querySelectorAll("path.stroke-success");
      expect(lines).toHaveLength(2);
    });
  });

  describe("evening strip", () => {
    function segments(root: HTMLElement): HTMLElement[] {
      const strip = Array.from(root.querySelectorAll('[role="img"]')).find(
        (el) => el.tagName.toLowerCase() === "div",
      );
      if (!strip) throw new Error("No evening strip");
      return Array.from(strip.children) as HTMLElement[];
    }

    it("is an image labelled with the hours of each supply", () => {
      const { root } = render(makeDay());
      const strip = Array.from(root.querySelectorAll('[role="img"]')).find(
        (el) => el.tagName.toLowerCase() === "div",
      );
      expect(strip?.getAttribute("aria-label")).toBe(
        "Battery 3.0 h, Battery + grid 1.0 h, Grid alone 1.0 h, Dark 1.0 h",
      );
    });

    it("has segment widths that sum to 100% for a complete evening", () => {
      const { root } = render(makeDay());
      const widths = segments(root).map((el) => parseFloat(el.style.width));
      expect(widths).toHaveLength(4);
      expect(widths[0]).toBeCloseTo(50, 5);
      expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    });

    it("lists 'No data' only when some of the evening had no data", () => {
      const { html: without } = render(makeDay());
      expect(without).not.toContain("No data");

      const { html: withGap } = render(
        makeDay({
          evening: [
            { startMs: at(18), endMs: at(23), supply: "battery" },
            { startMs: at(23), endMs: at(24), supply: "no_data" },
          ],
          eveningHours: { battery: 5, battery_and_grid: 0, grid: 0, dark: 0, no_data: 1 },
        }),
      );
      expect(withGap).toContain("No data");
    });
  });

  it("uses token colour classes only, no hard-coded Tailwind palette", () => {
    const palette = /\b(?:bg|text|fill|stroke|border)-(?:red|blue|green|gray|slate|zinc|amber|orange|yellow|emerald)-\d/;
    for (const day of [
      makeDay(),
      makeDay(NULL_DAY),
      makeDay({ solarEstimated: true, noDataMinutes: 30, readUntilMs: at(20) }),
    ]) {
      const { html } = render(day);
      expect(html).not.toMatch(palette);
    }
  });
});

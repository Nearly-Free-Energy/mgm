/**
 * The `billing.period-missing` signals: the previous calendar month in each
 * microgrid's own zone, from the 2nd of the month there and not before; a
 * period with any day in that month counts; one warning per microgrid, by
 * name, capped, leading to its billing periods; fixed copy with no tenant.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { signalOutSchema } from "@/lib/gui/host/server/model-schema";
import { MAX_SIGNALS_PER_SOURCE } from "@/lib/gui/surface";
import { PERIOD_MISSING_EXAMPLES } from "../period-missing-examples";
import { buildPeriodMissingSignals, expectedMonth, periodTouches, REPORT_FROM_DAY } from "../period-missing-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7f40000-0000-4000-8000-0000000000a1";
const OCTOBER = { start_date: "2026-10-01", end_date: "2026-10-31" };

describe("expectedMonth", () => {
  it("is reported from the 2nd", () => {
    expect(REPORT_FROM_DAY).toBe(2);
  });

  it("names last month from the start of the 2nd east of UTC (Kampala, UTC+3), and nothing before", () => {
    // 2026-11-01T21:00Z is midnight of 2 November in Kampala.
    expect(expectedMonth("Africa/Kampala", new Date("2026-11-01T20:59:59Z"))).toBeNull();
    expect(expectedMonth("Africa/Kampala", new Date("2026-11-01T21:00:00Z"))).toEqual(OCTOBER);
  });

  it("names last month from the start of the 2nd west of UTC (Los Angeles, UTC-8 in November), and nothing before", () => {
    // 2026-11-02T08:00Z is midnight of 2 November in Los Angeles; at 07:59Z it is already the 2nd in UTC.
    expect(expectedMonth("America/Los_Angeles", new Date("2026-11-02T07:59:59Z"))).toBeNull();
    expect(expectedMonth("America/Los_Angeles", new Date("2026-11-02T08:00:00Z"))).toEqual(OCTOBER);
  });

  it("names last month in the zone's own calendar, across a year", () => {
    expect(expectedMonth("Africa/Kampala", new Date("2027-01-20T09:00:00Z"))).toEqual({ start_date: "2026-12-01", end_date: "2026-12-31" });
    // The last day of the month west of UTC, while it is already the 1st in UTC: still that month's "last month".
    expect(expectedMonth("America/Los_Angeles", new Date("2026-12-01T05:00:00Z"))).toEqual({ start_date: "2026-10-01", end_date: "2026-10-31" });
  });

  it("reads a zone the runtime cannot resolve as UTC", () => {
    expect(expectedMonth("Kampala", new Date("2026-11-01T23:59:59Z"))).toBeNull();
    expect(expectedMonth("Kampala", new Date("2026-11-02T00:00:00Z"))).toEqual(OCTOBER);
  });
});

describe("periodTouches", () => {
  it("counts a period with any day in the month, and not one that only borders it", () => {
    expect(periodTouches({ start_date: "2026-10-01", end_date: "2026-10-31" }, OCTOBER)).toBe(true);
    expect(periodTouches({ start_date: "2026-09-15", end_date: "2026-10-01" }, OCTOBER)).toBe(true);
    expect(periodTouches({ start_date: "2026-10-31", end_date: "2026-11-14" }, OCTOBER)).toBe(true);
    expect(periodTouches({ start_date: "2026-10-10", end_date: "2026-10-12" }, OCTOBER)).toBe(true);
    expect(periodTouches({ start_date: "2026-09-01", end_date: "2026-09-30" }, OCTOBER)).toBe(false);
    expect(periodTouches({ start_date: "2026-11-01", end_date: "2026-11-30" }, OCTOBER)).toBe(false);
  });
});

describe("buildPeriodMissingSignals", () => {
  const NOW = new Date("2026-11-20T09:00:00Z");

  it("asks for last month's period at the microgrid's billing periods, as a warning", () => {
    expect(buildPeriodMissingSignals(fmt, [{ id: MG, name: "North site", timezone: "Africa/Kampala" }], NOW)).toEqual([
      {
        id: MG,
        kind: "your-move",
        severity: "warn",
        title: "North site: no billing period for October 2026",
        facts: [{ t: "text", text: "1 Oct 2026 – 31 Oct 2026" }],
        entity: { kind: "microgrid", id: MG, label: "North site" },
        href: `/microgrids/${MG}/billing`,
        // Midnight of 2 November in Kampala.
        at: "2026-11-01T21:00:00.000Z",
        due: "2026-11-02",
      },
    ]);
  });

  it("leaves out a microgrid whose zone has not reached the 2nd yet", () => {
    // 2026-11-01T22:00Z: 2 November in Kampala, 1 November in Los Angeles.
    const out = buildPeriodMissingSignals(
      fmt,
      [
        { id: "east", name: "East", timezone: "Africa/Kampala" },
        { id: "west", name: "West", timezone: "America/Los_Angeles" },
      ],
      new Date("2026-11-01T22:00:00Z"),
    );
    expect(out.map((s) => s.id)).toEqual(["east"]);
  });

  it(`lists microgrids by name and stops at ${MAX_SIGNALS_PER_SOURCE}`, () => {
    const many = Array.from({ length: MAX_SIGNALS_PER_SOURCE + 3 }, (_, i) => ({
      id: `m${i}`,
      name: `Site ${String(MAX_SIGNALS_PER_SOURCE + 3 - i).padStart(3, "0")}`,
      timezone: "Africa/Kampala",
    }));
    const out = buildPeriodMissingSignals(fmt, many, NOW);
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(out[0].title).toBe("Site 001: no billing period for October 2026");
  });

  it("returns signals a watcher may send, as the examples are", () => {
    for (const s of PERIOD_MISSING_EXAMPLES) expect(signalOutSchema.safeParse(s).success).toBe(true);
    expect(PERIOD_MISSING_EXAMPLES.map((s) => [s.severity, s.title])).toEqual([
      ["warn", "Buvuma: no billing period for October 2026"],
      ["warn", "Kiwumu: no billing period for October 2026"],
    ]);
  });
});

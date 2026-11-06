import { describe, expect, it } from "vitest";
import {
  EVENING_START_HOUR,
  GRID_PRESENT_MIN_V,
  SOC_CHECK_HOUR,
  SUPPLY_MIN_W,
  computeSiteDay,
  type SiteSourceAvailability,
} from "../site-operations";
import type { SiteSamples } from "../types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BIN_MINUTES = 5;
const BIN_MS = BIN_MINUTES * MINUTE;

const KAMPALA = "Africa/Kampala";
const DATE = "2026-11-05";
/** 00:00 on 5 Nov 2026 in Kampala (UTC+3, no DST). */
const DAY_START = Date.parse("2026-11-04T21:00:00Z");
const DAY_END = DAY_START + 24 * HOUR;
const AFTER_DAY = DAY_END + HOUR;

/** Local Kampala wall-clock time on DATE, as epoch ms. */
const at = (hh: number, mm = 0) => DAY_START + (hh * 60 + mm) * MINUTE;
/** Minutes since local midnight of a bin start. */
const minuteOf = (atMs: number) => (atMs - DAY_START) / MINUTE;

const ALL_SOURCES: SiteSourceAvailability = {
  battery: true,
  gridMeter: true,
  load: true,
  pv: false,
};

type BinValues = {
  soc?: number | null;
  batteryW?: number | null;
  gridW?: number | null;
  volts?: number | null;
  loadW?: number | null;
  pvW?: number | null;
};

/** A normal bin: grid present, battery charging gently, houses drawing. */
const NORMAL: BinValues = {
  soc: 80,
  batteryW: -100,
  gridW: 400,
  volts: 230,
  loadW: 300,
  pvW: null,
};

/**
 * SiteSamples from a per-bin generator. `gen` gets the bin's minutes since
 * local midnight and its epoch ms; returning `null` leaves the bin out
 * entirely (a gap), returning `{}` gives an all-null row.
 */
function makeSamples(
  gen: (minute: number, atMs: number) => BinValues | null,
  opts: { startMs?: number; endMs?: number; binMs?: number } = {}
): SiteSamples {
  const startMs = opts.startMs ?? DAY_START;
  const endMs = opts.endMs ?? DAY_END;
  const binMs = opts.binMs ?? BIN_MS;
  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
  };
  for (let t = startMs; t < endMs; t += binMs) {
    const v = gen((t - DAY_START) / MINUTE, t);
    if (v === null) continue;
    pushSample(out, t, v);
  }
  return out;
}

function pushSample(out: SiteSamples, t: number, v: BinValues) {
  out.timestamps.push(t);
  out.batterySocPct.push(v.soc ?? null);
  out.batteryPowerW.push(v.batteryW ?? null);
  out.gridPowerW.push(v.gridW ?? null);
  out.gridVoltageV.push(v.volts ?? null);
  out.loadPowerW.push(v.loadW ?? null);
  out.pvPowerW.push(v.pvW ?? null);
}

function concat(...parts: SiteSamples[]): SiteSamples {
  const out = makeSamples(() => null, { startMs: 0, endMs: 0 });
  for (const p of parts) {
    out.timestamps.push(...p.timestamps);
    out.batterySocPct.push(...p.batterySocPct);
    out.batteryPowerW.push(...p.batteryPowerW);
    out.gridPowerW.push(...p.gridPowerW);
    out.gridVoltageV.push(...p.gridVoltageV);
    out.loadPowerW.push(...p.loadPowerW);
    out.pvPowerW.push(...p.pvPowerW);
  }
  return out;
}

function run(
  samples: SiteSamples,
  overrides: Partial<{
    date: string;
    timezone: string;
    sources: SiteSourceAvailability;
    nowMs: number;
    resolutionMinutes: number;
  }> = {}
) {
  return computeSiteDay({
    date: DATE,
    timezone: KAMPALA,
    samples,
    sources: ALL_SOURCES,
    resolutionMinutes: BIN_MINUTES,
    nowMs: AFTER_DAY,
    ...overrides,
  });
}

/** Local minute ranges [from, to) → TimeRange list. */
const rangesAt = (...pairs: [number, number][]) =>
  pairs.map(([from, to]) => ({ startMs: DAY_START + from * MINUTE, endMs: DAY_START + to * MINUTE }));

const inRange = (m: number, from: number, to: number) => m >= from && m < to;

describe("computeSiteDay — constants", () => {
  it("matches the site report's definitions", () => {
    expect(GRID_PRESENT_MIN_V).toBe(115);
    expect(SUPPLY_MIN_W).toBe(50);
    expect(EVENING_START_HOUR).toBe(18);
    expect(SOC_CHECK_HOUR).toBe(17);
  });
});

describe("computeSiteDay — day frame", () => {
  it("frames a full Kampala day with 288 five-minute bins and 3-hourly marks", () => {
    const day = run(makeSamples(() => NORMAL));
    expect(day.date).toBe(DATE);
    expect(day.timezone).toBe(KAMPALA);
    expect(day.dayStartMs).toBe(DAY_START);
    expect(day.dayEndMs).toBe(DAY_END);
    expect(day.readUntilMs).toBe(DAY_END);
    expect(day.resolutionMinutes).toBe(5);
    expect(day.eveningStartMs).toBe(at(18));
    expect(day.hourMarks).toEqual(
      [0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => ({ hour, atMs: at(hour) }))
    );
    expect(day.soc).toHaveLength(288);
    expect(day.soc[0]).toEqual({ atMs: DAY_START, pct: 80 });
    expect(day.soc.at(-1)).toEqual({ atMs: at(23, 55), pct: 80 });
    expect(day.sources).toEqual(ALL_SOURCES);
  });

  it("reports a clean day: no cuts, no dark, no missing data, lights on 100%", () => {
    const day = run(makeSamples(() => NORMAL));
    expect(day.cuts).toEqual([]);
    expect(day.cutMinutes).toBe(0);
    expect(day.dark).toEqual([]);
    expect(day.darkMinutes).toBe(0);
    expect(day.noDataMinutes).toBe(0);
    expect(day.lightsOnPct).toBe(100);
  });

  it("Europe/London spring-forward day (2026-03-29) is 23 hours long", () => {
    const date = "2026-03-29";
    const start = Date.parse("2026-03-29T00:00:00Z"); // 00:00 GMT
    const end = Date.parse("2026-03-29T23:00:00Z"); // 00:00 BST next day
    const samples = makeSamples(() => NORMAL, { startMs: start, endMs: end });
    const day = run(samples, { date, timezone: "Europe/London", nowMs: end + HOUR });
    expect(day.dayStartMs).toBe(start);
    expect(day.dayEndMs).toBe(end);
    expect(day.readUntilMs).toBe(end);
    expect(day.soc).toHaveLength(23 * 12);
    expect(day.hourMarks).toEqual([
      { hour: 0, atMs: start },
      { hour: 3, atMs: Date.parse("2026-03-29T02:00:00Z") },
      { hour: 6, atMs: Date.parse("2026-03-29T05:00:00Z") },
      { hour: 9, atMs: Date.parse("2026-03-29T08:00:00Z") },
      { hour: 12, atMs: Date.parse("2026-03-29T11:00:00Z") },
      { hour: 15, atMs: Date.parse("2026-03-29T14:00:00Z") },
      { hour: 18, atMs: Date.parse("2026-03-29T17:00:00Z") },
      { hour: 21, atMs: Date.parse("2026-03-29T20:00:00Z") },
      { hour: 24, atMs: end },
    ]);
    expect(day.eveningStartMs).toBe(Date.parse("2026-03-29T17:00:00Z"));
    expect(day.lightsOnPct).toBe(100);
    const total = Object.values(day.eveningHours).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(6, 10);
  });

  it("Europe/London fall-back day (2026-10-25) is 25 hours long", () => {
    const date = "2026-10-25";
    const start = Date.parse("2026-10-24T23:00:00Z"); // 00:00 BST
    const end = Date.parse("2026-10-26T00:00:00Z"); // 00:00 GMT next day
    const samples = makeSamples(
      (_m, t) => (t === Date.parse("2026-10-25T16:00:00Z") ? { ...NORMAL, soc: 55 } : NORMAL),
      { startMs: start, endMs: end }
    );
    const day = run(samples, { date, timezone: "Europe/London", nowMs: end + HOUR });
    expect(day.dayStartMs).toBe(start);
    expect(day.dayEndMs).toBe(end);
    expect(day.dayEndMs - day.dayStartMs).toBe(25 * HOUR);
    expect(day.soc).toHaveLength(25 * 12);
    expect(day.hourMarks.map((m) => m.atMs)).toEqual([
      start,
      Date.parse("2026-10-25T03:00:00Z"),
      Date.parse("2026-10-25T06:00:00Z"),
      Date.parse("2026-10-25T09:00:00Z"),
      Date.parse("2026-10-25T12:00:00Z"),
      Date.parse("2026-10-25T15:00:00Z"),
      Date.parse("2026-10-25T18:00:00Z"),
      Date.parse("2026-10-25T21:00:00Z"),
      end,
    ]);
    expect(day.eveningStartMs).toBe(Date.parse("2026-10-25T18:00:00Z"));
    // 17:00 GMT local is 17:00Z; the 16:00Z bin is 16:00 local, not the check hour.
    expect(day.socAtCheckHour).toBe(80);
    expect(day.lowestSoc).toEqual({
      pct: 55,
      atMs: Date.parse("2026-10-25T16:00:00Z"),
      duringCut: false,
    });
    const total = Object.values(day.eveningHours).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(6, 10);
  });

  describe("an hour inside a DST gap (Europe/Athens, 2026-03-29: 03:00 is skipped)", () => {
    const ATHENS = "Europe/Athens";
    const date = "2026-03-29";
    const start = Date.parse("2026-03-28T22:00:00Z"); // 00:00 EET
    const end = Date.parse("2026-03-29T21:00:00Z"); // 00:00 EEST next day
    const runAthens = () =>
      run(makeSamples(() => NORMAL, { startMs: start, endMs: end }), {
        date,
        timezone: ATHENS,
        nowMs: end + HOUR,
      });

    it("computes the day without throwing", () => {
      expect(runAthens).not.toThrow();
      const day = runAthens();
      expect(day.dayStartMs).toBe(start);
      expect(day.dayEndMs).toBe(end);
      expect(day.soc).toHaveLength(23 * 12);
    });

    it("resolves the skipped 03:00 mark to the first instant after the gap, 04:00 local (01:00Z)", () => {
      const day = runAthens();
      expect(day.hourMarks).toEqual([
        { hour: 0, atMs: start },
        { hour: 3, atMs: Date.parse("2026-03-29T01:00:00Z") },
        { hour: 6, atMs: Date.parse("2026-03-29T03:00:00Z") },
        { hour: 9, atMs: Date.parse("2026-03-29T06:00:00Z") },
        { hour: 12, atMs: Date.parse("2026-03-29T09:00:00Z") },
        { hour: 15, atMs: Date.parse("2026-03-29T12:00:00Z") },
        { hour: 18, atMs: Date.parse("2026-03-29T15:00:00Z") },
        { hour: 21, atMs: Date.parse("2026-03-29T18:00:00Z") },
        { hour: 24, atMs: end },
      ]);
      // 00:00 EET to 04:00 EEST is three real hours, as for any other day.
      expect(day.hourMarks[1].atMs - day.hourMarks[0].atMs).toBe(3 * HOUR);
    });

    it("keeps 17:00 and 18:00 exact, since neither falls in the gap", () => {
      const samples = makeSamples(
        (_m, t) => (t === Date.parse("2026-03-29T14:00:00Z") ? { ...NORMAL, soc: 64 } : NORMAL),
        { startMs: start, endMs: end }
      );
      const day = run(samples, { date, timezone: ATHENS, nowMs: end + HOUR });
      expect(day.eveningStartMs).toBe(Date.parse("2026-03-29T15:00:00Z")); // 18:00 EEST
      expect(day.socAtCheckHour).toBe(64); // the 17:00 EEST bin, 14:00Z
      expect(day.evening[0].startMs).toBe(Date.parse("2026-03-29T15:00:00Z"));
      const total = Object.values(day.eveningHours).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(6, 10);
    });
  });

  it("keeps every hour mark exact in a zone with no DST", () => {
    const day = run(makeSamples(() => NORMAL));
    for (const { hour, atMs } of day.hourMarks) expect(atMs).toBe(DAY_START + hour * HOUR);
    expect(day.eveningStartMs).toBe(at(EVENING_START_HOUR));
  });
});

describe("computeSiteDay — grid presence and cuts", () => {
  it("keeps a bin where the grid only flickered back inside its cut", () => {
    // A 5-minute mean of 80 V: the grid was back for about a minute.
    const samples = makeSamples((m) => {
      if (inRange(m, 600, 630)) return { ...NORMAL, volts: m === 615 ? 80 : 0, gridW: 0 };
      return NORMAL;
    });
    expect(run(samples).cuts).toEqual(rangesAt([600, 630]));
  });

  it("treats a bin whose highest phase averages below 115 V as a cut and 115 V or above as present", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 600, 660)) return { ...NORMAL, volts: 114.9, gridW: 0 };
      return { ...NORMAL, volts: 115 };
    });
    const day = run(samples);
    expect(day.cuts).toEqual(rangesAt([600, 660]));
    expect(day.cutMinutes).toBe(60);
    // Online throughout: a cut with samples arriving is not dark.
    expect(day.dark).toEqual([]);
    expect(day.lightsOnPct).toBe(100);
  });

  it("carries the grid state through bins whose voltage is null but which are online", () => {
    const samples = makeSamples((m) => {
      if (m === 600) return { ...NORMAL, volts: 0, gridW: 0 };
      if (inRange(m, 605, 630)) return { ...NORMAL, volts: null, gridW: null };
      return NORMAL;
    });
    const day = run(samples);
    expect(day.cuts).toEqual(rangesAt([600, 630]));
  });

  it("keeps a cut that spans a data gap as one cut and makes the gap dark", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 600, 630)) return { ...NORMAL, volts: 0, gridW: 0, batteryW: 500 };
      if (inRange(m, 630, 690)) return null; // gateway offline
      return NORMAL; // 11:30 grid back
    });
    const day = run(samples);
    expect(day.cuts).toEqual(rangesAt([600, 690]));
    expect(day.cutMinutes).toBe(90);
    expect(day.dark).toEqual(rangesAt([630, 690]));
    expect(day.darkMinutes).toBe(60);
    expect(day.noDataMinutes).toBe(0);
    expect(day.lightsOnPct).toBeCloseTo((100 * (1440 - 60)) / 1440, 10);
  });

  it("treats all-null rows the same as missing rows", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 600, 630)) return { ...NORMAL, volts: 0, gridW: 0 };
      if (inRange(m, 630, 690)) return {};
      return NORMAL;
    });
    const day = run(samples);
    expect(day.dark).toEqual(rangesAt([630, 690]));
    expect(day.cuts).toEqual(rangesAt([600, 690]));
  });

  it("reports a gap while the grid is present as missing data, not dark", () => {
    const samples = makeSamples((m) => (inRange(m, 720, 780) ? null : NORMAL));
    const day = run(samples);
    expect(day.dark).toEqual([]);
    expect(day.darkMinutes).toBe(0);
    expect(day.noDataMinutes).toBe(60);
    expect(day.cuts).toEqual([]);
    expect(day.lightsOnPct).toBe(100);
    expect(day.soc.find((s) => s.atMs === at(12, 30))).toEqual({ atMs: at(12, 30), pct: null });
  });

  it("reports a gap at the start of the day as missing data when the grid state is unknown", () => {
    const samples = makeSamples((m) => (m < 60 ? null : NORMAL));
    const day = run(samples);
    expect(day.dark).toEqual([]);
    expect(day.noDataMinutes).toBe(60);
    expect(day.cuts).toEqual([]);
  });

  it("returns null cuts when there is no grid meter, and never marks dark", () => {
    const samples = makeSamples((m) =>
      inRange(m, 600, 700) ? null : { ...NORMAL, volts: null, gridW: null }
    );
    const day = run(samples, { sources: { ...ALL_SOURCES, gridMeter: false } });
    expect(day.cuts).toBeNull();
    expect(day.cutMinutes).toBeNull();
    expect(day.dark).toEqual([]);
    expect(day.noDataMinutes).toBe(100);
    expect(day.lightsOnPct).toBe(100);
  });

  it("returns null cuts when the grid meter exists but never gave a voltage reading", () => {
    const samples = makeSamples(() => ({ ...NORMAL, volts: null }));
    const day = run(samples);
    expect(day.sources.gridMeter).toBe(true);
    expect(day.cuts).toBeNull();
    expect(day.cutMinutes).toBeNull();
    // An unknown grid state never makes a gap dark.
    expect(day.dark).toEqual([]);
  });

  it("returns null cuts when the gateway was offline all day and the grid state is unknown", () => {
    const day = run(makeSamples(() => null));
    expect(day.cuts).toBeNull();
    expect(day.cutMinutes).toBeNull();
    expect(day.dark).toEqual([]);
    expect(day.noDataMinutes).toBe(1440);
  });

  it("knows the cuts from the previous day's last voltage even with no voltage reading today", () => {
    const tail = makeSamples(() => NORMAL, { startMs: at(-1), endMs: DAY_START });
    const today = makeSamples(() => ({ ...NORMAL, volts: null }));
    const day = run(concat(tail, today));
    expect(day.cuts).toEqual([]);
    expect(day.cutMinutes).toBe(0);
  });

  it("knows the cuts once a single voltage reading arrives, counting from that reading", () => {
    const samples = makeSamples((m) => {
      if (m < 600) return { ...NORMAL, volts: null };
      if (m === 600) return { ...NORMAL, volts: 0, gridW: 0 };
      return { ...NORMAL, volts: null };
    });
    const day = run(samples);
    // Before 10:00 the state is unknown, not a cut; from 10:00 the cut carries.
    expect(day.cuts).toEqual(rangesAt([600, 1440]));
    expect(day.cutMinutes).toBe(840);
  });
});

describe("computeSiteDay — carry-in from the previous day", () => {
  it("starts the day dark from 00:00 when the previous day ended in a cut and the gateway is offline", () => {
    const tail = makeSamples(
      (m) => (m >= -15 ? { ...NORMAL, volts: 0, gridW: 0, batteryW: 300 } : NORMAL),
      { startMs: at(-1), endMs: DAY_START }
    );
    const today = makeSamples((m) => {
      if (m < 60) return null; // dark
      if (m < 120) return { ...NORMAL, volts: 0, gridW: 0 }; // back, still cut
      return NORMAL;
    });
    const day = run(concat(tail, today));
    expect(day.dark).toEqual(rangesAt([0, 60]));
    expect(day.cuts).toEqual(rangesAt([0, 120]));
    expect(day.noDataMinutes).toBe(0);
    expect(day.lightsOnPct).toBeCloseTo((100 * (1440 - 60)) / 1440, 10);
    // The previous day's bins are not part of the day.
    expect(day.soc).toHaveLength(288);
    expect(day.soc[0].atMs).toBe(DAY_START);
  });

  it("uses the last pre-day voltage, ignoring later nulls", () => {
    const tail = makeSamples(
      (m) => {
        if (m < -10) return { ...NORMAL, volts: 0, gridW: 0 };
        return { ...NORMAL, volts: null }; // last two pre-day rows lack voltage
      },
      { startMs: at(-1), endMs: DAY_START }
    );
    const today = makeSamples((m) => (m < 30 ? null : NORMAL));
    const day = run(concat(tail, today));
    expect(day.dark).toEqual(rangesAt([0, 30]));
  });

  it("does not start dark when the previous day ended with the grid present", () => {
    const tail = makeSamples(
      (m) => (m < -30 ? { ...NORMAL, volts: 0 } : NORMAL),
      { startMs: at(-1), endMs: DAY_START }
    );
    const today = makeSamples((m) => (m < 30 ? null : NORMAL));
    const day = run(concat(tail, today));
    expect(day.dark).toEqual([]);
    expect(day.noDataMinutes).toBe(30);
    expect(day.cuts).toEqual([]);
  });
});

describe("computeSiteDay — lights on", () => {
  it("is (known minutes − dark minutes) / known minutes, leaving no-data time out", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 300, 310)) return { ...NORMAL, volts: 0 };
      if (inRange(m, 310, 400)) return null; // dark 90
      if (inRange(m, 800, 830)) return null; // no data 30, grid present
      return NORMAL;
    });
    const day = run(samples);
    expect(day.darkMinutes).toBe(90);
    expect(day.noDataMinutes).toBe(30);
    const known = 1440 - 30;
    expect(day.lightsOnPct).toBeCloseTo((100 * (known - 90)) / known, 10);
  });

  it("does not count no-data time as lit", () => {
    // 12 hours of no data while the grid was present, then 6 hours dark.
    const samples = makeSamples((m) => {
      if (m < 720) return null;
      if (m === 720) return { ...NORMAL, volts: 0 };
      if (inRange(m, 725, 1085)) return null; // dark 360
      return NORMAL;
    });
    const day = run(samples);
    // Unknown grid state before 12:00: missing data, not lit and not dark.
    expect(day.noDataMinutes).toBe(720);
    expect(day.darkMinutes).toBe(360);
    const known = 1440 - 720;
    expect(day.lightsOnPct).toBeCloseTo((100 * (known - 360)) / known, 10);
    expect(day.lightsOnPct).toBeCloseTo(50, 10);
  });

  it("is 0 when every known minute was dark", () => {
    const tail = makeSamples(() => ({ ...NORMAL, volts: 0 }), { startMs: at(-1), endMs: DAY_START });
    const day = run(concat(tail, makeSamples(() => null)));
    expect(day.darkMinutes).toBe(1440);
    expect(day.noDataMinutes).toBe(0);
    expect(day.lightsOnPct).toBe(0);
  });

  it("is null when no minute of the period has a known state", () => {
    const day = run(makeSamples(() => null));
    expect(day.noDataMinutes).toBe(1440);
    expect(day.darkMinutes).toBe(0);
    expect(day.lightsOnPct).toBeNull();
  });
});

describe("computeSiteDay — a day still in progress", () => {
  it("rounds readUntil up to the end of the current bin and ignores later samples", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 660, 670)) return { ...NORMAL, volts: 0 };
      if (inRange(m, 670, 725)) return null; // dark through now
      if (m >= 725) return { ...NORMAL, soc: 1, volts: 0, batteryW: 5000 }; // future rows
      return NORMAL;
    });
    const nowMs = at(12, 2);
    const day = run(samples, { nowMs });
    expect(day.readUntilMs).toBe(at(12, 5));
    expect(day.soc).toHaveLength(145);
    expect(day.soc.at(-1)?.atMs).toBe(at(12, 0));
    expect(day.dark).toEqual(rangesAt([670, 725]));
    expect(day.cuts).toEqual(rangesAt([660, 725]));
    // Over the elapsed 725 minutes only, not the whole day.
    expect(day.lightsOnPct).toBeCloseTo((100 * (725 - 55)) / 725, 10);
    expect(day.lowestSoc?.pct).toBe(80);
    expect(day.eveningDischargeKwh).toBe(0);
    expect(day.evening).toEqual([]);
    expect(day.socAtCheckHour).toBeNull();
  });

  it("stops exactly at now when now is on a bin boundary", () => {
    const day = run(makeSamples(() => NORMAL), { nowMs: at(12, 0) });
    expect(day.readUntilMs).toBe(at(12, 0));
    expect(day.soc).toHaveLength(144);
  });

  it("reads nothing for a day that has not started", () => {
    const day = run(makeSamples(() => NORMAL), { nowMs: DAY_START - HOUR });
    expect(day.readUntilMs).toBe(DAY_START);
    expect(day.soc).toEqual([]);
    expect(day.lightsOnPct).toBeNull();
    expect(day.lowestSoc).toBeNull();
    expect(day.dark).toEqual([]);
    expect(day.darkMinutes).toBe(0);
    expect(day.noDataMinutes).toBe(0);
    // No bin read, so no voltage seen: cuts are unknown, not zero.
    expect(day.cuts).toBeNull();
    expect(day.cutMinutes).toBeNull();
    expect(day.evening).toEqual([]);
  });

  it("caps readUntil at the end of a finished day", () => {
    const day = run(makeSamples(() => NORMAL), { nowMs: DAY_END + 5 * 24 * HOUR });
    expect(day.readUntilMs).toBe(DAY_END);
  });
});

describe("computeSiteDay — energy", () => {
  it("counts only positive battery power in [18:00, 24:00) as evening discharge", () => {
    const samples = makeSamples((m) => {
      if (m === 17 * 60 + 55) return { ...NORMAL, batteryW: 1200 }; // before window
      if (inRange(m, 18 * 60, 19 * 60)) return { ...NORMAL, batteryW: 1200 }; // 1.2 kWh
      if (inRange(m, 19 * 60, 20 * 60)) return { ...NORMAL, batteryW: -500 }; // charging
      if (inRange(m, 20 * 60, 21 * 60)) return { ...NORMAL, batteryW: 600 }; // 0.6 kWh
      if (inRange(m, 21 * 60, 22 * 60)) return { ...NORMAL, batteryW: null };
      return { ...NORMAL, batteryW: 0 };
    });
    const day = run(samples);
    expect(day.eveningDischargeKwh).toBeCloseTo(1.8, 10);
  });

  it("returns null evening discharge without a battery", () => {
    const day = run(makeSamples(() => NORMAL), { sources: { ...ALL_SOURCES, battery: false } });
    expect(day.eveningDischargeKwh).toBeNull();
  });

  it("uses the solar meter when there is one, clipping negative readings", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 540, 900)) return { ...NORMAL, pvW: 1000 }; // 6 h × 1 kW
      return { ...NORMAL, pvW: -20 }; // night self-consumption
    });
    const day = run(samples, { sources: { ...ALL_SOURCES, pv: true } });
    expect(day.solarEstimated).toBe(false);
    expect(day.solarKwh).toBeCloseTo(6, 10);
  });

  it("estimates solar as load − grid − battery, clipped at 0 and skipping incomplete bins", () => {
    const samples = makeSamples((m) => {
      // 09:00–10:00: 1000 − 200 − 300 = 500 W → 0.5 kWh
      if (inRange(m, 540, 600)) return { ...NORMAL, loadW: 1000, gridW: 200, batteryW: 300 };
      // 10:00–11:00: battery charging from solar: 400 − 0 − (−600) = 1000 W → 1 kWh
      if (inRange(m, 600, 660)) return { ...NORMAL, loadW: 400, gridW: 0, batteryW: -600 };
      // 11:00–12:00: one value missing → skipped even though it would be large
      if (inRange(m, 660, 720)) return { ...NORMAL, loadW: 5000, gridW: null, batteryW: 0 };
      // Elsewhere the balance is negative → clipped to 0.
      return { ...NORMAL, loadW: 300, gridW: 400, batteryW: 0 };
    });
    const day = run(samples);
    expect(day.solarEstimated).toBe(true);
    expect(day.solarKwh).toBeCloseTo(1.5, 10);
  });

  it("returns null solar when neither a solar meter nor the full balance is available", () => {
    const samples = makeSamples(() => NORMAL);
    for (const missing of ["load", "battery", "gridMeter"] as const) {
      const day = run(samples, { sources: { ...ALL_SOURCES, pv: false, [missing]: false } });
      expect(day.solarKwh).toBeNull();
      expect(day.solarEstimated).toBe(false);
    }
  });
});

describe("computeSiteDay — battery level", () => {
  it("finds the lowest state of charge, its time and whether it was during a cut", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 1170, 1200)) return { ...NORMAL, volts: 0, soc: 100 - (m - 1150) };
      if (m === 300) return { ...NORMAL, soc: 25 };
      return NORMAL;
    });
    // Cut bins 19:30–19:55 bottom out at 55%, above the 25% at 05:00.
    const day = run(samples);
    expect(day.lowestSoc).toEqual({ pct: 25, atMs: at(5, 0), duringCut: false });

    const deeper = run(
      makeSamples((m) => {
        if (inRange(m, 1170, 1200)) return { ...NORMAL, volts: 0, soc: 20 - (m - 1170) / 5 };
        return NORMAL;
      })
    );
    expect(deeper.lowestSoc).toEqual({ pct: 15, atMs: at(19, 55), duringCut: true });
  });

  it("keeps the first bin when the lowest level repeats", () => {
    const samples = makeSamples((m) => (m === 120 || m === 240 ? { ...NORMAL, soc: 30 } : NORMAL));
    expect(run(samples).lowestSoc?.atMs).toBe(at(2, 0));
  });

  it("returns null lowest level when no state of charge arrived", () => {
    const day = run(makeSamples(() => ({ ...NORMAL, soc: null })));
    expect(day.lowestSoc).toBeNull();
  });

  it("reports the state of charge at the 17:00 bin", () => {
    const samples = makeSamples((m) => {
      if (m === 17 * 60) return { ...NORMAL, soc: 91 };
      if (m === 17 * 60 + 5 || m === 16 * 60 + 55) return { ...NORMAL, soc: 12 };
      return NORMAL;
    });
    expect(run(samples).socAtCheckHour).toBe(91);
  });

  it("returns null at the check hour when the 17:00 bin is missing", () => {
    const samples = makeSamples((m) => (m === 17 * 60 ? null : NORMAL));
    expect(run(samples).socAtCheckHour).toBeNull();
  });
});

describe("computeSiteDay — evening supply", () => {
  it("merges evening bins into classified segments that sum to six hours", () => {
    const samples = makeSamples((m) => {
      const h = m / 60;
      if (h < 18) return NORMAL;
      // 18:00–19:00 battery and grid together
      if (h < 19) return { ...NORMAL, batteryW: 300, gridW: 300 };
      // 19:00–19:30 cut, battery carrying the load
      if (h < 19.5) return { ...NORMAL, volts: 0, gridW: 0, batteryW: 400 };
      // 19:30–20:00 offline during the cut → dark
      if (h < 20) return null;
      // 20:00–20:30 still cut, battery barely discharging → battery
      if (h < 20.5) return { ...NORMAL, volts: 0, gridW: 0, batteryW: 10 };
      // 20:30–21:00 grid back, battery charging → grid
      if (h < 21) return { ...NORMAL, gridW: 400, batteryW: -200 };
      // 21:00–21:30 offline with grid present → no data
      if (h < 21.5) return null;
      // 21:30–24:00 thresholds are strict: 50 W is not supplying → grid
      return { ...NORMAL, batteryW: SUPPLY_MIN_W, gridW: 60 };
    });
    const day = run(samples);
    expect(day.evening).toEqual([
      { ...rangesAt([1080, 1140])[0], supply: "battery_and_grid" },
      { ...rangesAt([1140, 1170])[0], supply: "battery" },
      { ...rangesAt([1170, 1200])[0], supply: "dark" },
      { ...rangesAt([1200, 1230])[0], supply: "battery" },
      { ...rangesAt([1230, 1260])[0], supply: "grid" },
      { ...rangesAt([1260, 1290])[0], supply: "no_data" },
      { ...rangesAt([1290, 1440])[0], supply: "grid" },
    ]);
    expect(day.eveningHours.battery_and_grid).toBeCloseTo(1, 10);
    expect(day.eveningHours.battery).toBeCloseTo(1, 10);
    expect(day.eveningHours.dark).toBeCloseTo(0.5, 10);
    expect(day.eveningHours.grid).toBeCloseTo(3, 10);
    expect(day.eveningHours.no_data).toBeCloseTo(0.5, 10);
    const total = Object.values(day.eveningHours).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(6, 10);
  });

  it("does not count grid import as supply during a cut", () => {
    const samples = makeSamples((m) =>
      m >= 1080 ? { ...NORMAL, volts: 0, gridW: 500, batteryW: 400 } : NORMAL
    );
    const day = run(samples);
    expect(day.evening).toEqual([{ ...rangesAt([1080, 1440])[0], supply: "battery" }]);
    expect(day.eveningHours.battery).toBeCloseTo(6, 10);
  });

  it("labels an online bin 'grid' when the grid state is unknown but import is above 50 W", () => {
    const samples = makeSamples((m) => {
      const unknown = { ...NORMAL, volts: null, batteryW: -100 };
      if (inRange(m, 1080, 1140)) return { ...unknown, gridW: SUPPLY_MIN_W + 1 }; // grid
      if (inRange(m, 1140, 1200)) return { ...unknown, gridW: SUPPLY_MIN_W }; // not above
      if (inRange(m, 1200, 1260)) return { ...unknown, gridW: null }; // no reading
      if (inRange(m, 1260, 1320)) return { ...unknown, gridW: 400, batteryW: 300 }; // both
      if (inRange(m, 1320, 1380)) return { ...unknown, gridW: 0, batteryW: 300 }; // battery
      return { ...unknown, gridW: 400 };
    });
    const day = run(samples);
    expect(day.cuts).toBeNull();
    expect(day.evening).toEqual([
      { ...rangesAt([1080, 1140])[0], supply: "grid" },
      { ...rangesAt([1140, 1260])[0], supply: "no_data" },
      { ...rangesAt([1260, 1320])[0], supply: "battery_and_grid" },
      { ...rangesAt([1320, 1380])[0], supply: "battery" },
      { ...rangesAt([1380, 1440])[0], supply: "grid" },
    ]);
    expect(day.eveningHours.grid).toBeCloseTo(2, 10);
    expect(day.eveningHours.no_data).toBeCloseTo(2, 10);
  });

  it("keeps an offline bin with an unknown grid state as no data, not grid", () => {
    const samples = makeSamples((m) =>
      m >= 1080 ? null : { ...NORMAL, volts: null, gridW: 400 }
    );
    const day = run(samples);
    expect(day.evening).toEqual([{ ...rangesAt([1080, 1440])[0], supply: "no_data" }]);
  });
});

describe("computeSiteDay — sample alignment", () => {
  it("puts samples not aligned to bin starts in the bin they fall in", () => {
    const samples = makeSamples(() => null);
    pushSample(samples, at(10, 3), { ...NORMAL, soc: 42 });
    pushSample(samples, at(10, 5) + 4 * MINUTE + 59_999, { ...NORMAL, soc: 43 });
    const day = run(samples);
    expect(day.soc.find((s) => s.atMs === at(10, 0))?.pct).toBe(42);
    expect(day.soc.find((s) => s.atMs === at(10, 5))?.pct).toBe(43);
    expect(day.soc.find((s) => s.atMs === at(10, 10))?.pct).toBeNull();
  });

  it("keeps the first of duplicate timestamps and of several samples in one bin", () => {
    const samples = makeSamples(() => null);
    pushSample(samples, at(10, 0), { ...NORMAL, soc: 40 });
    pushSample(samples, at(10, 0), { ...NORMAL, soc: 60 });
    pushSample(samples, at(11, 1), { ...NORMAL, soc: 41 });
    pushSample(samples, at(11, 3), { ...NORMAL, soc: 61 });
    const day = run(samples);
    expect(day.soc.find((s) => s.atMs === at(10, 0))?.pct).toBe(40);
    expect(day.soc.find((s) => s.atMs === at(11, 0))?.pct).toBe(41);
  });
});

describe("computeSiteDay — reference day", () => {
  // Shape of the day: a morning cut 05:45–08:20 in which the battery ran out
  // at 06:20 and the gateway went dark until the grid came back; an evening
  // cut 19:00–21:40 in which the battery ran out at 19:35.
  function referenceDay(): SiteSamples {
    const tail = makeSamples(() => ({ ...NORMAL, soc: 35 }), {
      startMs: at(-1),
      endMs: DAY_START,
    });
    const today = makeSamples((m) => {
      const cutMorning = { volts: 0, gridW: 0, loadW: 400, pvW: null };
      const cutEvening = { volts: 0, gridW: 0, loadW: 800, pvW: null };
      if (m < 345) return { ...NORMAL, soc: 35, batteryW: 0, gridW: 300 };
      // 05:45–06:20 battery carries the houses, 35% → 21%
      if (m < 380) return { ...cutMorning, batteryW: 400, soc: 35 - ((m - 345) / 5) * 2 };
      if (m < 500) return null; // 06:20–08:20 dark
      // 08:20 grid back; battery recharges through the day
      if (m < 17 * 60) {
        const soc = Math.min(95, 25 + Math.floor((m - 500) / 5) * 0.75);
        return { ...NORMAL, soc, batteryW: -800, gridW: 900, loadW: 300 };
      }
      if (m < 18 * 60) return { ...NORMAL, soc: 95, batteryW: 0, gridW: 300, loadW: 300 };
      // 18:00–19:00 battery and grid share the evening load
      if (m < 19 * 60) return { ...NORMAL, soc: 95 - ((m - 1080) / 5) * 3, batteryW: 500, gridW: 300 };
      // 19:00–19:35 cut, battery to cut-off
      if (m < 1175) return { ...cutEvening, batteryW: 800, soc: 59 - ((m - 1140) / 5) * 6 };
      if (m < 1300) return null; // 19:35–21:40 dark
      return { ...NORMAL, soc: 30, batteryW: -600, gridW: 900 }; // 21:40 grid back
    });
    return concat(tail, today);
  }

  it("derives dark periods, cuts and lights-on share", () => {
    const day = run(referenceDay());
    expect(day.dark).toEqual(rangesAt([380, 500], [1175, 1300]));
    expect(day.darkMinutes).toBe(245);
    expect(day.noDataMinutes).toBe(0);
    expect(day.lightsOnPct).not.toBeNull();
    expect(day.lightsOnPct!).toBeGreaterThan(82);
    expect(day.lightsOnPct!).toBeLessThan(83);
    expect(day.lightsOnPct).toBeCloseTo((100 * 1195) / 1440, 10);

    expect(day.cuts).toEqual(rangesAt([345, 500], [1140, 1300]));
    expect(day.cutMinutes).toBe(315);
    for (const d of day.dark) {
      expect(
        day.cuts!.some((c) => c.startMs <= d.startMs && d.endMs <= c.endMs)
      ).toBe(true);
    }
  });

  it("derives battery level, evening discharge and evening supply", () => {
    const day = run(referenceDay());
    expect(day.socAtCheckHour).toBe(95);
    // Both cuts bottom out at 23% (06:15 and 19:30); the first one wins.
    expect(day.lowestSoc).toEqual({ pct: 23, atMs: at(6, 15), duringCut: true });
    // 18:00–19:00 at 500 W (0.5 kWh) + 19:00–19:35 at 800 W (7 bins → 0.4667 kWh)
    expect(day.eveningDischargeKwh).toBeCloseTo(0.5 + (800 * 35) / 60 / 1000, 10);
    expect(day.evening.map((s) => [minuteOf(s.startMs), minuteOf(s.endMs), s.supply])).toEqual([
      [1080, 1140, "battery_and_grid"],
      [1140, 1175, "battery"],
      [1175, 1300, "dark"],
      [1300, 1440, "grid"],
    ]);
    expect(day.eveningHours.dark).toBeCloseTo(125 / 60, 10);
    const total = Object.values(day.eveningHours).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(6, 10);
  });
});

describe("computeSiteDay — known minutes", () => {
  it("is the period read less no-data time", () => {
    const samples = makeSamples((m) => {
      if (inRange(m, 300, 310)) return { ...NORMAL, volts: 0 };
      if (inRange(m, 310, 400)) return null; // dark 90 (known)
      if (inRange(m, 800, 830)) return null; // no data 30
      return NORMAL;
    });
    expect(run(samples).knownMinutes).toBe(1440 - 30);
  });

  it("counts only the elapsed part of a day in progress", () => {
    const day = run(makeSamples(() => NORMAL), { nowMs: at(12, 2) });
    expect(day.knownMinutes).toBe(725);
  });

  it("is 0 when nothing of the day is known, and when the day has not started", () => {
    expect(run(makeSamples(() => null)).knownMinutes).toBe(0);
    expect(run(makeSamples(() => NORMAL), { nowMs: DAY_START - HOUR }).knownMinutes).toBe(0);
  });
});

describe("computeSiteDay — flows", () => {
  it("has one flow per bin read, at the bin start, with the local hour", () => {
    const day = run(makeSamples(() => NORMAL));
    expect(day.flows).toHaveLength(288);
    expect(day.flows[0]).toMatchObject({ atMs: DAY_START, hour: 0 });
    expect(day.flows[11]).toMatchObject({ atMs: at(0, 55), hour: 0 });
    expect(day.flows[12]).toMatchObject({ atMs: at(1, 0), hour: 1 });
    expect(day.flows[18 * 12 + 6]).toMatchObject({ atMs: at(18, 30), hour: 18 });
    expect(day.flows.at(-1)).toMatchObject({ atMs: at(23, 55), hour: 23 });
    day.flows.forEach((f, i) => {
      expect(f.atMs).toBe(DAY_START + i * BIN_MS);
      expect(f.hour).toBe(Math.floor(i / 12));
    });
  });

  it("stops at the current bin for a day in progress", () => {
    const day = run(makeSamples(() => NORMAL), { nowMs: at(12, 2) });
    expect(day.flows).toHaveLength(145);
    expect(day.flows.at(-1)).toMatchObject({ atMs: at(12, 0), hour: 12 });
  });

  it("carries the battery and grid power as read, null in a gap", () => {
    const samples = makeSamples((m) => {
      if (m === 60) return { ...NORMAL, batteryW: 1500, gridW: -200 };
      if (m === 65) return null;
      return NORMAL;
    });
    const day = run(samples);
    expect(day.flows[12]).toMatchObject({ batteryW: 1500, gridW: -200 });
    expect(day.flows[13]).toEqual({
      atMs: at(1, 5),
      hour: 1,
      batteryW: null,
      gridW: null,
      solarW: null,
      gridPresent: true,
    });
    expect(day.flows[14]).toMatchObject({ batteryW: -100, gridW: 400 });
  });

  it("carries the grid state as cuts do: through gaps, and null until first known", () => {
    const samples = makeSamples((m) => {
      if (m < 60) return { ...NORMAL, volts: null };
      if (inRange(m, 60, 120)) return { ...NORMAL, volts: 0 };
      if (inRange(m, 120, 180)) return null; // a gap during the cut
      return NORMAL;
    });
    const day = run(samples);
    expect(day.flows[0].gridPresent).toBeNull();
    expect(day.flows[11].gridPresent).toBeNull();
    expect(day.flows[12].gridPresent).toBe(false);
    expect(day.flows[30].gridPresent).toBe(false);
    expect(day.flows[36].gridPresent).toBe(true);
  });

  it("takes the grid state carried in from the previous day", () => {
    const tail = makeSamples(() => ({ ...NORMAL, volts: 0 }), { startMs: at(-1), endMs: DAY_START });
    const day = run(concat(tail, makeSamples(() => null)));
    expect(day.flows[0].gridPresent).toBe(false);
  });

  it("uses the solar meter clipped at 0 when the site has one", () => {
    const samples = makeSamples((m) => {
      if (m === 600) return { ...NORMAL, pvW: 2500 };
      if (m === 605) return { ...NORMAL, pvW: -20 };
      if (m === 610) return { ...NORMAL, pvW: null };
      return { ...NORMAL, pvW: 0 };
    });
    const day = run(samples, { sources: { ...ALL_SOURCES, pv: true } });
    expect(day.flows[120].solarW).toBe(2500);
    expect(day.flows[121].solarW).toBe(0);
    expect(day.flows[122].solarW).toBeNull();
  });

  it("prefers the solar meter over the balance", () => {
    const samples = makeSamples(() => ({ ...NORMAL, pvW: 700, loadW: 5000, gridW: 0, batteryW: 0 }));
    const day = run(samples, { sources: { ...ALL_SOURCES, pv: true } });
    expect(day.flows[0].solarW).toBe(700);
  });

  it("estimates solar as load − grid − battery clipped at 0, null when one is missing", () => {
    const samples = makeSamples((m) => {
      if (m === 600) return { ...NORMAL, loadW: 1000, gridW: 200, batteryW: 300 };
      if (m === 605) return { ...NORMAL, loadW: 400, gridW: 0, batteryW: -600 };
      if (m === 610) return { ...NORMAL, loadW: 5000, gridW: null, batteryW: 0 };
      return { ...NORMAL, loadW: 300, gridW: 400, batteryW: 0 };
    });
    const day = run(samples);
    expect(day.flows[120].solarW).toBe(500);
    expect(day.flows[121].solarW).toBe(1000);
    expect(day.flows[122].solarW).toBeNull();
    expect(day.flows[0].solarW).toBe(0);
  });

  it("has null solar on every flow when neither a solar meter nor the balance is available", () => {
    const samples = makeSamples(() => ({ ...NORMAL, pvW: 900 }));
    const day = run(samples, { sources: { ...ALL_SOURCES, pv: false, load: false } });
    expect(day.flows.every((f) => f.solarW === null)).toBe(true);
  });

  it("adds up to the day's solar kWh", () => {
    const samples = makeSamples((m) =>
      inRange(m, 540, 900) ? { ...NORMAL, pvW: 1000 } : { ...NORMAL, pvW: -20 }
    );
    const day = run(samples, { sources: { ...ALL_SOURCES, pv: true } });
    const kwh = day.flows.reduce((sum, f) => sum + ((f.solarW ?? 0) * BIN_MINUTES) / 60 / 1000, 0);
    expect(kwh).toBeCloseTo(day.solarKwh ?? NaN, 10);
  });

  it("gives local hours across a spring-forward day (Europe/London, 2026-03-29)", () => {
    const start = Date.parse("2026-03-29T00:00:00Z");
    const end = Date.parse("2026-03-29T23:00:00Z");
    const samples = makeSamples(() => NORMAL, { startMs: start, endMs: end });
    const day = run(samples, { date: "2026-03-29", timezone: "Europe/London", nowMs: end + HOUR });
    expect(day.flows).toHaveLength(23 * 12);
    // 01:00 GMT becomes 02:00 BST: local hour 1 is skipped.
    expect(day.flows[11]).toMatchObject({ atMs: start + 55 * MINUTE, hour: 0 });
    expect(day.flows[12]).toMatchObject({ atMs: start + HOUR, hour: 2 });
    expect(day.flows.some((f) => f.hour === 1)).toBe(false);
    expect(day.flows.at(-1)?.hour).toBe(23);
  });

  it("gives local hour 1 twice across a fall-back day (Europe/London, 2026-10-25)", () => {
    const start = Date.parse("2026-10-24T23:00:00Z"); // 00:00 BST
    const end = Date.parse("2026-10-26T00:00:00Z"); // 00:00 GMT next day
    const samples = makeSamples(() => NORMAL, { startMs: start, endMs: end });
    const day = run(samples, { date: "2026-10-25", timezone: "Europe/London", nowMs: end + HOUR });
    expect(day.flows).toHaveLength(25 * 12);
    expect(day.flows.filter((f) => f.hour === 1)).toHaveLength(24);
    expect(day.flows.at(-1)?.hour).toBe(23);
  });
});

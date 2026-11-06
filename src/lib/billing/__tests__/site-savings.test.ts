import { describe, expect, it } from "vitest";
import {
  ARBITRAGE_MIN_BATTERY_MINUTES,
  MIN_CHARGED_KWH,
  rateAt,
  tariffForDate,
  validateGridTariffBands,
  valueSiteDays,
  type SavingsSettingsInput,
  type TariffInput,
} from "../site-savings";
import type { SiteDayOperations, SiteFlow } from "@/lib/metering/site-operations";
import type { GridTariffBand } from "@/lib/types/domain";

/** Night, day and evening rates (neutral example figures). */
const BANDS: GridTariffBand[] = [
  { from_hour: 0, to_hour: 6, rate: 400 },
  { from_hour: 6, to_hour: 18, rate: 550 },
  { from_hour: 18, to_hour: 24, rate: 650 },
];
const TARIFFS: TariffInput[] = [{ effective_from: "2026-01-01", bands: BANDS }];

const BOTH_FROM_START: SavingsSettingsInput = {
  solar_savings_from: "2026-01-01",
  arbitrage_from: "2026-01-01",
  round_trip_efficiency: 0.8,
};

const BINS_PER_HOUR = 12;
/** kWh of one five-minute bin at `watts`. */
const binKwh = (watts: number) => (watts * 5) / 60 / 1000;

type FlowValues = Partial<Omit<SiteFlow, "atMs" | "hour">>;

/**
 * A site day with 288 flows. `gen` gets the local hour and the bin's index
 * within that hour; its values override an idle bin (battery and grid at 0,
 * no solar, grid present).
 */
function makeDay(
  date: string,
  gen: (hour: number, bin: number) => FlowValues = () => ({}),
  overrides: Partial<SiteDayOperations> = {}
): SiteDayOperations {
  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  const flows: SiteFlow[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let bin = 0; bin < BINS_PER_HOUR; bin++) {
      flows.push({
        atMs: dayStartMs + (hour * 60 + bin * 5) * 60_000,
        hour,
        batteryW: 0,
        gridW: 0,
        solarW: 0,
        gridPresent: true,
        ...gen(hour, bin),
      });
    }
  }
  return {
    date,
    timezone: "UTC",
    dayStartMs,
    dayEndMs: dayStartMs + 86_400_000,
    readUntilMs: dayStartMs + 86_400_000,
    resolutionMinutes: 5,
    eveningStartMs: dayStartMs + 18 * 3_600_000,
    hourMarks: [],
    sources: { battery: true, gridMeter: true, load: true, pv: false },
    solarKwh: 0,
    solarEstimated: true,
    eveningDischargeKwh: 0,
    cuts: [],
    cutMinutes: 0,
    lowestSoc: null,
    socAtCheckHour: null,
    dark: [],
    darkMinutes: 0,
    noDataMinutes: 0,
    lightsOnPct: 100,
    knownMinutes: 1440,
    soc: [],
    evening: [],
    eveningHours: { battery: 0, battery_and_grid: 0, grid: 0, dark: 0, no_data: 0 },
    flows,
    ...overrides,
  };
}

/** Value a single day as `date`, and return its day column. */
function valueOne(
  day: SiteDayOperations,
  settings: SavingsSettingsInput | null = BOTH_FROM_START,
  tariffs: TariffInput[] = TARIFFS
) {
  return valueSiteDays({ days: [day], tariffs, settings, date: day.date });
}

const dates = (from: string, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

describe("constants", () => {
  it("needs ten hours of battery readings and more than 0.05 kWh charged", () => {
    expect(ARBITRAGE_MIN_BATTERY_MINUTES).toBe(600);
    expect(MIN_CHARGED_KWH).toBe(0.05);
  });
});

describe("validateGridTariffBands", () => {
  it("accepts a single all-day band", () => {
    expect(validateGridTariffBands([{ from_hour: 0, to_hour: 24, rate: 500 }])).toEqual({
      ok: true,
      bands: [{ from_hour: 0, to_hour: 24, rate: 500 }],
    });
  });

  it("accepts 24 one-hour bands", () => {
    const bands = Array.from({ length: 24 }, (_, h) => ({ from_hour: h, to_hour: h + 1, rate: h }));
    expect(validateGridTariffBands(bands)).toEqual({ ok: true, bands });
  });

  it("accepts a rate of 0", () => {
    const result = validateGridTariffBands([{ from_hour: 0, to_hour: 24, rate: 0 }]);
    expect(result.ok).toBe(true);
  });

  it("sorts bands given out of order", () => {
    const result = validateGridTariffBands([BANDS[2], BANDS[0], BANDS[1]]);
    expect(result).toEqual({ ok: true, bands: BANDS });
  });

  it("keeps only the band fields", () => {
    const result = validateGridTariffBands([
      { from_hour: 0, to_hour: 24, rate: 500, label: "flat", id: 3 },
    ]);
    expect(result).toEqual({ ok: true, bands: [{ from_hour: 0, to_hour: 24, rate: 500 }] });
  });

  it("does not change the caller's array", () => {
    const input = [BANDS[2], BANDS[0], BANDS[1]];
    validateGridTariffBands(input);
    expect(input).toEqual([BANDS[2], BANDS[0], BANDS[1]]);
  });

  it.each([
    ["not a list", { from_hour: 0, to_hour: 24, rate: 500 }],
    ["null", null],
    ["an empty list", []],
    [
      "25 bands",
      Array.from({ length: 25 }, (_, h) => ({ from_hour: h, to_hour: h + 1, rate: 1 })),
    ],
    ["a band that is not an object", [null]],
    ["a band that is a list", [[0, 24, 500]]],
    ["a fractional hour", [{ from_hour: 0, to_hour: 12.5, rate: 1 }, { from_hour: 12.5, to_hour: 24, rate: 1 }]],
    ["an hour given as a string", [{ from_hour: "0", to_hour: 24, rate: 1 }]],
    ["a missing hour", [{ to_hour: 24, rate: 1 }]],
    ["a band that ends where it starts", [{ from_hour: 0, to_hour: 0, rate: 1 }, { from_hour: 0, to_hour: 24, rate: 1 }]],
    ["a band that ends before it starts", [{ from_hour: 24, to_hour: 0, rate: 1 }]],
    ["a negative hour", [{ from_hour: -1, to_hour: 24, rate: 1 }]],
    ["an hour past 24", [{ from_hour: 0, to_hour: 25, rate: 1 }]],
    ["a gap", [{ from_hour: 0, to_hour: 6, rate: 1 }, { from_hour: 7, to_hour: 24, rate: 1 }]],
    ["an overlap", [{ from_hour: 0, to_hour: 7, rate: 1 }, { from_hour: 6, to_hour: 24, rate: 1 }]],
    ["a duplicate band", [{ from_hour: 0, to_hour: 24, rate: 1 }, { from_hour: 0, to_hour: 24, rate: 2 }]],
    ["no band from hour 0", [{ from_hour: 1, to_hour: 24, rate: 1 }]],
    ["no band up to hour 24", [{ from_hour: 0, to_hour: 23, rate: 1 }]],
    ["a negative rate", [{ from_hour: 0, to_hour: 24, rate: -1 }]],
    ["a rate that is not a number", [{ from_hour: 0, to_hour: 24, rate: "500" }]],
    ["a missing rate", [{ from_hour: 0, to_hour: 24 }]],
    ["a NaN rate", [{ from_hour: 0, to_hour: 24, rate: Number.NaN }]],
    ["an infinite rate", [{ from_hour: 0, to_hour: 24, rate: Number.POSITIVE_INFINITY }]],
  ])("rejects %s", (_label, input) => {
    const result = validateGridTariffBands(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  it("names the first uncovered hour of a gap", () => {
    expect(
      validateGridTariffBands([
        { from_hour: 0, to_hour: 6, rate: 1 },
        { from_hour: 7, to_hour: 24, rate: 1 },
      ])
    ).toEqual({ ok: false, message: "No band covers hour 6." });
    expect(validateGridTariffBands([{ from_hour: 0, to_hour: 23, rate: 1 }])).toEqual({
      ok: false,
      message: "No band covers hour 23.",
    });
  });

  it("names where bands overlap", () => {
    expect(
      validateGridTariffBands([
        { from_hour: 0, to_hour: 7, rate: 1 },
        { from_hour: 6, to_hour: 24, rate: 1 },
      ])
    ).toEqual({ ok: false, message: "Bands overlap at hour 6." });
  });
});

describe("tariffForDate", () => {
  const FLAT = (rate: number): GridTariffBand[] => [{ from_hour: 0, to_hour: 24, rate }];
  const tariffs: TariffInput[] = [
    { effective_from: "2026-07-01", bands: FLAT(650) },
    { effective_from: "2026-01-01", bands: FLAT(400) },
    { effective_from: "2026-04-01", bands: FLAT(550) },
  ];

  it("picks the latest tariff in force on the day, whatever the order given", () => {
    expect(tariffForDate(tariffs, "2026-05-15")).toEqual(FLAT(550));
    expect(tariffForDate(tariffs, "2026-12-31")).toEqual(FLAT(650));
  });

  it("applies a tariff from its effective date itself", () => {
    expect(tariffForDate(tariffs, "2026-04-01")).toEqual(FLAT(550));
    expect(tariffForDate(tariffs, "2026-03-31")).toEqual(FLAT(400));
  });

  it("returns null before the first tariff and with no tariffs", () => {
    expect(tariffForDate(tariffs, "2025-12-31")).toBeNull();
    expect(tariffForDate([], "2026-05-15")).toBeNull();
  });
});

describe("rateAt", () => {
  it("returns the rate of the band covering the hour, start inclusive and end exclusive", () => {
    expect(rateAt(BANDS, 0)).toBe(400);
    expect(rateAt(BANDS, 5)).toBe(400);
    expect(rateAt(BANDS, 6)).toBe(550);
    expect(rateAt(BANDS, 17)).toBe(550);
    expect(rateAt(BANDS, 18)).toBe(650);
    expect(rateAt(BANDS, 23)).toBe(650);
  });

  it("throws when no band covers the hour", () => {
    expect(() => rateAt(BANDS, 24)).toThrow(RangeError);
    expect(() => rateAt([{ from_hour: 6, to_hour: 24, rate: 1 }], 3)).toThrow(RangeError);
  });
});

describe("valueSiteDays — solar savings", () => {
  it("values each bin's solar at the rate of its hour", () => {
    const day = makeDay("2026-10-05", (hour) => {
      if (hour >= 9 && hour < 12) return { solarW: 1200 }; // 3.6 kWh at 550
      if (hour === 18) return { solarW: 600 }; // 0.6 kWh at 650
      if (hour === 3) return { solarW: null };
      return {};
    });
    const { columns } = valueOne(day);
    expect(columns.day.solarSavings).toBeCloseTo(3.6 * 550 + 0.6 * 650, 6);
  });

  it("is null when the day has no solar figure at all", () => {
    const day = makeDay("2026-10-05", () => ({ solarW: null }), { solarKwh: null });
    expect(valueOne(day).columns.day.solarSavings).toBeNull();
  });

  it("is 0, not null, on a day with a solar source and no output", () => {
    expect(valueOne(makeDay("2026-10-05")).columns.day.solarSavings).toBe(0);
  });

  it("is not counted before solar_savings_from", () => {
    const day = makeDay("2026-10-05", () => ({ solarW: 1000 }));
    const settings = { ...BOTH_FROM_START, solar_savings_from: "2026-10-06" };
    expect(valueOne(day, settings).columns.day.solarSavings).toBeNull();
    const fromThatDay = { ...BOTH_FROM_START, solar_savings_from: "2026-10-05" };
    expect(valueOne(day, fromThatDay).columns.day.solarSavings).not.toBeNull();
  });

  it("is not counted when solar_savings_from is null", () => {
    const day = makeDay("2026-10-05", () => ({ solarW: 1000 }));
    const settings = { ...BOTH_FROM_START, solar_savings_from: null };
    expect(valueOne(day, settings).columns.day.solarSavings).toBeNull();
  });
});

describe("valueSiteDays — arbitrage", () => {
  /** Charge 2.4 kWh at night (400), discharge 2.4 kWh in the evening (650). */
  const cycle = (hour: number): FlowValues => {
    if (hour < 2) return { batteryW: -1200 };
    if (hour >= 18 && hour < 20) return { batteryW: 1200 };
    return {};
  };

  it("is evening value less the average charging cost divided by round-trip efficiency", () => {
    const { columns } = valueOne(makeDay("2026-10-05", cycle));
    // 2.4 × 650 − 2.4 × 400 / 0.8
    expect(columns.day.arbitrageGain).toBeCloseTo(1560 - 1200, 6);
  });

  it("averages the charging rate over every charging bin, solar charging included", () => {
    const day = makeDay("2026-10-05", (hour) => {
      if (hour < 1) return { batteryW: -1200 }; // 1.2 kWh at 400
      if (hour === 12) return { batteryW: -1200, solarW: 1500 }; // 1.2 kWh at 550
      if (hour >= 18 && hour < 20) return { batteryW: 1200 }; // 2.4 kWh at 650
      return {};
    });
    const avg = (1.2 * 400 + 1.2 * 550) / 2.4;
    const { columns } = valueOne(day);
    expect(columns.day.arbitrageGain).toBeCloseTo(2.4 * 650 - (2.4 * avg) / 0.8, 6);
    // The solar that charged the battery is valued as solar too.
    expect(columns.day.solarSavings).toBeCloseTo(binKwh(1500) * 12 * 550, 6);
  });

  it("uses the round-trip efficiency from the settings", () => {
    const settings = { ...BOTH_FROM_START, round_trip_efficiency: 1 };
    expect(valueOne(makeDay("2026-10-05", cycle), settings).columns.day.arbitrageGain).toBeCloseTo(
      1560 - 960,
      6
    );
  });

  it("leaves out discharge while the grid is cut or its state is unknown", () => {
    const day = makeDay("2026-10-05", (hour) => {
      if (hour === 21) return { batteryW: 3000, gridPresent: false };
      if (hour === 22) return { batteryW: 3000, gridPresent: null };
      return cycle(hour);
    });
    expect(valueOne(day).columns.day.arbitrageGain).toBeCloseTo(360, 6);
  });

  it("can be negative when discharge is worth less than the charge cost", () => {
    const day = makeDay("2026-10-05", (hour) => {
      if (hour >= 18 && hour < 20) return { batteryW: -1200 };
      if (hour < 2) return { batteryW: 1200 };
      return {};
    });
    // 2.4 × 400 − 2.4 × 650 / 0.8
    expect(valueOne(day).columns.day.arbitrageGain).toBeCloseTo(960 - 1950, 6);
  });

  it("costs the energy at the tariff's lowest rate when 0.05 kWh or less was charged", () => {
    const day = makeDay("2026-10-05", (hour, bin) => {
      if (hour === 0 && bin === 0) return { batteryW: -600 }; // exactly 0.05 kWh
      if (hour >= 18 && hour < 20) return { batteryW: 1200 };
      return {};
    });
    // Never free: the lowest band (400) stands in for the day's charging rate.
    expect(valueOne(day).columns.day.arbitrageGain).toBeCloseTo(2.4 * 650 - (2.4 * 400) / 0.8, 6);
  });

  it("is unknown, not zero, when the grid state was never known that day", () => {
    const day = {
      ...makeDay("2026-10-05", (hour) => (hour >= 18 && hour < 20 ? { batteryW: 1200, gridPresent: null } : cycle(hour))),
      cuts: null,
      cutMinutes: null,
    };
    const { columns } = valueOne(day);
    expect(columns.day.arbitrageGain).toBeNull();
    expect(columns.day.solarSavings).not.toBeNull();
  });

  it("uses the charging rate once more than 0.05 kWh was charged", () => {
    const day = makeDay("2026-10-05", (hour, bin) => {
      if (hour === 0 && bin < 2) return { batteryW: -600 }; // 0.1 kWh at 400
      if (hour >= 18 && hour < 20) return { batteryW: 1200 };
      return {};
    });
    expect(valueOne(day).columns.day.arbitrageGain).toBeCloseTo(2.4 * 650 - (2.4 * 400) / 0.8, 6);
  });

  it("is null with fewer than 600 minutes of battery readings, and counts at exactly 600", () => {
    // 119 bins = 595 minutes.
    const short = makeDay("2026-10-05", (hour, bin) =>
      hour * BINS_PER_HOUR + bin < 119 ? cycle(hour) : { batteryW: null }
    );
    expect(valueOne(short).columns.day.arbitrageGain).toBeNull();
    const enough = makeDay("2026-10-05", (hour, bin) =>
      hour * BINS_PER_HOUR + bin < 120 ? { batteryW: hour < 2 ? -1200 : 0 } : { batteryW: null }
    );
    expect(valueOne(enough).columns.day.arbitrageGain).toBe(0);
  });

  it("leaves a short-coverage day out of the column sums", () => {
    const good = makeDay("2026-10-05", cycle);
    const short = makeDay("2026-10-06", () => ({ batteryW: null }));
    const summary = valueSiteDays({
      days: [good, short],
      tariffs: TARIFFS,
      settings: BOTH_FROM_START,
      date: "2026-10-06",
    });
    expect(summary.columns.day.arbitrageGain).toBeNull();
    expect(summary.columns.month.arbitrageGain).toBeCloseTo(360, 6);
    expect(summary.columns.month.days).toBe(2);
  });

  it("is not counted before arbitrage_from or when it is null", () => {
    const day = makeDay("2026-10-05", cycle);
    expect(
      valueOne(day, { ...BOTH_FROM_START, arbitrage_from: "2026-10-06" }).columns.day.arbitrageGain
    ).toBeNull();
    expect(
      valueOne(day, { ...BOTH_FROM_START, arbitrage_from: null }).columns.day.arbitrageGain
    ).toBeNull();
  });
});

describe("valueSiteDays — tariffs", () => {
  it("values each day at the tariff in force on it", () => {
    const tariffs: TariffInput[] = [
      { effective_from: "2026-01-01", bands: [{ from_hour: 0, to_hour: 24, rate: 400 }] },
      { effective_from: "2026-10-02", bands: [{ from_hour: 0, to_hour: 24, rate: 650 }] },
    ];
    const solarDay = (date: string) => makeDay(date, (hour) => (hour === 12 ? { solarW: 1200 } : {}));
    const summary = valueSiteDays({
      days: [solarDay("2026-10-01"), solarDay("2026-10-02")],
      tariffs,
      settings: BOTH_FROM_START,
      date: "2026-10-02",
    });
    expect(summary.columns.day.solarSavings).toBeCloseTo(1.2 * 650, 6);
    expect(summary.columns.month.solarSavings).toBeCloseTo(1.2 * 400 + 1.2 * 650, 6);
  });

  it("gives a day with no tariff no money and counts it as missing", () => {
    const tariffs: TariffInput[] = [{ effective_from: "2026-10-03", bands: BANDS }];
    const days = dates("2026-10-01", 4).map((d) => makeDay(d, () => ({ solarW: 1000 })));
    const summary = valueSiteDays({ days, tariffs, settings: BOTH_FROM_START, date: "2026-10-04" });
    expect(summary.missingTariffDays).toBe(2);
    expect(summary.columns.month.days).toBe(4);
    // 1 kWh an hour all day on the two days with a tariff.
    expect(summary.columns.month.solarSavings).toBeCloseTo(2 * (6 * 400 + 12 * 550 + 6 * 650), 6);
  });

  it("gives every column null money when no day has a tariff", () => {
    const summary = valueSiteDays({
      days: [makeDay("2026-10-01", () => ({ solarW: 1000 }))],
      tariffs: [],
      settings: BOTH_FROM_START,
      date: "2026-10-01",
    });
    expect(summary.columns.day).toMatchObject({ solarSavings: null, arbitrageGain: null, total: null });
    expect(summary.missingTariffDays).toBe(1);
  });

  it("does not count a missing tariff on a day neither saving is counted for", () => {
    const summary = valueSiteDays({
      days: [makeDay("2026-10-01")],
      tariffs: [],
      settings: { ...BOTH_FROM_START, solar_savings_from: "2026-10-02", arbitrage_from: null },
      date: "2026-10-01",
    });
    expect(summary.missingTariffDays).toBe(0);
  });

  it("treats a stored tariff whose bands do not cover the day as missing", () => {
    const tariffs: TariffInput[] = [
      { effective_from: "2026-01-01", bands: [{ from_hour: 0, to_hour: 12, rate: 400 }] },
    ];
    const summary = valueOne(makeDay("2026-10-01", () => ({ solarW: 1000 })), BOTH_FROM_START, tariffs);
    expect(summary.columns.day.solarSavings).toBeNull();
    expect(summary.missingTariffDays).toBe(1);
  });

  it("uses a stored tariff whose bands are valid but out of order", () => {
    const tariffs: TariffInput[] = [{ effective_from: "2026-01-01", bands: [BANDS[2], BANDS[0], BANDS[1]] }];
    const day = makeDay("2026-10-01", (hour) => (hour === 20 ? { solarW: 1200 } : {}));
    expect(valueOne(day, BOTH_FROM_START, tariffs).columns.day.solarSavings).toBeCloseTo(1.2 * 650, 6);
  });
});

describe("valueSiteDays — columns", () => {
  /** 1.2 kWh of noon solar (660) and the arbitrage cycle (360) every day. */
  const fullDay = (date: string) =>
    makeDay(date, (hour) => {
      if (hour < 2) return { batteryW: -1200 };
      if (hour === 12) return { solarW: 1200 };
      if (hour >= 18 && hour < 20) return { batteryW: 1200 };
      return {};
    });
  const PER_DAY_SOLAR = 1.2 * 550;
  const PER_DAY_ARB = 360;

  it("adds up the day, month to date and since the earlier start", () => {
    const days = dates("2026-09-25", 9).map(fullDay); // 25 Sep to 3 Oct
    const settings = {
      ...BOTH_FROM_START,
      solar_savings_from: "2026-09-28",
      arbitrage_from: "2026-09-30",
    };
    const summary = valueSiteDays({ days, tariffs: TARIFFS, settings, date: "2026-10-03" });
    expect(summary.sinceStartDate).toBe("2026-09-28");
    expect(summary.missingTariffDays).toBe(0);

    expect(summary.columns.day.days).toBe(1);
    expect(summary.columns.day.solarSavings).toBeCloseTo(PER_DAY_SOLAR, 6);
    expect(summary.columns.day.arbitrageGain).toBeCloseTo(PER_DAY_ARB, 6);
    expect(summary.columns.day.total).toBeCloseTo(PER_DAY_SOLAR + PER_DAY_ARB, 6);

    expect(summary.columns.month.days).toBe(3);
    expect(summary.columns.month.solarSavings).toBeCloseTo(3 * PER_DAY_SOLAR, 6);
    expect(summary.columns.month.arbitrageGain).toBeCloseTo(3 * PER_DAY_ARB, 6);

    // 28 Sep to 3 Oct: six days of solar, four of arbitrage.
    expect(summary.columns.sinceStart.days).toBe(6);
    expect(summary.columns.sinceStart.solarSavings).toBeCloseTo(6 * PER_DAY_SOLAR, 6);
    expect(summary.columns.sinceStart.arbitrageGain).toBeCloseTo(4 * PER_DAY_ARB, 6);
    expect(summary.columns.sinceStart.total).toBeCloseTo(6 * PER_DAY_SOLAR + 4 * PER_DAY_ARB, 6);
  });

  it("applies the start dates inside the month column too", () => {
    const days = dates("2026-10-01", 5).map(fullDay);
    const settings = { ...BOTH_FROM_START, solar_savings_from: "2026-10-04", arbitrage_from: null };
    const summary = valueSiteDays({ days, tariffs: TARIFFS, settings, date: "2026-10-05" });
    expect(summary.columns.month.days).toBe(5);
    expect(summary.columns.month.solarSavings).toBeCloseTo(2 * PER_DAY_SOLAR, 6);
    expect(summary.columns.month.arbitrageGain).toBeNull();
    expect(summary.columns.month.total).toBeCloseTo(2 * PER_DAY_SOLAR, 6);
  });

  it("caps the since-start column at the first day read", () => {
    const days = dates("2026-09-28", 6).map(fullDay);
    const summary = valueSiteDays({
      days,
      tariffs: TARIFFS,
      settings: BOTH_FROM_START,
      date: "2026-10-03",
    });
    expect(summary.sinceStartDate).toBe("2026-09-28");
    expect(summary.columns.sinceStart.days).toBe(6);
  });

  it("counts missing tariffs over the since-start range when it starts before the month", () => {
    const tariffs: TariffInput[] = [{ effective_from: "2026-10-02", bands: BANDS }];
    const days = dates("2026-09-28", 6).map(fullDay);
    const summary = valueSiteDays({ days, tariffs, settings: BOTH_FROM_START, date: "2026-10-03" });
    // 28, 29, 30 Sep and 1 Oct have no tariff.
    expect(summary.missingTariffDays).toBe(4);
    expect(summary.columns.month.solarSavings).toBeCloseTo(2 * PER_DAY_SOLAR, 6);
  });

  it("ignores days after the date", () => {
    const days = dates("2026-10-01", 5).map(fullDay);
    const summary = valueSiteDays({ days, tariffs: TARIFFS, settings: BOTH_FROM_START, date: "2026-10-03" });
    expect(summary.columns.month.days).toBe(3);
    expect(summary.columns.sinceStart.days).toBe(3);
  });

  it("does not depend on the order of the days", () => {
    const days = dates("2026-09-28", 6).map(fullDay);
    const forward = valueSiteDays({ days, tariffs: TARIFFS, settings: BOTH_FROM_START, date: "2026-10-03" });
    const reversed = valueSiteDays({
      days: [...days].reverse(),
      tariffs: TARIFFS,
      settings: BOTH_FROM_START,
      date: "2026-10-03",
    });
    expect(reversed).toEqual(forward);
  });

  it("gives an empty day column when the date was not read", () => {
    const summary = valueSiteDays({
      days: [fullDay("2026-10-01")],
      tariffs: TARIFFS,
      settings: BOTH_FROM_START,
      date: "2026-10-02",
    });
    expect(summary.columns.day).toEqual({
      solarSavings: null,
      arbitrageGain: null,
      total: null,
      lightsOnPct: null,
      days: 0,
    });
    expect(summary.columns.month.days).toBe(1);
  });

  it("has a future start date's since-start column empty", () => {
    const summary = valueSiteDays({
      days: [fullDay("2026-10-01")],
      tariffs: TARIFFS,
      settings: { ...BOTH_FROM_START, solar_savings_from: "2026-11-01", arbitrage_from: null },
      date: "2026-10-01",
    });
    expect(summary.sinceStartDate).toBe("2026-11-01");
    expect(summary.columns.sinceStart.days).toBe(0);
    expect(summary.columns.sinceStart.total).toBeNull();
  });

  describe("without settings or start dates", () => {
    it.each([
      ["no settings", null],
      ["no start dates", { solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: 0.9 }],
    ])("has %s: no money, no since-start range, nothing missing", (_label, settings) => {
      const days = dates("2026-10-01", 3).map(fullDay);
      const summary = valueSiteDays({ days, tariffs: [], settings, date: "2026-10-03" });
      expect(summary.sinceStartDate).toBeNull();
      expect(summary.missingTariffDays).toBe(0);
      expect(summary.columns.month).toEqual({
        solarSavings: null,
        arbitrageGain: null,
        total: null,
        lightsOnPct: 100,
        days: 3,
      });
      expect(summary.columns.sinceStart).toEqual({
        solarSavings: null,
        arbitrageGain: null,
        total: null,
        lightsOnPct: null,
        days: 0,
      });
    });
  });
});

describe("valueSiteDays — lights on", () => {
  it("is lit known minutes over known minutes across the column's days", () => {
    const days = [
      makeDay("2026-10-01", undefined, { knownMinutes: 1440, darkMinutes: 144 }),
      makeDay("2026-10-02", undefined, { knownMinutes: 720, darkMinutes: 0 }),
      makeDay("2026-10-03", undefined, { knownMinutes: 1440, darkMinutes: 360 }),
    ];
    const summary = valueSiteDays({ days, tariffs: TARIFFS, settings: BOTH_FROM_START, date: "2026-10-03" });
    expect(summary.columns.day.lightsOnPct).toBeCloseTo(75, 10);
    expect(summary.columns.month.lightsOnPct).toBeCloseTo(
      (100 * (1440 - 144 + 720 + 1440 - 360)) / (1440 + 720 + 1440),
      10
    );
  });

  it("weights days by their known minutes, not their own share", () => {
    const days = [
      makeDay("2026-10-01", undefined, { knownMinutes: 60, darkMinutes: 60 }), // 0%
      makeDay("2026-10-02", undefined, { knownMinutes: 1380, darkMinutes: 0 }), // 100%
    ];
    const summary = valueSiteDays({ days, tariffs: TARIFFS, settings: BOTH_FROM_START, date: "2026-10-02" });
    expect(summary.columns.month.lightsOnPct).toBeCloseTo((100 * 1380) / 1440, 10);
  });

  it("is null when no minute is known", () => {
    const day = makeDay("2026-10-01", undefined, { knownMinutes: 0, darkMinutes: 0 });
    expect(valueOne(day).columns.day.lightsOnPct).toBeNull();
  });

  it("counts days before the start dates", () => {
    const days = [
      makeDay("2026-10-01", undefined, { knownMinutes: 1440, darkMinutes: 720 }),
      makeDay("2026-10-02", undefined, { knownMinutes: 1440, darkMinutes: 0 }),
    ];
    const settings = { ...BOTH_FROM_START, solar_savings_from: "2026-10-02", arbitrage_from: null };
    const summary = valueSiteDays({ days, tariffs: TARIFFS, settings, date: "2026-10-02" });
    expect(summary.columns.month.lightsOnPct).toBeCloseTo(75, 10);
    expect(summary.columns.sinceStart.lightsOnPct).toBe(100);
  });
});

describe("valueSiteDays — total", () => {
  it("is the solar savings alone when arbitrage is null", () => {
    const day = makeDay("2026-10-01", () => ({ solarW: 600, batteryW: null }));
    const { day: column } = valueOne(day).columns;
    expect(column.arbitrageGain).toBeNull();
    expect(column.solarSavings).not.toBeNull();
    expect(column.total).toBe(column.solarSavings);
  });

  it("is the arbitrage alone when solar savings are null", () => {
    const day = makeDay("2026-10-01", (hour) => (hour >= 18 && hour < 20 ? { batteryW: 1200 } : {}), {
      solarKwh: null,
    });
    const { day: column } = valueOne(day).columns;
    expect(column.solarSavings).toBeNull();
    // Nothing charged that day: the lowest band (400) prices the energy.
    expect(column.arbitrageGain).toBeCloseTo(2.4 * 650 - (2.4 * 400) / 0.8, 6);
    expect(column.total).toBe(column.arbitrageGain);
  });

  it("is 0 when both parts are 0", () => {
    const { day: column } = valueOne(makeDay("2026-10-01")).columns;
    expect(column).toMatchObject({ solarSavings: 0, arbitrageGain: 0, total: 0 });
  });

  it("is null when both parts are null", () => {
    const day = makeDay("2026-10-01", () => ({ batteryW: null }), { solarKwh: null });
    expect(valueOne(day).columns.day).toMatchObject({
      solarSavings: null,
      arbitrageGain: null,
      total: null,
    });
  });
});

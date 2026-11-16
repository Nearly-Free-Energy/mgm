/**
 * The `billing.savings` loader, shaped like the site-day loader's test: the
 * organization and client come from the request, the day from `?date=`
 * with the site-day rule, every composition is disposed, refusals carry
 * fixed copy, and only the capability's read is used.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { SurfaceRequest } from "@/lib/gui/surface";
import { computeSiteDay, type SiteDayOperations, type SiteFlow } from "@/lib/metering/site-operations";
import { addDaysToDateKey } from "@/lib/timezone/day-key";

const composeMetering = vi.fn();
vi.mock("@/lib/metering/compose", () => ({ composeMetering: (...args: unknown[]) => composeMetering(...args) }));

import { loadSavings, SAVINGS_REFUSALS, savingsRefusal } from "../savings";
import type { SavingsExtData } from "../savings-ext";

const ORG = "e7600000-0000-4000-8000-000000000001";
const MG = "e7600000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-11-07T08:00:00Z"); // 11:00 in Kampala
const UPSTREAM = "upstream said: token abc123 refused";
const BANDS = [
  { from_hour: 0, to_hour: 6, rate: 400 },
  { from_hour: 6, to_hour: 18, rate: 550 },
  { from_hour: 18, to_hour: 24, rate: 650 },
];
const SETTINGS = { solar_savings_from: "2026-11-01", arbitrage_from: null, round_trip_efficiency: "0.9" };

type Result = { data: unknown; error: unknown };
let tables: Record<string, Result>;
let reads: unknown[][];
let calls: string[];
let dispose: ReturnType<typeof vi.fn>;
let getSiteDays: ReturnType<typeof vi.fn>;

/** A client answering each table from `tables`; `reads` records every call. */
function client(): SupabaseClient {
  return {
    from(table: string) {
      reads.push(["from", table]);
      const result = Promise.resolve(tables[table]);
      const chain: Record<string, unknown> = {
        select: (columns: string) => (reads.push(["select", table, columns]), chain),
        eq: (column: string, value: string) => (reads.push(["eq", table, column, value]), chain),
        order: (column: string) => (reads.push(["order", table, column]), chain),
        maybeSingle: () => result,
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => result.then(ok, no),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

/** The capability as the loader sees it: any member other than getSiteDays is recorded. */
function facade() {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      calls.push(prop);
      return prop === "getSiteDays" ? getSiteDays : vi.fn();
    },
  });
}

const request = (search = "", { now = NOW, locale = "en-GB" }: { now?: Date; locale?: string } = {}): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles: [],
  organizationId: ORG,
  params: { id: MG },
  search: new URLSearchParams(search),
  locale,
  now,
  fmt: createFmt({ locale }),
});

/** A day with one hour of 1 200 W of solar the site used at noon: 1.2 kWh, worth 660. */
function solarDay(date: string): SiteDayOperations {
  const base = computeSiteDay({
    date,
    timezone: "Africa/Kampala",
    samples: { timestamps: [], batterySocPct: [], batteryPowerW: [], gridPowerW: [], gridVoltageV: [], loadPowerW: [], pvPowerW: [], houseEnergyWh: {} },
    sources: { battery: true, gridMeter: true, load: false, pv: true, houses: false, houseMetersUnreadable: 0 },
    resolutionMinutes: 5,
    nowMs: NOW.getTime(),
  });
  const flows: SiteFlow[] = Array.from({ length: 12 }, (_, i) => ({
    atMs: base.dayStartMs + (12 * 60 + i * 5) * 60_000,
    hour: 12,
    batteryW: null,
    gridW: 0,
    solarW: 1200,
    gridPresent: true,
  }));
  return { ...base, solarKwh: 1.2, solarEstimated: false, knownMinutes: 1440, darkMinutes: 0, flows };
}

/**
 * A day of battery arbitrage and no solar: five hours charging at 1 200 W at
 * the night rate (6 kWh for 2 400) and five hours giving the site 1 200 W at
 * the evening rate (6 kWh worth 3 900), with the grid on throughout.
 */
function arbitrageDay(date: string): SiteDayOperations {
  const day = solarDay(date);
  const bin = (i: number, hour: number, batteryW: number): SiteFlow => ({
    atMs: day.dayStartMs + i * 5 * 60_000,
    hour,
    batteryW,
    gridW: batteryW < 0 ? -batteryW : 0,
    solarW: 0,
    gridPresent: true,
  });
  const flows = [...Array.from({ length: 60 }, (_, i) => bin(i, 2, -1200)), ...Array.from({ length: 60 }, (_, i) => bin(60 + i, 19, 1200))];
  return { ...day, solarKwh: null, cuts: [], flows };
}

function days(start: string, end: string): SiteDayOperations[] {
  const out: SiteDayOperations[] = [];
  for (let d = start; d <= end; d = addDaysToDateKey(d, 1)) out.push(solarDay(d));
  return out;
}

const stateOf = (out: Awaited<ReturnType<typeof loadSavings>>) => (out.ok ? (out.model.ext!.data as SavingsExtData).state : null);

beforeEach(() => {
  tables = {
    microgrids: { data: { id: MG, timezone: "Africa/Kampala", currency: "UGX" }, error: null },
    grid_tariffs: { data: [{ effective_from: "2026-01-01", bands: BANDS }], error: null },
    microgrid_savings_settings: { data: SETTINGS, error: null },
  };
  reads = [];
  calls = [];
  dispose = vi.fn(async () => {});
  getSiteDays = vi.fn(async (q: { start_date: string; end_date: string }) => ({ ok: true, data: days(q.start_date, q.end_date) }));
  composeMetering.mockReset().mockImplementation(async () => ({ ok: true, data: { metering: facade(), dispose } }));
});

describe("loadSavings", () => {
  it("reads through the request's client and composes metering for its organization", async () => {
    const req = request();
    const out = await loadSavings(req);
    expect(stateOf(out)).toBe("ready");
    expect(reads).toEqual(
      expect.arrayContaining([
        ["select", "microgrids", "id, timezone, currency"],
        ["eq", "microgrids", "id", MG],
        ["select", "grid_tariffs", "effective_from, bands"],
        ["eq", "grid_tariffs", "microgrid_id", MG],
        ["order", "grid_tariffs", "effective_from"],
        ["select", "microgrid_savings_settings", "solar_savings_from, arbitrage_from, round_trip_efficiency"],
        ["eq", "microgrid_savings_settings", "microgrid_id", MG],
      ]),
    );
    expect(composeMetering).toHaveBeenCalledWith({ supabase: req.supabase, organizationId: ORG });
    expect(calls).toEqual(["getSiteDays"]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("values the days with the real calculation", async () => {
    const out = await loadSavings(request("date=2026-11-06"));
    if (!out.ok) throw new Error("refused");
    const tile = (key: string) => out.model.body.tiles.find((t) => t.key === key)!.value;
    // Day: 660. Month so far and since start: six days of 660.
    expect(tile("day.solar")).toMatchObject({ t: "money", v: 660, derived: true });
    expect(tile("month.solar")).toMatchObject({ t: "money", v: 3960 });
    expect(JSON.stringify(out.model)).not.toContain("flows");
    const data = out.model.ext!.data as SavingsExtData;
    expect(data.state === "ready" && data.rows.map((r) => r.sub)).toEqual([
      "valued at the grid rate of each hour, since 1 Nov 2026",
      "not counted: no start date set",
      null,
      null,
    ]);
    expect(data.state === "ready" && data.notes[0]).not.toContain("estimated");
  });

  it("gives the money in the microgrid's own currency", async () => {
    tables.microgrids = { data: { id: MG, timezone: "Africa/Kampala", currency: "USD" }, error: null };
    const out = await loadSavings(request("date=2026-11-06"));
    if (!out.ok) throw new Error("refused");
    expect(out.model.body.tiles.find((t) => t.key === "day.solar")!.value).toMatchObject({ t: "money", currency: "USD", v: 66000 });
  });

  it("counts arbitrage alone, with the stored round-trip efficiency", async () => {
    tables.microgrid_savings_settings = { data: { solar_savings_from: null, arbitrage_from: "2026-11-01", round_trip_efficiency: "0.8" }, error: null };
    getSiteDays.mockImplementation(async (q: { start_date: string; end_date: string }) => ({
      ok: true,
      data: days(q.start_date, q.end_date).map((d) => arbitrageDay(d.date)),
    }));
    const out = await loadSavings(request("date=2026-11-06"));
    if (!out.ok) throw new Error("refused");
    expect(stateOf(out)).toBe("ready");
    // 3 900 less 2 400 / 0.8.
    expect(out.model.body.tiles.find((t) => t.key === "day.arbitrage")!.value).toMatchObject({ t: "money", v: 900, derived: true });
    const data = out.model.ext!.data as SavingsExtData;
    expect(data.state === "ready" && data.rows.map((r) => r.sub)).toEqual(["not counted: no start date set", "since 1 Nov 2026", null, null]);
  });

  it("says solar is estimated when any day's solar was", async () => {
    getSiteDays.mockImplementation(async (q: { start_date: string; end_date: string }) => ({
      ok: true,
      data: days(q.start_date, q.end_date).map((d, i) => (i === 1 ? { ...d, solarEstimated: true } : d)),
    }));
    const out = await loadSavings(request("date=2026-11-06"));
    const data = out.ok && (out.model.ext!.data as SavingsExtData);
    expect(data && data.state === "ready" && data.notes[0]).toContain("(solar is estimated from the load, grid and battery where there is no solar meter)");
  });

  it("writes dates in the request's locale", async () => {
    const out = await loadSavings(request("date=2026-11-06", { locale: "en-US" }));
    const data = out.ok && (out.model.ext!.data as SavingsExtData);
    expect(data && data.state === "ready" && data.columns[0].label).toBe("Nov 6");
  });

  it("works out today in the microgrid's zone, not in UTC", async () => {
    // 22:30 UTC on 7 Nov is 01:30 on 8 Nov in Kampala, so the 8th is today there.
    await loadSavings(request("date=2026-11-08", { now: new Date("2026-11-07T22:30:00Z") }));
    expect(getSiteDays).toHaveBeenCalledWith({ microgrid_id: MG, start_date: "2026-11-01", end_date: "2026-11-08" });
  });

  it.each([
    ["no date", "", "2026-11-06"],
    ["a past day", "date=2026-11-03", "2026-11-03"],
    ["today", "date=2026-11-07", "2026-11-07"],
    ["a repeated date", "date=2026-11-01&date=2026-11-02", "2026-11-06"],
    ["a future day", "date=2026-11-08", "2026-11-06"],
    ["a malformed date", "date=2026-02-30", "2026-11-06"],
  ])("reads %s up to %s, from the 1st of its month", async (_name, search, date) => {
    await loadSavings(request(search));
    expect(getSiteDays).toHaveBeenCalledWith({ microgrid_id: MG, start_date: `${date.slice(0, 7)}-01`, end_date: date });
  });

  it("reads today in UTC when the stored zone is not supported", async () => {
    tables.microgrids = { data: { id: MG, timezone: "Mars/Olympus", currency: "UGX" }, error: null };
    await loadSavings(request());
    expect(getSiteDays).toHaveBeenCalledWith({ microgrid_id: MG, start_date: "2026-11-01", end_date: "2026-11-06" });
  });

  it("caps the read at a year and says so", async () => {
    tables.microgrid_savings_settings = { data: { ...SETTINGS, solar_savings_from: "2024-03-01" }, error: null };
    const out = await loadSavings(request("date=2026-11-06"));
    expect(getSiteDays).toHaveBeenCalledWith({ microgrid_id: MG, start_date: "2025-11-06", end_date: "2026-11-06" });
    const data = out.ok && (out.model.ext!.data as SavingsExtData);
    // The days before the tariff took effect are counted as missing it too.
    expect(data && data.state === "ready" && data.warnings).toEqual([
      "56 days had no grid tariff in force and are left out of the money figures.",
      "Since start covers at most a year: days before 6 Nov 2025 are not read.",
    ]);
  });

  it.each([
    ["there are no settings", { microgrid_savings_settings: { data: null, error: null } }],
    ["neither saving has a start date", { microgrid_savings_settings: { data: { ...SETTINGS, solar_savings_from: null }, error: null } }],
    ["there is no grid tariff", { grid_tariffs: { data: [], error: null } }],
  ])("gives the setup note and reads no day when %s", async (_name, over) => {
    Object.assign(tables, over);
    const out = await loadSavings(request());
    expect(stateOf(out)).toBe("setup");
    expect(out.ok && out.model.links).toEqual([{ id: "billing.setup-rates", label: "Go to Setup > Rates", href: `/microgrids/${MG}/setup/rates` }]);
    expect(composeMetering).not.toHaveBeenCalled();
  });

  it("offers the settings and tariff actions, started from the stored settings and the newest bands", async () => {
    const NEWER = [
      { from_hour: 12, to_hour: 24, rate: 700 },
      { from_hour: 0, to_hour: 12, rate: 450 },
    ];
    const rows = [
      { effective_from: "2026-01-01", bands: BANDS },
      { effective_from: "2026-06-01", bands: NEWER },
    ];
    // Either order of rows gives the newest bands.
    for (const data of [rows, [...rows].reverse()]) {
      tables.grid_tariffs = { data, error: null };
      const out = await loadSavings(request());
      expect(stateOf(out)).toBe("ready");
      expect(out.ok && out.model.actions).toEqual([
        {
          action: "billing.savings-settings",
          params: { id: MG },
          prefill: { solar_savings_from: "2026-11-01", arbitrage_from: null, round_trip_efficiency: 0.9 },
        },
        { action: "billing.grid-tariff-add", params: { id: MG }, prefill: { bands: [NEWER[1], NEWER[0]] } },
      ]);
    }
  });

  it("offers the actions with the setup note, with no bands to start from when there is no tariff", async () => {
    tables.grid_tariffs = { data: [], error: null };
    tables.microgrid_savings_settings = { data: null, error: null };
    const out = await loadSavings(request());
    expect(stateOf(out)).toBe("setup");
    expect(out.ok && out.model.actions).toEqual([
      {
        action: "billing.savings-settings",
        params: { id: MG },
        prefill: { solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: 0.9 },
      },
      { action: "billing.grid-tariff-add", params: { id: MG } },
    ]);
  });

  it.each(["grid_tariffs", "microgrid_savings_settings"])("refuses with fixed copy when %s cannot be read", async (table) => {
    tables[table] = { data: null, error: { message: UPSTREAM } };
    const out = await loadSavings(request());
    expect(out).toEqual(SAVINGS_REFUSALS.settings);
    expect(out).toEqual({ ok: false, status: 503, message: "Could not load the savings settings" });
    expect(composeMetering).not.toHaveBeenCalled();
  });

  it("answers 404 for a microgrid it cannot read, and 503 when the read fails", async () => {
    tables.microgrids = { data: null, error: null };
    expect(await loadSavings(request())).toEqual(SAVINGS_REFUSALS.notFound);
    tables.microgrids = { data: null, error: { message: UPSTREAM } };
    expect(await loadSavings(request())).toEqual(SAVINGS_REFUSALS.unavailable);
  });

  it.each([
    ["no battery or grid meter", { ok: false, status: 404, code: "metering_no_site_devices", message: UPSTREAM }],
    ["mixed synthetic and real edges", { ok: false, status: 409, code: "METERING_CONFIGURATION", message: UPSTREAM }],
    ["no usable OpenEMS connection", { ok: false, status: 503, code: "METERING_CONFIGURATION", message: UPSTREAM }],
    ["OpenEMS rejecting the stored settings", { ok: false, status: 401, code: "METERING_UNAUTHORIZED", message: UPSTREAM }],
  ])("draws nothing for %s, which the day above explains, and disposes", async (_name, failure) => {
    getSiteDays.mockResolvedValue(failure);
    const out = await loadSavings(request());
    expect(stateOf(out)).toBe("unavailable");
    expect(out.ok && out.model.body.tiles).toEqual([]);
    expect(out.ok && out.model.actions).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("draws nothing while Metering is disabled, and reads no day", async () => {
    composeMetering.mockResolvedValue({ ok: false, status: 409, code: "metering_disabled", message: UPSTREAM });
    expect(stateOf(await loadSavings(request()))).toBe("unavailable");
    expect(getSiteDays).not.toHaveBeenCalled();
  });

  it("refuses any other failure with fixed copy, never the capability's message, and disposes", async () => {
    getSiteDays.mockResolvedValue({ ok: false, status: 503, code: "METERING_UNAVAILABLE", message: UPSTREAM });
    const out = await loadSavings(request());
    expect(out).toEqual(SAVINGS_REFUSALS.unavailable);
    expect(JSON.stringify(out)).not.toContain("abc123");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes when getSiteDays throws, and lets the error through", async () => {
    getSiteDays.mockRejectedValue(new Error("boom"));
    await expect(loadSavings(request())).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("marks the model synthetic when any day was generated", async () => {
    getSiteDays.mockImplementation(async (q: { start_date: string; end_date: string }) => ({
      ok: true,
      data: days(q.start_date, q.end_date).map((d, i) => (i === 0 ? { ...d, synthetic: true } : d)),
    }));
    const out = await loadSavings(request());
    if (!out.ok) throw new Error("refused");
    expect(out.model.body.tiles.every((t) => t.value.synthetic === true)).toBe(true);
    expect((out.model.ext!.data as SavingsExtData).synthetic).toBe(true);
  });
});

describe("savingsRefusal", () => {
  it.each([
    [{ status: 401, code: "unauthenticated" }, SAVINGS_REFUSALS.forbidden],
    [{ status: 403, code: "forbidden" }, SAVINGS_REFUSALS.forbidden],
    [{ status: 403, code: "METERING_UNAUTHORIZED" }, SAVINGS_REFUSALS.unavailable],
    [{ status: 422, code: "invalid" }, SAVINGS_REFUSALS.notFound],
    [{ status: 500, code: "internal" }, SAVINGS_REFUSALS.failed],
    [{ status: 502, code: "bad_gateway" }, SAVINGS_REFUSALS.unavailable],
  ])("maps %o", (failure, refusal) => {
    expect(savingsRefusal(failure)).toBe(refusal);
  });
});

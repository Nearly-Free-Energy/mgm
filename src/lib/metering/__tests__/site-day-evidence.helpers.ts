/**
 * Builders for the site-day evidence tests: a day of rows, its samples as a
 * provider would return them, and the snapshot built from it. A test
 * helper, not production code.
 */
import type { DeviceConfig } from "@/lib/adapters/types";
import type { SiteSourceEvidence, UnreadableHouseMeter } from "../capability";
import { buildSiteDaySnapshot, type SiteDaySnapshotInput, type SiteDayZone } from "../site-day-evidence";
import { computeSiteDayDetail, type SiteSourceAvailability } from "../site-operations";
import type { SiteSamples } from "../types";

export const MINUTE = 60_000;
export const BIN_MINUTES = 5;
export const BIN_MS = BIN_MINUTES * MINUTE;
export const KAMPALA = "Africa/Kampala";
/** The day of the evidence document's §4 example. */
export const DATE = "2026-11-10";
/** 00:00 on 10 Nov 2026 in Kampala (UTC+3), the example's `t0`. */
export const DAY_START = Date.parse("2026-11-09T21:00:00Z");
export const DAY_END = DAY_START + 24 * 60 * MINUTE;

/**
 * Site devices. Seed-style ids (not an RFC 9562 version), so a device-id
 * check narrower than the `uuid` shape fails these tests.
 */
export const DEVICES = {
  battery: "d0000000-0000-0000-0000-000000000001",
  grid_meter: "d0000000-0000-0000-0000-000000000002",
  inverter: "d0000000-0000-0000-0000-000000000003",
  pv_meter: "d0000000-0000-0000-0000-000000000004",
} as const;
const COMPONENTS = { battery: "ess0", grid_meter: "meter0", inverter: "inverter0", pv_meter: "meter4" } as const;

/** The §4 example's tenant meters `<d1>` … `<d4>`. */
export const D1 = "00000000-0000-4000-8000-0000000000d1";
export const D2 = "00000000-0000-4000-8000-0000000000d2";
export const D3 = "00000000-0000-4000-8000-0000000000d3";
export const D4 = "00000000-0000-4000-8000-0000000000d4";
export const componentOf = (id: string) => `meter${id.slice(-1)}`;

export type Available = { battery: boolean; grid: boolean; load: boolean; pv: boolean };
export const ALL: Available = { battery: true, grid: true, load: true, pv: true };
/** The §4 example's sources: no solar meter. */
export const NO_PV: Available = { battery: true, grid: true, load: true, pv: false };

export type Row = {
  soc?: number | null;
  volts?: number | null;
  batteryW?: number | null;
  gridW?: number | null;
  loadW?: number | null;
  pvW?: number | null;
  meters?: Record<string, number | null>;
};

/** Fills bins [from, to] with `row`. */
export function fill(rows: Map<number, Row>, from: number, to: number, row: Row) {
  for (let pos = from; pos <= to; pos++) rows.set(pos, { ...row });
}

/** Sets meter `id`'s value at bin `pos`, which must hold a row. */
export function meterAt(rows: Map<number, Row>, pos: number, id: string, wh: number | null) {
  const row = rows.get(pos)!;
  rows.set(pos, { ...row, meters: { ...row.meters, [id]: wh } });
}

/**
 * Samples at the start of bin `pos` for each row, as a provider returns
 * them: a series whose source is unavailable is null throughout, and every
 * row has a load reading unless it says otherwise.
 */
export function samplesAt(
  rows: Map<number, Row>,
  available: Available,
  meterIds: readonly string[],
  dayStartMs = DAY_START,
  binMs = BIN_MS
): SiteSamples {
  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: Object.fromEntries(meterIds.map((id) => [id, []])),
  };
  const only = (ok: boolean, v: number | null | undefined) => (ok ? (v ?? null) : null);
  for (const pos of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(pos)!;
    out.timestamps.push(dayStartMs + pos * binMs);
    out.batterySocPct.push(only(available.battery, row.soc));
    out.batteryPowerW.push(only(available.battery, row.batteryW));
    out.gridPowerW.push(only(available.grid, row.gridW));
    out.gridVoltageV.push(only(available.grid, row.volts));
    out.loadPowerW.push(only(available.load, row.loadW === undefined ? 300 : row.loadW));
    out.pvPowerW.push(only(available.pv, row.pvW));
    for (const id of meterIds) out.houseEnergyWh[id].push(row.meters?.[id] ?? null);
  }
  return out;
}

export function sourceEvidence(
  available: Available,
  reasons: Partial<Record<keyof SiteSourceEvidence, "source_not_readable" | "id_not_storable">> = {}
): SiteSourceEvidence {
  const of = (type: keyof SiteSourceEvidence, ok: boolean) =>
    ok
      ? { device: DEVICES[type], edge: "SYNTHETIC-EDGE-EVIDENCE", component: COMPONENTS[type] }
      : { reason: reasons[type] ?? ("source_not_readable" as const) };
  return {
    battery: of("battery", available.battery),
    grid_meter: of("grid_meter", available.grid),
    inverter: of("inverter", available.load),
    pv_meter: of("pv_meter", available.pv),
  };
}

export const houseMeter = (id: string): DeviceConfig => ({
  id,
  edgeOpenemsId: "SYNTHETIC-EDGE-EVIDENCE",
  componentId: componentOf(id),
});

export type EvidenceOptions = {
  available?: Available;
  /** The tenant meters asked of the provider (and held by the samples unless `held` says otherwise). */
  meters?: string[];
  held?: string[];
  unreadable?: UnreadableHouseMeter[];
  nowMs?: number;
  zone?: SiteDayZone;
  unreadableTimestamps?: number | null;
  resolutionMinutes?: number;
  provider?: string;
};

/** The snapshot of a day of rows, with the input and the computed day it came from. */
export function evidenceOf(rows: Map<number, Row>, options: EvidenceOptions = {}) {
  const available = options.available ?? NO_PV;
  const meters = options.meters ?? [];
  const unreadable = options.unreadable ?? [];
  const zone = options.zone ?? { tz: KAMPALA, zone: "microgrid" };
  const resolutionMinutes = options.resolutionMinutes ?? BIN_MINUTES;
  const sources: SiteSourceAvailability = {
    battery: available.battery,
    gridMeter: available.grid,
    load: available.load,
    pv: available.pv,
    houses: meters.length + unreadable.length > 0,
    houseMetersUnreadable: unreadable.length,
  };
  const { day, detail } = computeSiteDayDetail({
    date: DATE,
    timezone: zone.tz,
    samples: samplesAt(rows, available, options.held ?? meters, DAY_START, resolutionMinutes * MINUTE),
    sources,
    resolutionMinutes,
    nowMs: options.nowMs ?? DAY_END + 2 * 60 * MINUTE,
    houseMeterIds: meters,
  });
  const input: SiteDaySnapshotInput = {
    date: DATE,
    zone,
    provider: options.provider ?? "synthetic",
    day,
    detail,
    sources: sourceEvidence(available),
    houseMeters: meters.map(houseMeter),
    unreadableMeters: unreadable,
    unreadableTimestamps: options.unreadableTimestamps === undefined ? 0 : options.unreadableTimestamps,
  };
  return { input, day, detail, snapshot: () => buildSiteDaySnapshot(input) };
}

/**
 * The evidence document's §4 example: the previous day ends at 231.4 V and
 * 14.8%; bins 0–18 are empty and bin 19 reads the grid; bin 119 reads
 * 229.8 V and 63% before an empty run at 120–128; bin 227 reads 0 V before
 * an empty run at 228–260; bin 261 reads the grid back. Meters `<d1>` to
 * `<d3>` as site-day-meters.test.ts reads them.
 */
export function exampleRows(): Map<number, Row> {
  const rows = new Map<number, Row>();
  rows.set(-1, { volts: 231.4, soc: 14.8 });
  fill(rows, 19, 118, { volts: 230, soc: 50 });
  rows.set(119, { volts: 229.8, soc: 63 });
  fill(rows, 129, 226, { volts: 231, soc: 60 });
  rows.set(227, { volts: 0, soc: 58 });
  fill(rows, 261, 287, { volts: 232, soc: 40 });
  meterAt(rows, 215, D1, 48211);
  meterAt(rows, 287, D1, 48903.5);
  meterAt(rows, 215, D2, 182340);
  meterAt(rows, 287, D2, 1200);
  meterAt(rows, 214, D3, 90412.5);
  return rows;
}

/**
 * A day with every range item: a low-battery gap at 0–5, a gap after it at
 * 21–25 (no voltage reading in between), a no-data gap at 100–105, and a
 * dark gap after a 0 V reading at 202–210. Meters `<d1>` to `<d3>`: one
 * counted, one backwards, one with no end.
 */
export function everyItemRows(): Map<number, Row> {
  const rows = new Map<number, Row>();
  rows.set(-1, { volts: 230, soc: 10 });
  fill(rows, 6, 20, { soc: 40, batteryW: 200, gridW: 0, pvW: 0 });
  fill(rows, 26, 99, { volts: 230, soc: 40, batteryW: -100, gridW: 400, pvW: 900 });
  fill(rows, 106, 200, { volts: 231, soc: 45, batteryW: 50, gridW: 300, pvW: 1200 });
  rows.set(201, { volts: 0, soc: 44, batteryW: 300, gridW: 0, pvW: 100 });
  fill(rows, 211, 287, { volts: 232, soc: 50, batteryW: 500, gridW: 0, pvW: 0 });
  meterAt(rows, 215, D1, 1000);
  meterAt(rows, 287, D1, 1500.25);
  meterAt(rows, 215, D2, 5000);
  meterAt(rows, 287, D2, 10);
  meterAt(rows, 215, D3, 700);
  return rows;
}

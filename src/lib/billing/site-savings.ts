/**
 * site-savings.ts — what a site's solar and battery saved against the grid
 * utility's time-of-use tariff, worked out from site days' per-bin flows.
 *
 * Pure: no database, no vendor client, no clock. The caller passes the days
 * (`MeteringCapability.getSiteDays`), the microgrid's effective-dated grid
 * tariffs and its savings settings.
 *
 * Definitions:
 * - Solar savings: every solar kWh valued at the grid rate of its local hour
 *   (what that energy would have cost from the grid), from
 *   `solar_savings_from` on. Solar that charged the battery is counted here
 *   too, and again below as a charge cost, so the total is the reliable
 *   figure rather than either part alone.
 * - Arbitrage: battery discharge while the grid was present, valued at the
 *   rate of its hour, less what that energy cost to put in: the day's
 *   average charging rate (the tariff's lowest rate when the day charged
 *   almost nothing) divided by the round-trip efficiency. Discharge during
 *   a cut is backup, not arbitrage, and is left out; a day with no grid
 *   reading at all has no arbitrage figure. From
 *   `arbitrage_from` on, and only on a day with at least
 *   `ARBITRAGE_MIN_BATTERY_MINUTES` of battery power readings.
 * - A day with no tariff in force has no money figures; it is counted in
 *   `missingTariffDays` instead.
 */
import type { GridTariffBand } from "@/lib/types/domain";
import type { SiteDayOperations } from "@/lib/metering/site-operations";

/** A day needs this many minutes of battery power readings for arbitrage. */
export const ARBITRAGE_MIN_BATTERY_MINUTES = 600;
/**
 * Below this much charging in a day, the day's own charging cannot price
 * the energy it discharged (it was stored on an earlier day): the tariff's
 * lowest rate stands in, so that energy is never counted as free.
 */
export const MIN_CHARGED_KWH = 0.05;

export type TariffInput = { effective_from: string; bands: GridTariffBand[] };

export type SavingsSettingsInput = {
  solar_savings_from: string | null;
  arbitrage_from: string | null;
  round_trip_efficiency: number;
};

export type SavingsColumn = {
  solarSavings: number | null;
  arbitrageGain: number | null;
  total: number | null;
  lightsOnPct: number | null;
  /** Days of the column's range that were read. */
  days: number;
};

export type SavingsSummary = {
  columns: { day: SavingsColumn; month: SavingsColumn; sinceStart: SavingsColumn };
  /**
   * First day of the since-start column: the earlier of the two start dates,
   * raised to the first day read when the read window starts later. Null
   * when neither saving has a start date.
   */
  sinceStartDate: string | null;
  /** Days in the month or since-start range that needed a tariff and had none. */
  missingTariffDays: number;
};

type Validation = { ok: true; bands: GridTariffBand[] } | { ok: false; message: string };

/**
 * Check a tariff's bands: 1 to 24 bands of whole local hours, together
 * covering 0–24 with no gap or overlap, each with a finite rate of 0 or
 * more. Bands may arrive in any order; the result is sorted by start hour
 * and carries only the three band fields.
 */
export function validateGridTariffBands(input: unknown): Validation {
  if (!Array.isArray(input)) return { ok: false, message: "Bands must be a list." };
  if (input.length < 1 || input.length > 24) {
    return { ok: false, message: "A tariff needs between 1 and 24 bands." };
  }
  const bands: GridTariffBand[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "Each band needs a start hour, an end hour and a rate." };
    }
    const { from_hour, to_hour, rate } = raw as Record<string, unknown>;
    if (!Number.isInteger(from_hour) || !Number.isInteger(to_hour)) {
      return { ok: false, message: "Band hours must be whole hours." };
    }
    const from = from_hour as number;
    const to = to_hour as number;
    if (from < 0 || to > 24 || from >= to) {
      return {
        ok: false,
        message: "Each band must start before it ends, between hour 0 and hour 24.",
      };
    }
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      return { ok: false, message: "Each band's rate must be a number of 0 or more." };
    }
    bands.push({ from_hour: from, to_hour: to, rate });
  }
  bands.sort((a, b) => a.from_hour - b.from_hour);
  let expected = 0;
  for (const band of bands) {
    if (band.from_hour !== expected) {
      return {
        ok: false,
        message:
          band.from_hour < expected
            ? `Bands overlap at hour ${band.from_hour}.`
            : `No band covers hour ${expected}.`,
      };
    }
    expected = band.to_hour;
  }
  if (expected !== 24) return { ok: false, message: `No band covers hour ${expected}.` };
  return { ok: true, bands };
}

/** The bands in force on `date`: the tariff with the latest `effective_from` on or before it. */
export function tariffForDate(tariffs: TariffInput[], date: string): GridTariffBand[] | null {
  let best: TariffInput | null = null;
  for (const tariff of tariffs) {
    if (tariff.effective_from > date) continue;
    if (!best || tariff.effective_from > best.effective_from) best = tariff;
  }
  return best ? best.bands : null;
}

/** The rate of the band covering local `hour`. Throws when no band covers it. */
export function rateAt(bands: GridTariffBand[], hour: number): number {
  const band = bands.find((b) => b.from_hour <= hour && hour < b.to_hour);
  if (!band) throw new RangeError(`No tariff band covers hour ${hour}.`);
  return band.rate;
}

type DayValue = {
  date: string;
  solar: number | null;
  arbitrage: number | null;
  missingTariff: boolean;
  knownMinutes: number;
  darkMinutes: number;
};

function valueDay(
  day: SiteDayOperations,
  bands: GridTariffBand[] | null,
  settings: SavingsSettingsInput | null
): DayValue {
  const base = {
    date: day.date,
    knownMinutes: day.knownMinutes,
    darkMinutes: day.darkMinutes,
  };
  const solarApplies = !!settings?.solar_savings_from && day.date >= settings.solar_savings_from;
  const arbitrageApplies = !!settings?.arbitrage_from && day.date >= settings.arbitrage_from;
  const roundTrip = settings?.round_trip_efficiency ?? 1;
  if (!solarApplies && !arbitrageApplies) {
    return { ...base, solar: null, arbitrage: null, missingTariff: false };
  }
  if (!bands) return { ...base, solar: null, arbitrage: null, missingTariff: true };

  const kwh = (watts: number) => (watts * day.resolutionMinutes) / 60 / 1000;

  // No solar meter and no balance to estimate from: unknown, not zero.
  let solar: number | null = null;
  if (solarApplies && day.solarKwh !== null) {
    solar = 0;
    for (const f of day.flows) {
      if (f.solarW !== null) solar += kwh(f.solarW) * rateAt(bands, f.hour);
    }
  }

  let arbitrage: number | null = null;
  // Arbitrage needs to know when the grid was there: with no grid reading
  // all day (no grid meter, or no voltage) it is unknown, not zero.
  if (arbitrageApplies && day.cuts !== null) {
    const batteryMinutes =
      day.flows.filter((f) => f.batteryW !== null).length * day.resolutionMinutes;
    if (batteryMinutes >= ARBITRAGE_MIN_BATTERY_MINUTES) {
      let chargedKwh = 0;
      let chargeCost = 0;
      let arbKwh = 0;
      let arbValue = 0;
      for (const f of day.flows) {
        if (f.batteryW === null) continue;
        const rate = rateAt(bands, f.hour);
        if (f.batteryW < 0) {
          const e = kwh(-f.batteryW);
          chargedKwh += e;
          chargeCost += e * rate;
        } else if (f.batteryW > 0 && f.gridPresent === true) {
          const e = kwh(f.batteryW);
          arbKwh += e;
          arbValue += e * rate;
        }
      }
      const avgChargeRate =
        chargedKwh > MIN_CHARGED_KWH
          ? chargeCost / chargedKwh
          : Math.min(...bands.map((band) => band.rate));
      arbitrage = arbValue - (arbKwh * avgChargeRate) / roundTrip;
    }
  }
  return { ...base, solar, arbitrage, missingTariff: false };
}

function sumOrNull(values: (number | null)[]): number | null {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
}

function column(values: DayValue[]): SavingsColumn {
  const solarSavings = sumOrNull(values.map((v) => v.solar));
  const arbitrageGain = sumOrNull(values.map((v) => v.arbitrage));
  const known = values.reduce((sum, v) => sum + v.knownMinutes, 0);
  const lit = values.reduce((sum, v) => sum + (v.knownMinutes - v.darkMinutes), 0);
  return {
    solarSavings,
    arbitrageGain,
    total:
      solarSavings === null && arbitrageGain === null
        ? null
        : (solarSavings ?? 0) + (arbitrageGain ?? 0),
    lightsOnPct: known > 0 ? (100 * lit) / known : null,
    days: values.length,
  };
}

/**
 * Savings for `date`, its month to date, and since the earlier start date,
 * from the days read. Days after `date` are ignored. A stored tariff whose
 * bands do not pass `validateGridTariffBands` counts as no tariff.
 */
export function valueSiteDays(input: {
  days: SiteDayOperations[];
  tariffs: TariffInput[];
  settings: SavingsSettingsInput | null;
  date: string;
}): SavingsSummary {
  const { tariffs, settings, date } = input;
  const days = input.days.filter((d) => d.date <= date);

  const validated = new Map<GridTariffBand[], GridTariffBand[] | null>();
  const bandsFor = (day: string) => {
    const raw = tariffForDate(tariffs, day);
    if (!raw) return null;
    if (!validated.has(raw)) {
      const checked = validateGridTariffBands(raw);
      validated.set(raw, checked.ok ? checked.bands : null);
    }
    return validated.get(raw) ?? null;
  };
  const values = days.map((d) => valueDay(d, bandsFor(d.date), settings));

  const starts = [settings?.solar_savings_from, settings?.arbitrage_from].filter(
    (s): s is string => !!s
  );
  let sinceStartDate: string | null = starts.length > 0 ? starts.sort()[0] : null;
  const firstRead = days.reduce<string | null>(
    (min, d) => (min === null || d.date < min ? d.date : min),
    null
  );
  if (sinceStartDate && firstRead && firstRead > sinceStartDate) sinceStartDate = firstRead;

  const monthStart = `${date.slice(0, 7)}-01`;
  const within = (from: string | null) => (v: DayValue) => from !== null && v.date >= from;
  const earliest =
    sinceStartDate && sinceStartDate < monthStart ? sinceStartDate : monthStart;

  return {
    columns: {
      day: column(values.filter((v) => v.date === date)),
      month: column(values.filter(within(monthStart))),
      sinceStart: column(values.filter(within(sinceStartDate))),
    },
    sinceStartDate,
    missingTariffDays: values.filter((v) => v.missingTariff && v.date >= earliest).length,
  };
}

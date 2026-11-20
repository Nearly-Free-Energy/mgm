/**
 * TenantAppCapability — what a signed-in tenant reads about their own unit
 * (RFC mgm#197 § 3) and their use of it (§ 5).
 *
 * Import boundary: consumes the repository and usage source interfaces only,
 * never a database client, a provider or a vendor id, so every database read
 * goes through the tenant's own client in the repository the composer built,
 * and the meters whose use is read are the ones that repository returned.
 */
import "server-only";

import { addDaysToDateKey, dayKeyInZone, localHourStarts } from "@/lib/timezone/day-key";
import { validateTimezone } from "@/lib/validation/timezone";
import {
  tenantAppFailure,
  type TenantAppCapabilityContract,
  type TenantAppFailure,
  type TenantAppRepository,
  type TenantAppResult,
  type TenantAppScope,
  type TenantHome,
  type TenantMeter,
  type PrimaryElsewhereSpan,
  type TenantMeterRole,
  type TenantUnit,
  type TenantUsageDay,
  type TenantUsageMonth,
  type TenantUsageSeries,
  type TenantUsageSeriesResult,
  type TenantUsageSource,
} from "./types";
import {
  assignmentsKey,
  computeUsageDay,
  computeUsageMonth,
  datesOfMonth,
  metersOn,
  resolveRequestedDate,
  resolveRequestedMonth,
  sumMeters,
  type UsageFigures,
} from "./usage-calendar";
import { readThrottled, type UsageReadOutcome } from "./usage-throttle";

const ROLE_ORDER: Record<TenantMeterRole, number> = {
  primary_consumption_meter: 0,
  secondary_meter: 1,
};

/**
 * The unit's zone: its microgrid's, or UTC when the stored one is not a
 * valid IANA id, as the metering capability reads it.
 */
function zoneOf(unit: TenantUnit): string {
  return validateTimezone(unit.timezone) ? "UTC" : unit.timezone;
}

/** What one usage read keeps: the clipped, summed figures, never a meter's own series. */
type SummedFigures = { values: Record<string, number | null>; synthetic: boolean };

/** Why the usage source gave no series. */
type SourceRefusal = Extract<TenantUsageSeriesResult, { ok: false }>["reason"];

/** A throttled read as the figures the calendar is built from. */
function figuresOf(outcome: UsageReadOutcome<SummedFigures, SourceRefusal>): UsageFigures {
  switch (outcome.from) {
    case "backend":
    case "cache":
    case "stale":
      return {
        kind: "figures",
        values: outcome.value.values,
        readAt: outcome.readAt,
        stale: outcome.from === "stale",
        synthetic: outcome.value.synthetic,
      };
    case "limited":
      return { kind: "problem", problem: "limited" };
    case "failed": {
      // Metering off, or a provider with no series: another try reads the
      // same, and nothing kept from before is shown. Anything else, a throw
      // included, may pass next time; until then the last read, while it is
      // kept, is shown marked stale with its read time (as decided on
      // mgm#210), as when the unit is over its limit.
      if (outcome.failure === "metering-off" || outcome.failure === "unsupported") {
        return { kind: "problem", problem: "not-offered" };
      }
      if (outcome.kept) {
        return {
          kind: "figures",
          values: outcome.kept.value.values,
          readAt: outcome.kept.readAt,
          stale: true,
          synthetic: outcome.kept.value.synthetic,
        };
      }
      return { kind: "problem", problem: "unavailable" };
    }
  }
}

/**
 * The bucket index of each key. A key the source returned twice has no
 * index, so its bucket reads as no data rather than as either figure.
 */
function uniqueIndexOf<K>(keys: readonly K[]): Map<K, number | undefined> {
  const index = new Map<K, number | undefined>();
  keys.forEach((key, i) => index.set(key, index.has(key) ? undefined : i));
  return index;
}

/** The bucket index of each local day of `series`; a day returned twice has none. */
function dayIndexOf(series: TenantUsageSeries, timezone: string): Map<string, number | undefined> {
  return uniqueIndexOf(series.buckets.map((start) => dayKeyInZone(start, timezone)));
}

const meterLinksUnavailable = () =>
  tenantAppFailure({
    status: 503,
    code: "tenant_app_unavailable",
    message: "Could not read the unit's meters. Retry the request.",
  });

export class TenantAppCapability implements TenantAppCapabilityContract {
  constructor(
    private readonly repo: TenantAppRepository,
    private readonly scope: TenantAppScope,
    private readonly isActive: () => boolean,
    /** The clock "today" and "now" are read from; tests fix it. */
    private readonly now: (() => number) | undefined,
    /**
     * Reads the unit's meters' energy from its microgrid's metering source.
     * Only ever asked about device ids the repository returned for this unit.
     */
    private readonly usage: TenantUsageSource
  ) {}

  private clock(): number {
    return (this.now ?? Date.now)();
  }

  /**
   * The days of [fromDate, toDate) on which a meter of these links is also
   * another unit's primary (D12, decided on mgm#217, 19 November). Rejects
   * when the read fails, and the view then answers meterLinksUnavailable: a
   * span missed would show shared use as the unit's own. It reads MGM's own
   * link rows, not the metering backend, so every view asks for it afresh,
   * outside the usage throttle and its cache, and a kept figure is never
   * served without its label.
   */
  private async sharedSpans(links: readonly TenantMeter[], fromDate: string, toDate: string): Promise<PrimaryElsewhereSpan[]> {
    const deviceIds = [...new Set(links.map((link) => link.deviceId))].sort();
    if (deviceIds.length === 0) return [];
    return this.usage.listPrimaryElsewhere({ deviceIds, fromDate, toDate });
  }

  private ensureActive(): TenantAppFailure | null {
    if (this.isActive()) return null;
    return tenantAppFailure({
      status: 500,
      code: "tenant_app_composition_disposed",
      message: "Tenant app composition has been disposed.",
    });
  }

  /**
   * The unit, its microgrid and its primary consumption meters in force
   * today, each marked when it is also another unit's primary today (D12).
   * "Today" is the microgrid's day, as the tenant's calendar is; a stored
   * zone that is not a valid IANA id reads as UTC, as the metering
   * capability does.
   */
  async getHome(): Promise<TenantAppResult<TenantHome>> {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const { unit } = this.scope;
    const timezone = zoneOf(unit);
    const date = dayKeyInZone(this.clock(), timezone);

    let meters: TenantMeter[];
    try {
      meters = await this.repo.listMetersInForce(unit.tenantId, date);
      // Cut to today, so a span names a meter shared today.
      const spans = await this.sharedSpans(meters, date, addDaysToDateKey(date, 1));
      meters = meters.map((meter) =>
        spans.some((span) => span.deviceId === meter.deviceId) ? { ...meter, shared: true as const } : meter
      );
    } catch {
      return meterLinksUnavailable();
    }

    return {
      ok: true,
      data: {
        tenant: { id: unit.tenantId, displayName: unit.displayName, unitLabel: unit.unitLabel },
        microgrid: { name: unit.microgridName, timezone, currency: unit.currency },
        date,
        meters: [...meters].sort(
          (a, b) =>
            ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
            a.name.localeCompare(b.name) ||
            a.deviceId.localeCompare(b.deviceId)
        ),
      },
    };
  }

  /**
   * A month of the unit's use per local day (RFC mgm#197 § 5), in the unit's
   * zone. The meters of each day are the unit's links in force on it, read
   * through the tenant's own client; the source is asked once, for every
   * meter in force on some day up to today, from the unit's first such day
   * of the month to its last, and each meter counts only on its own link's
   * days. Future days are not read. A failed or refused read is not a
   * failure of the call: the month still loads, and every day with a meter
   * shows no data.
   */
  async getUsageMonth(input: { month?: string } = {}): Promise<TenantAppResult<TenantUsageMonth>> {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const { unit } = this.scope;
    const timezone = zoneOf(unit);
    const nowMs = this.clock();
    const today = dayKeyInZone(nowMs, timezone);
    const month = resolveRequestedMonth(input.month, today);
    const dates = datesOfMonth(month);
    const last = dates[dates.length - 1];

    let links: TenantMeter[];
    let shared: PrimaryElsewhereSpan[];
    try {
      links = await this.repo.listMeterAssignments(unit.tenantId, dates[0], addDaysToDateKey(last, 1));
      shared = await this.sharedSpans(links, dates[0], addDaysToDateKey(last, 1));
    } catch {
      return meterLinksUnavailable();
    }

    const readUntil = last < today ? last : today;
    const inForce = dates.filter((date) => date <= readUntil && metersOn(links, date).size > 0);
    let figures: UsageFigures = { kind: "none" };
    if (inForce.length > 0) {
      const devices = new Set(inForce.flatMap((date) => [...metersOn(links, date)]));
      const outcome = await readThrottled<SummedFigures, SourceRefusal>(
        unit.tenantId,
        `month|${month}|${today}|${timezone}|${assignmentsKey(links)}`,
        nowMs,
        async () => {
          const result = await this.usage.readSeries({
            deviceIds: [...devices].sort(),
            startDate: inForce[0],
            endDate: inForce[inForce.length - 1],
            resolution: "day",
            timezone,
            nowMs,
          });
          if (!result.ok) return { ok: false, failure: result.reason };
          // Built here, from the buckets' own days, so a source that returns
          // fewer buckets gives no data, never a figure on the wrong day.
          const index = dayIndexOf(result.series, timezone);
          const values: Record<string, number | null> = {};
          for (const date of inForce) {
            values[date] = sumMeters(result.series, metersOn(links, date), index.get(date));
          }
          return { ok: true, value: { values, synthetic: result.series.synthetic } };
        }
      );
      figures = figuresOf(outcome);
    }

    return {
      ok: true,
      data: computeUsageMonth({
        tenant: { id: unit.tenantId, displayName: unit.displayName, unitLabel: unit.unitLabel },
        timezone,
        month,
        today,
        nowMs,
        assignments: links,
        figures,
        shared,
      }),
    };
  }

  /**
   * One local day of the unit's use per hour (RFC mgm#197 § 5), in the
   * unit's zone (23 or 25 hours on a daylight-saving day). The meters are
   * the unit's links in force on that day; a day with none reads nothing.
   * A failed or refused read still loads the day, with no data.
   */
  async getUsageDay(input: { date?: string } = {}): Promise<TenantAppResult<TenantUsageDay>> {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const { unit } = this.scope;
    const timezone = zoneOf(unit);
    const nowMs = this.clock();
    const today = dayKeyInZone(nowMs, timezone);
    const date = resolveRequestedDate(input.date, today);

    let links: TenantMeter[];
    let shared: PrimaryElsewhereSpan[];
    try {
      links = await this.repo.listMeterAssignments(unit.tenantId, date, addDaysToDateKey(date, 1));
      shared = await this.sharedSpans(links, date, addDaysToDateKey(date, 1));
    } catch {
      return meterLinksUnavailable();
    }

    const devices = metersOn(links, date);
    let figures: UsageFigures = { kind: "none" };
    if (devices.size > 0) {
      const outcome = await readThrottled<SummedFigures, SourceRefusal>(
        unit.tenantId,
        `day|${date}|${today}|${timezone}|${assignmentsKey(links)}`,
        nowMs,
        async () => {
          const result = await this.usage.readSeries({
            deviceIds: [...devices].sort(),
            startDate: date,
            endDate: date,
            resolution: "hour",
            timezone,
            nowMs,
          });
          if (!result.ok) return { ok: false, failure: result.reason };
          // Matched by instant, not position, so a missing hour shifts none;
          // an hour returned twice reads as no data, as a day does.
          const index = uniqueIndexOf(result.series.buckets);
          const values: Record<string, number | null> = {};
          for (const start of localHourStarts(date, timezone)) {
            values[String(start)] = sumMeters(result.series, devices, index.get(start));
          }
          return { ok: true, value: { values, synthetic: result.series.synthetic } };
        }
      );
      figures = figuresOf(outcome);
    }

    return {
      ok: true,
      data: computeUsageDay({
        tenant: { id: unit.tenantId, displayName: unit.displayName, unitLabel: unit.unitLabel },
        timezone,
        date,
        today,
        nowMs,
        assignments: links,
        figures,
        shared,
      }),
    };
  }
}

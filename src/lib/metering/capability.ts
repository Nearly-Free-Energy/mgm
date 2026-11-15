/**
 * MeteringCapability — typed entry point for the metering plugin's domain
 * operations (issue #4).
 *
 * Import boundary: consumes the repository/connection interfaces and the
 * provider registry only — never a database client or vendor SDK. See
 * `__tests__/import-boundary.test.ts`.
 */
import "server-only";

import { validateTimezone } from "@/lib/validation/timezone";
import { MeteringError } from "./errors";
import { computeAssignmentGaps } from "./assignment-gaps";
import {
  computeSiteDay,
  type SiteDayOperations,
  type SiteSourceAvailability,
} from "./site-operations";
import { addDaysToDateKey, dayKeyInZone, isCalendarDateKey } from "@/lib/timezone/day-key";
import type {
  ManagedDevice,
  MeteringCapabilityContract,
  MeteringConnection,
  MeteringRepository,
  MeteringResult,
  MeteringScope,
  StoredConnectionCandidate,
} from "./repository";
import type {
  AssignmentHistoryEntry,
  DeviceConsumption,
  DiscoveredMeter,
  MeteringProvider,
  OpeningRegisterInput,
  SiteSources,
} from "./types";
import type { MeteringProviderName } from "./registry";
import { MeteringRegistry } from "./registry";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The daily operations view reads 5-minute bins (what OpenEMS keeps). */
const SITE_RESOLUTION_MINUTES = 5;
/** The longest range `getSiteDays` reads, in days. */
export const SITE_DAYS_MAX = 366;
/** How many chunk reads `getSiteDays` runs at once. */
export const SITE_DAYS_PARALLEL = 3;

/** The most days `getSiteDays` asks the provider for in one call. */
export const SITE_DAYS_CHUNK = 31;

/** Whole days from `from` to `to` (calendar keys; negative when `to` is earlier). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The site devices the daily operations view reads, chosen by device type.
 * The first of each type wins, by name; a second battery or grid meter is
 * not added up.
 *
 * The load is the inverter's AC output: a device of type `inverter` (for an
 * SRNE hybrid, its backup meter). With the battery's DC power and the grid
 * meter it gives solar where no solar meter exists. Household consumption
 * meters are not the load: they miss the site's own use and unmetered loads.
 *
 * The house meters are the consumption meters in `houseMeterIds` (those
 * linked to a household on the day read), all of them, by name: what the
 * houses used is their sum. A linked device of another type (a site's grid
 * meter standing in as a "shared" meter for un-metered houses, say) is not
 * a house meter. Linked meters without
 * an edge or component id cannot be read; they are counted, not dropped.
 */
export function pickSiteSources(
  devices: ManagedDevice[],
  houseMeterIds: string[] = []
): SiteSources {
  const sorted = [...devices].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
  const readable = (d: ManagedDevice) => Boolean(d.edgeOpenemsId && d.componentId);
  const usable = sorted.filter(readable);
  const config = (device: ManagedDevice) => ({
    id: device.id,
    edgeOpenemsId: device.edgeOpenemsId,
    componentId: device.componentId,
  });
  const first = (type: string) => {
    const device = usable.find((d) => d.deviceType === type);
    return device ? config(device) : null;
  };
  // Only consumption meters: the site sources are other types, so no device
  // is read both as a site source and as a house.
  const houses = new Set(houseMeterIds);
  const linked = sorted.filter((d) => houses.has(d.id) && d.deviceType === "consumption_meter");
  return {
    battery: first("battery"),
    gridMeter: first("grid_meter"),
    load: first("inverter"),
    pv: first("pv_meter"),
    houseMeters: linked.filter(readable).map(config),
    houseMetersUnreadable: linked.filter((d) => !readable(d)).length,
  };
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

export class MeteringCapability implements MeteringCapabilityContract {
  constructor(
    private readonly repo: MeteringRepository,
    private readonly scope: MeteringScope,
    private readonly registry: MeteringRegistry,
    private readonly connection: MeteringConnection,
    private readonly isActive: () => boolean,
    /**
     * Picks the provider for a microgrid's site day; compose.ts binds it to
     * `meteringProviders.select`. The default keeps OpenEMS.
     */
    private readonly selectProvider: (
      microgridId: string
    ) => Promise<MeteringProviderName> = async () => "openems"
  ) {}

  private ensureActive(): Extract<MeteringResult<never>, { ok: false }> | null {
    if (this.isActive()) return null;
    return {
      ok: false,
      status: 500,
      code: "metering_composition_disposed",
      message: "Metering composition has been disposed.",
    };
  }

  private scopeMismatch() {
    return {
      ok: false as const,
      status: 403 as const,
      code: "metering_scope_mismatch",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    };
  }

  /**
   * The plugin can be turned off between composition and a call, so each
   * gated method reads its state again here, with composeMetering's policy.
   * An unreadable state fails closed with the gate's 503 code and wording
   * (`MgmGate.check`, src/lib/runtime/gate.ts); if the gate's codes or
   * wording change, change them here. The 503 relies on the repository
   * rejecting when it cannot read the state, as the Supabase repository does
   * through `isPluginEnabledForOrg`; a repository that turns a failed read
   * into `false` answers 409 `metering_disabled` instead.
   */
  private async requirePlugin(): Promise<Extract<
    MeteringResult<never>,
    { ok: false }
  > | null> {
    let enabled: boolean;
    try {
      enabled = await this.repo.isPluginEnabled(this.scope.organizationId);
    } catch {
      return {
        ok: false,
        status: 503,
        code: "metering_gate_unavailable",
        message: "Could not verify whether Metering is enabled. Retry the request.",
      };
    }
    if (enabled) return null;
    return {
      ok: false,
      status: 409,
      code: "metering_disabled",
      message:
        "Metering is disabled for this organization. Enable it in Settings → Plugins; configuration, assignments, and readings are preserved.",
    };
  }

  private async resolveMicrogridOrg(microgridId: string): Promise<
    | { ok: true; orgId: string }
    | {
        ok: false;
        status: 400 | 403;
        code: string;
        message: string;
        reason: string;
      }
  > {
    if (!UUID_RE.test(microgridId)) {
      return {
        ok: false,
        status: 400,
        code: "metering_invalid_microgrid",
        message: "Invalid microgrid id — expected UUID.",
        reason: "invalid_microgrid",
      };
    }
    const resolved = await this.repo.getMicrogridOrganization(microgridId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    return { ok: true, orgId: resolved.orgId };
  }

  private fromMeteringError(error: MeteringError) {
    const status = (
      [400, 401, 403, 404, 409, 422, 500, 503] as const
    ).includes(error.statusCode as never)
      ? (error.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503)
      : 503;
    return {
      ok: false as const,
      status,
      code: error.code,
      message: error.message,
    };
  }

  async testConnection(
    microgridId: string,
    candidate?: StoredConnectionCandidate
  ) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const resolved = await this.resolveMicrogridOrg(microgridId);
    if (!resolved.ok) return resolved;
    const gated = await this.requirePlugin();
    if (gated) return gated;
    try {
      const result = candidate
        ? await this.connection.testCandidate(microgridId, candidate)
        : await this.connection.testStored(microgridId);
      return { ok: true as const, data: result };
    } catch (error) {
      if (error instanceof MeteringError) return this.fromMeteringError(error);
      throw error;
    }
  }

  async discoverMeters(microgridId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const resolved = await this.resolveMicrogridOrg(microgridId);
    if (!resolved.ok) return resolved;
    const gated = await this.requirePlugin();
    if (gated) return gated;
    try {
      const edges = await this.connection.discover(microgridId);
      const managed = await this.repo.getManagedDevices(microgridId);
      const registered = new Set(
        managed.map((d) => `${d.edgeOpenemsId}/${d.componentId}`)
      );
      const out: DiscoveredMeter[] = [];
      for (const edge of edges) {
        for (const component of edge.components) {
          out.push({
            edgeId: edge.edgeId,
            componentId: component.id,
            name: component.name,
            alreadyRegistered: registered.has(`${edge.edgeId}/${component.id}`),
          });
        }
      }
      return { ok: true as const, data: out };
    } catch (error) {
      if (error instanceof MeteringError) return this.fromMeteringError(error);
      throw error;
    }
  }

  async getConsumption(query: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "metering_invalid_query",
        message: "Invalid consumption query body.",
      };
    }
    const q = query as Record<string, unknown>;
    const microgridId =
      typeof q.microgrid_id === "string" ? q.microgrid_id : "";
    const resolved = await this.resolveMicrogridOrg(microgridId);
    if (!resolved.ok) return resolved;
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const startDate = typeof q.start_date === "string" ? q.start_date : "";
    const endDate = typeof q.end_date === "string" ? q.end_date : "";
    if (!isRealDate(startDate) || !isRealDate(endDate) || startDate > endDate) {
      return {
        ok: false as const,
        status: 422 as const,
        code: "metering_invalid_range",
        message: "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.",
        field: "start_date",
      };
    }
    let timezone =
      typeof q.timezone === "string" && q.timezone ? q.timezone : null;
    if (timezone) {
      const tzError = validateTimezone(timezone);
      if (tzError) {
        return {
          ok: false as const,
          status: 422 as const,
          code: "metering_invalid_timezone",
          message: tzError,
          field: "timezone",
        };
      }
    } else {
      timezone = (await this.repo.getMicrogridTimezone(microgridId)) ?? "UTC";
    }

    const providerName =
      q.provider === undefined || q.provider === null
        ? ("openems" as MeteringProviderName)
        : q.provider;
    if (providerName !== "openems" && providerName !== "fixture") {
      return {
        ok: false as const,
        status: 422 as const,
        code: "metering_invalid_provider",
        message: "provider must be 'openems' or 'fixture'.",
        field: "provider",
      };
    }
    let provider;
    try {
      provider = this.registry.resolve(providerName);
    } catch {
      return {
        ok: false as const,
        status: 503 as const,
        code: "METERING_CONFIGURATION",
        message: "Metering provider is not available.",
      };
    }

    const managed = await this.repo.getManagedDevices(microgridId);
    const byId = new Map(managed.map((d) => [d.id, d]));
    const requestedIds = new Set<string>();
    if (Array.isArray(q.device_ids)) {
      for (const id of q.device_ids) {
        if (typeof id === "string") requestedIds.add(id);
      }
    }
    if (Array.isArray(q.household_ids)) {
      for (const householdId of q.household_ids) {
        if (typeof householdId !== "string") continue;
        const links = await this.repo.getAssignmentLinks(householdId);
        for (const link of links) requestedIds.add(link.deviceId);
      }
    }
    const devices =
      requestedIds.size > 0
        ? managed.filter((d) => requestedIds.has(d.id))
        : managed;
    const unknownIds = [...requestedIds].filter((id) => !byId.has(id));
    if (unknownIds.length > 0) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "metering_unknown_device",
        message: `Unknown meter(s) on this microgrid: ${unknownIds.join(", ")}.`,
      };
    }
    if (devices.length === 0) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "metering_no_devices",
        message: "No meters found for this query.",
      };
    }

    // Household attribution comes from assignment history: a device maps to
    // every household it was ever linked to. Reads are per meter register —
    // never aggregated, never zero-filled.
    const householdByDevice = new Map<string, string>();
    if (Array.isArray(q.household_ids)) {
      for (const householdId of q.household_ids) {
        if (typeof householdId !== "string") continue;
        const links = await this.repo.getAssignmentLinks(householdId);
        for (const link of links) householdByDevice.set(link.deviceId, householdId);
      }
    }

    let readings;
    try {
      readings = await provider.getReadings({
        microgridId,
        devices: devices.map((d) => ({
          id: d.id,
          edgeOpenemsId: d.edgeOpenemsId,
          componentId: d.componentId,
        })),
        startDate,
        endDate,
        timezone,
      });
    } catch (error) {
      if (error instanceof MeteringError) return this.fromMeteringError(error);
      throw error;
    }
    const readAt = new Date().toISOString();
    const out: DeviceConsumption[] = readings.map((reading) => ({
      deviceId: reading.deviceId,
      householdId: householdByDevice.get(reading.deviceId) ?? null,
      usageKwh: reading.usageKwh,
      source: providerName,
      readAt,
    }));
    return { ok: true as const, data: out };
  }

  async getAssignmentHistory(householdId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(householdId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "metering_invalid_household",
        message: "Invalid household id — expected UUID.",
      };
    }
    const resolved = await this.repo.getHouseholdOrganization(householdId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    // Reads stay available while the plugin is disabled — only scope applies.

    const links = await this.repo.getAssignmentLinks(householdId);
    const managed = await this.repo.getManagedDevices(resolved.microgridId);
    const names = new Map(managed.map((d) => [d.id, d.name]));
    const { sorted, gaps } = computeAssignmentGaps(links);
    const entries: AssignmentHistoryEntry[] = sorted.map((link, index) => ({
      deviceId: link.deviceId,
      deviceName: names.get(link.deviceId) ?? link.deviceId,
      role: link.role,
      effectiveFrom: link.effectiveFrom,
      effectiveTo: link.effectiveTo,
      current: link.effectiveTo === null && index === sorted.length - 1,
    }));
    return { ok: true as const, data: { entries, gaps } };
  }

  async recordOpeningRegister(input: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "metering_invalid_body",
        message: "Invalid opening register body.",
      };
    }
    const record = input as Record<string, unknown> & Partial<OpeningRegisterInput>;
    const deviceId = typeof record.deviceId === "string" ? record.deviceId : "";
    if (!UUID_RE.test(deviceId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "metering_invalid_device",
        message: "Invalid device id — expected UUID.",
        field: "deviceId",
      };
    }
    if (
      typeof record.readingKwh !== "number" ||
      !Number.isFinite(record.readingKwh) ||
      record.readingKwh < 0
    ) {
      return {
        ok: false as const,
        status: 422 as const,
        code: "metering_invalid_reading",
        message: "readingKwh must be a finite number >= 0.",
        field: "readingKwh",
      };
    }
    const readAt =
      typeof record.readAt === "string" ? record.readAt : "";
    const readAtTime = Date.parse(readAt);
    if (!readAt || Number.isNaN(readAtTime) || readAtTime > Date.now()) {
      return {
        ok: false as const,
        status: 422 as const,
        code: "metering_invalid_read_at",
        message: "readAt must be a valid timestamp not in the future.",
        field: "readAt",
      };
    }

    const resolved = await this.repo.getDeviceOrganization(deviceId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const existing = await this.repo.findMeterReadingAt(deviceId, readAt);
    if (existing) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "metering_duplicate_reading",
        message: "A reading is already recorded for this meter at readAt.",
      };
    }
    const { id, error } = await this.repo.insertMeterReading({
      deviceId,
      readingKwh: record.readingKwh,
      readAt,
    });
    if (error || !id) {
      if (
        error &&
        (error.code === "42501" || error.message.includes("row-level security"))
      ) {
        return {
          ok: false as const,
          status: 403 as const,
          code: "metering_forbidden",
          message: "Not authorized to record readings for this meter.",
        };
      }
      return {
        ok: false as const,
        status: 500 as const,
        code: "metering_unavailable",
        message: `Could not record the opening register: ${error?.message ?? "unknown error"}.`,
      };
    }
    return { ok: true as const, data: { id } };
  }

  /**
   * The checks every site read shares, up to the date: disposal, query
   * shape, microgrid scope, the plugin gate, then the microgrid's timezone
   * and the clock the dates are checked against.
   */
  private async openSiteQuery(query: unknown): Promise<
    | Extract<MeteringResult<never>, { ok: false }>
    | {
        ok: true;
        q: Record<string, unknown>;
        microgridId: string;
        timezone: string;
        nowMs: number;
        today: string;
      }
  > {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "metering_invalid_query",
        message: "Invalid site day query.",
      };
    }
    const q = query as Record<string, unknown>;
    const microgridId = typeof q.microgrid_id === "string" ? q.microgrid_id : "";
    const resolved = await this.resolveMicrogridOrg(microgridId);
    if (!resolved.ok) return resolved;
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const stored = await this.repo.getMicrogridTimezone(microgridId);
    const timezone = stored && !validateTimezone(stored) ? stored : "UTC";
    const nowMs = Date.now();
    return { ok: true, q, microgridId, timezone, nowMs, today: dayKeyInZone(nowMs, timezone) };
  }

  /**
   * The provider's site-sample reader and the site devices to read, once the
   * dates are valid. `houseDate` picks the house meters assigned on that day;
   * null reads no house meters (a range read, whose days can have different
   * house meters and whose savings figures do not use them).
   */
  private async openSiteReader(
    microgridId: string,
    houseDate: string | null
  ): Promise<
    | Extract<MeteringResult<never>, { ok: false }>
    | {
        ok: true;
        getSiteSamples: NonNullable<MeteringProvider["getSiteSamples"]>;
        sources: SiteSources;
        availability: SiteSourceAvailability;
        synthetic: boolean;
      }
  > {
    let providerName: MeteringProviderName;
    try {
      providerName = await this.selectProvider(microgridId);
    } catch (error) {
      if (error instanceof MeteringError) return this.fromMeteringError(error);
      return {
        ok: false as const,
        status: 503 as const,
        code: "METERING_CONFIGURATION",
        message: "Metering provider is not available.",
      };
    }
    let provider: MeteringProvider;
    try {
      provider = this.registry.resolve(providerName);
    } catch {
      return {
        ok: false as const,
        status: 503 as const,
        code: "METERING_CONFIGURATION",
        message: "Metering provider is not available.",
      };
    }
    if (!provider.getSiteSamples) {
      return {
        ok: false as const,
        status: 503 as const,
        code: "METERING_CONFIGURATION",
        message: "This metering source does not provide site samples.",
      };
    }

    let devices: ManagedDevice[];
    let houseMeterIds: string[];
    try {
      [devices, houseMeterIds] = await Promise.all([
        this.repo.getManagedDevices(microgridId),
        houseDate === null ? Promise.resolve([]) : this.repo.getHouseMeterIds(microgridId, houseDate),
      ]);
    } catch (error) {
      console.error("MGM site devices could not be read", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : "non-Error thrown",
      });
      return {
        ok: false as const,
        status: 503 as const,
        code: "metering_site_devices_unavailable",
        message: "This microgrid's meters could not be read. Try again shortly.",
      };
    }
    const sources = pickSiteSources(devices, houseMeterIds);
    const availability = {
      battery: sources.battery !== null,
      gridMeter: sources.gridMeter !== null,
      load: sources.load !== null,
      pv: sources.pv !== null,
      houses: sources.houseMeters.length + sources.houseMetersUnreadable > 0,
      houseMetersUnreadable: sources.houseMetersUnreadable,
    };
    if (!availability.battery && !availability.gridMeter) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "metering_no_site_devices",
        message:
          "No battery or grid meter is registered on this microgrid. Add them under Setup → Edges.",
      };
    }
    return {
      ok: true,
      getSiteSamples: provider.getSiteSamples.bind(provider),
      sources,
      availability,
      synthetic: provider.synthetic === true,
    };
  }

  /** A failure while reading or computing site days, reported as one. */
  private siteReadFailed(
    error: unknown,
    context: Record<string, string>,
    code: string,
    message: string
  ): Extract<MeteringResult<never>, { ok: false }> {
    if (error instanceof MeteringError) return this.fromMeteringError(error);
    // A day the computation cannot handle is one failed view, not a
    // failed page: report it like any other unavailable read.
    console.error("MGM site day could not be computed", {
      ...context,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : "non-Error thrown",
    });
    return { ok: false as const, status: 500 as const, code, message };
  }

  /**
   * One local day of the site's battery, grid and supply (the daily
   * operations view). Query: `{ microgrid_id, date: "YYYY-MM-DD" }`; the day
   * is in the microgrid's timezone. Reads the vendor, so it is gated like
   * `getConsumption`.
   */
  async getSiteDay(query: unknown): Promise<MeteringResult<SiteDayOperations>> {
    const opened = await this.openSiteQuery(query);
    if (!opened.ok) return opened;
    const { q, microgridId, timezone, nowMs, today } = opened;
    const date = typeof q.date === "string" ? q.date : "";
    if (!isCalendarDateKey(date) || date > today) {
      return {
        ok: false as const,
        status: 422 as const,
        code: "metering_invalid_date",
        message: "date must be a YYYY-MM-DD day that has started in the microgrid's timezone.",
        field: "date",
      };
    }

    const reader = await this.openSiteReader(microgridId, date);
    if (!reader.ok) return reader;

    try {
      // The previous day's tail tells whether this day began in a cut.
      const samples = await reader.getSiteSamples({
        microgridId,
        sources: reader.sources,
        startDate: addDaysToDateKey(date, -1),
        endDate: date,
        timezone,
        resolutionMinutes: SITE_RESOLUTION_MINUTES,
      });
      const day = computeSiteDay({
        date,
        timezone,
        samples,
        sources: reader.availability,
        resolutionMinutes: SITE_RESOLUTION_MINUTES,
        nowMs,
      });
      return {
        ok: true as const,
        data: reader.synthetic ? { ...day, synthetic: true as const } : day,
      };
    } catch (error) {
      return this.siteReadFailed(
        error,
        { date, timezone },
        "metering_site_day_failed",
        "This day's operations could not be worked out. Try another day."
      );
    }
  }

  /**
   * Every local day from `start_date` to `end_date` inclusive, worked out as
   * `getSiteDay` does (the savings figures add these up). Query:
   * `{ microgrid_id, start_date, end_date }`, at most `SITE_DAYS_MAX` days,
   * ending no later than today in the microgrid's timezone. Reads the vendor
   * in chunks of at most `SITE_DAYS_CHUNK` days, each from the day before
   * its first so the first day's carry-in works. Gated like `getSiteDay`;
   * one failed chunk fails the whole read. Reads no house meters, so each
   * day's houses figures are empty.
   */
  async getSiteDays(query: unknown): Promise<MeteringResult<SiteDayOperations[]>> {
    const opened = await this.openSiteQuery(query);
    if (!opened.ok) return opened;
    const { q, microgridId, timezone, nowMs, today } = opened;
    const startDate = typeof q.start_date === "string" ? q.start_date : "";
    const endDate = typeof q.end_date === "string" ? q.end_date : "";
    const invalid = (field: string, message: string) => ({
      ok: false as const,
      status: 422 as const,
      code: "metering_invalid_date",
      message,
      field,
    });
    if (!isCalendarDateKey(startDate)) {
      return invalid("start_date", "start_date must be a YYYY-MM-DD day.");
    }
    if (!isCalendarDateKey(endDate) || endDate > today) {
      return invalid(
        "end_date",
        "end_date must be a YYYY-MM-DD day that has started in the microgrid's timezone."
      );
    }
    if (startDate > endDate) {
      return invalid("start_date", "start_date must not be after end_date.");
    }
    const dayCount = daysBetween(startDate, endDate) + 1;
    if (dayCount > SITE_DAYS_MAX) {
      return invalid("start_date", `A range may cover at most ${SITE_DAYS_MAX} days.`);
    }

    const reader = await this.openSiteReader(microgridId, null);
    if (!reader.ok) return reader;

    const chunks: { start: string; length: number }[] = [];
    for (let offset = 0; offset < dayCount; offset += SITE_DAYS_CHUNK) {
      chunks.push({
        start: addDaysToDateKey(startDate, offset),
        length: Math.min(SITE_DAYS_CHUNK, dayCount - offset),
      });
    }
    const days: SiteDayOperations[] = [];
    try {
      // A few chunks at a time: a long range should not wait for each read
      // in turn, nor send every read to OpenEMS at once.
      for (let i = 0; i < chunks.length; i += SITE_DAYS_PARALLEL) {
        const batch = await Promise.all(
          chunks.slice(i, i + SITE_DAYS_PARALLEL).map(async (chunk) => ({
            chunk,
            samples: await reader.getSiteSamples({
              microgridId,
              sources: reader.sources,
              startDate: addDaysToDateKey(chunk.start, -1),
              endDate: addDaysToDateKey(chunk.start, chunk.length - 1),
              timezone,
              resolutionMinutes: SITE_RESOLUTION_MINUTES,
            }),
          }))
        );
        for (const { chunk, samples } of batch) {
          for (let d = 0; d < chunk.length; d++) {
            const day = computeSiteDay({
              date: addDaysToDateKey(chunk.start, d),
              timezone,
              samples,
              sources: reader.availability,
              resolutionMinutes: SITE_RESOLUTION_MINUTES,
              nowMs,
            });
            days.push(reader.synthetic ? { ...day, synthetic: true as const } : day);
          }
        }
      }
    } catch (error) {
      return this.siteReadFailed(
        error,
        { startDate, endDate, timezone },
        "metering_site_days_failed",
        "These days' operations could not be worked out. Try a shorter range."
      );
    }
    return { ok: true as const, data: days };
  }
}

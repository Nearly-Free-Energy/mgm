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
import type {
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
  OpeningRegisterInput,
} from "./types";
import type { MeteringProviderName } from "./registry";
import { MeteringRegistry } from "./registry";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    private readonly isActive: () => boolean
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

  private async requirePlugin(): Promise<Extract<
    MeteringResult<never>,
    { ok: false }
  > | null> {
    if (await this.repo.isPluginEnabled(this.scope.organizationId)) return null;
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
}

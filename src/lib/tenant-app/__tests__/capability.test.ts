import { describe, expect, it, vi } from "vitest";
import { TenantAppCapability } from "../capability";
import { createSupabaseTenantAppRepository } from "../infrastructure/supabase-repository";
import type { TenantAppRepository, TenantAppScope, TenantMeter, TenantUsageSource } from "../types";

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440010";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";

/** 22:30 UTC on 18 November: already the 19th in Kampala (UTC+3). */
const NOW = Date.parse("2026-11-18T22:30:00Z");

function scope(timezone = "Africa/Kampala"): TenantAppScope {
  return {
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    userId: "user-1",
    unit: {
      tenantId: TENANT_ID,
      displayName: "Unit Four Tenant",
      unitLabel: "Shop 4",
      microgridId: "550e8400-e29b-41d4-a716-446655440020",
      microgridName: "Kasana East",
      timezone,
      currency: "UGX",
      organizationId: ORG_ID,
    },
  };
}

function meter(overrides: Partial<TenantMeter>): TenantMeter {
  return {
    deviceId: "d",
    name: "Meter",
    deviceType: "consumption_meter",
    role: "primary_consumption_meter",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

function repository(meters: TenantMeter[] | Error) {
  const listMetersInForce = vi.fn(async () => {
    if (meters instanceof Error) throw meters;
    return meters;
  });
  const listMeterAssignments = vi.fn(async () => {
    throw new Error("the home reads no assignments over a range");
  });
  return {
    repo: { listMetersInForce, listMeterAssignments } satisfies TenantAppRepository,
    listMetersInForce,
  };
}

/** The home reads no usage; a source that fails the test if asked. */
const noUsage: TenantUsageSource = {
  readSeries: async () => {
    throw new Error("the home reads no usage");
  },
};

describe("TenantAppCapability.getHome", () => {
  it("returns the unit, its microgrid and the meters in force today in the microgrid's zone", async () => {
    const { repo, listMetersInForce } = repository([
      meter({ deviceId: "d3", name: "B secondary", role: "secondary_meter" }),
      meter({ deviceId: "d2", name: "Z main" }),
      meter({ deviceId: "d1", name: "A main" }),
    ]);
    const capability = new TenantAppCapability(repo, scope(), () => true, () => NOW, noUsage);

    const result = await capability.getHome();

    expect(listMetersInForce).toHaveBeenCalledWith(TENANT_ID, "2026-11-19");
    expect(result).toEqual({
      ok: true,
      data: {
        tenant: { id: TENANT_ID, displayName: "Unit Four Tenant", unitLabel: "Shop 4" },
        microgrid: { name: "Kasana East", timezone: "Africa/Kampala", currency: "UGX" },
        date: "2026-11-19",
        meters: [
          expect.objectContaining({ deviceId: "d1" }),
          expect.objectContaining({ deviceId: "d2" }),
          expect.objectContaining({ deviceId: "d3" }),
        ],
      },
    });
  });

  it("reads a stored zone that is not an IANA id as UTC", async () => {
    const { repo, listMetersInForce } = repository([]);
    const capability = new TenantAppCapability(repo, scope("Kampala"), () => true, () => NOW, noUsage);

    const result = await capability.getHome();

    expect(listMetersInForce).toHaveBeenCalledWith(TENANT_ID, "2026-11-18");
    expect(result).toMatchObject({ ok: true, data: { date: "2026-11-18", microgrid: { timezone: "UTC" } } });
  });

  it("answers 503 when the meters cannot be read", async () => {
    const { repo } = repository(new Error("statement timeout"));
    const capability = new TenantAppCapability(repo, scope(), () => true, () => NOW, noUsage);

    expect(await capability.getHome()).toEqual({
      ok: false,
      status: 503,
      code: "tenant_app_unavailable",
      message: expect.stringContaining("Retry"),
    });
  });

  it("refuses once its composition is disposed, without reading", async () => {
    const { repo, listMetersInForce } = repository([]);
    const capability = new TenantAppCapability(repo, scope(), () => false, () => NOW, noUsage);

    expect(await capability.getHome()).toMatchObject({
      ok: false,
      status: 500,
      code: "tenant_app_composition_disposed",
    });
    expect(listMetersInForce).not.toHaveBeenCalled();
  });
});

/** A client whose one query records each call and answers `result`. */
function recordingClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: unknown[][] = [];
  const query: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ["select", "eq", "in", "lte", "lt", "or", "order"]) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  }
  const client = {
    from: (table: string) => {
      calls.push(["from", table]);
      return query;
    },
  };
  return { client: client as never, calls };
}

describe("the Supabase tenant app repository", () => {
  it("reads the tenant's consumption meter links in force on the day, with the device's name and type only", async () => {
    const { client, calls } = recordingClient({
      data: [
        {
          device_id: "d1",
          role: "primary_consumption_meter",
          effective_from: "2026-11-01",
          effective_to: null,
          devices: { id: "d1", name: "Shop 4 meter", device_type: "consumption_meter" },
        },
        {
          device_id: "d2",
          role: "secondary_meter",
          effective_from: "2026-10-01",
          effective_to: "2026-12-01",
          devices: [{ id: "d2", name: "Shop 4 sub-meter", device_type: "consumption_meter" }],
        },
      ],
      error: null,
    });

    const meters = await createSupabaseTenantAppRepository(client).listMetersInForce(TENANT_ID, "2026-11-19");

    expect(calls).toEqual([
      ["from", "tenant_devices"],
      ["select", "device_id, role, effective_from, effective_to, devices!inner(id, name, device_type)"],
      ["eq", "tenant_id", TENANT_ID],
      ["in", "role", ["primary_consumption_meter", "secondary_meter"]],
      ["lte", "effective_from", "2026-11-19"],
      ["or", "effective_to.is.null,effective_to.gt.2026-11-19"],
    ]);
    expect(meters).toEqual([
      {
        deviceId: "d1",
        name: "Shop 4 meter",
        deviceType: "consumption_meter",
        role: "primary_consumption_meter",
        effectiveFrom: "2026-11-01",
        effectiveTo: null,
      },
      {
        deviceId: "d2",
        name: "Shop 4 sub-meter",
        deviceType: "consumption_meter",
        role: "secondary_meter",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-12-01",
      },
    ]);
  });

  it("rejects when the read fails", async () => {
    const { client } = recordingClient({ data: null, error: { message: "permission denied" } });
    await expect(
      createSupabaseTenantAppRepository(client).listMetersInForce(TENANT_ID, "2026-11-19")
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses a day that is not a calendar key before it builds a filter", async () => {
    const { client, calls } = recordingClient({ data: [], error: null });
    await expect(
      createSupabaseTenantAppRepository(client).listMetersInForce(TENANT_ID, "2026-11-19,effective_to.gt.0")
    ).rejects.toThrow(/Invalid date key/);
    expect(calls).toEqual([]);
  });
});

describe("the Supabase tenant app repository's links over a range", () => {
  it("reads the links that cover any day of [from, to), half-open on both sides, oldest first", async () => {
    const { client, calls } = recordingClient({
      data: [
        {
          device_id: "d1",
          role: "primary_consumption_meter",
          effective_from: "2026-10-01",
          effective_to: "2026-11-15",
          devices: { id: "d1", name: "Shop 4 meter", device_type: "consumption_meter" },
        },
        {
          device_id: "d1",
          role: "primary_consumption_meter",
          effective_from: "2026-11-20",
          effective_to: null,
          devices: null,
        },
      ],
      error: null,
    });

    const meters = await createSupabaseTenantAppRepository(client).listMeterAssignments(
      TENANT_ID,
      "2026-11-01",
      "2026-12-01"
    );

    expect(calls).toEqual([
      ["from", "tenant_devices"],
      ["select", "device_id, role, effective_from, effective_to, devices!inner(id, name, device_type)"],
      ["eq", "tenant_id", TENANT_ID],
      ["in", "role", ["primary_consumption_meter", "secondary_meter"]],
      // Starts before the range ends, and ends after it starts (or not at all).
      ["lt", "effective_from", "2026-12-01"],
      ["or", "effective_to.is.null,effective_to.gt.2026-11-01"],
      ["order", "effective_from"],
    ]);
    // A link whose device row is not visible is left out, as in the home.
    expect(meters).toEqual([
      {
        deviceId: "d1",
        name: "Shop 4 meter",
        deviceType: "consumption_meter",
        role: "primary_consumption_meter",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-11-15",
      },
    ]);
  });

  it("rejects when the read fails", async () => {
    const { client } = recordingClient({ data: null, error: { message: "permission denied" } });
    await expect(
      createSupabaseTenantAppRepository(client).listMeterAssignments(TENANT_ID, "2026-11-01", "2026-12-01")
    ).rejects.toThrow(/permission denied/);
  });

  it.each([
    ["2026-11-01,effective_to.gt.0", "2026-12-01"],
    ["2026-11-01", "2026-12-01)"],
  ])("refuses %s .. %s before it builds a filter", async (from, to) => {
    const { client, calls } = recordingClient({ data: [], error: null });
    await expect(
      createSupabaseTenantAppRepository(client).listMeterAssignments(TENANT_ID, from, to)
    ).rejects.toThrow(/Invalid date key/);
    expect(calls).toEqual([]);
  });
});

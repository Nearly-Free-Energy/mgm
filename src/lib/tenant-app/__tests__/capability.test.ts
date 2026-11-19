import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDaysToDateKey, localHourStarts, startOfDayInZone } from "@/lib/timezone/day-key";
import { TenantAppCapability } from "../capability";
import { createSupabaseTenantAppRepository } from "../infrastructure/supabase-repository";
import type {
  PrimaryElsewhereSpan,
  TenantAppRepository,
  TenantAppScope,
  TenantMeter,
  TenantUsageSeriesRequest,
  TenantUsageSeriesResult,
  TenantUsageSource,
} from "../types";
import { inForceOn } from "../usage-calendar";
import { _resetTenantUsageCacheForTests } from "../usage-throttle";

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

/** The home reads no usage; a source that fails the test if asked, and in which no meter is another unit's primary. */
const noUsage: TenantUsageSource = {
  readSeries: async () => {
    throw new Error("the home reads no usage");
  },
  listPrimaryElsewhere: async () => [],
};

beforeEach(() => {
  _resetTenantUsageCacheForTests();
});

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
      // The inner join drops a link whose device is not a consumption meter.
      ["eq", "devices.device_type", "consumption_meter"],
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

  it("leaves out a linked device that is not a consumption meter, even if the read returns one", async () => {
    const linked = (deviceId: string, device_type: string) => ({
      device_id: deviceId,
      role: "secondary_meter",
      effective_from: "2026-11-01",
      effective_to: null,
      devices: { id: deviceId, name: deviceId, device_type },
    });
    const { client } = recordingClient({
      data: [
        linked("grid", "grid_meter"),
        linked("battery", "battery"),
        linked("pv", "pv_meter"),
        linked("inverter", "inverter"),
        linked("meter", "consumption_meter"),
      ],
      error: null,
    });
    const repository = createSupabaseTenantAppRepository(client);

    expect((await repository.listMetersInForce(TENANT_ID, "2026-11-19")).map((m) => m.deviceId)).toEqual(["meter"]);
    expect(
      (await repository.listMeterAssignments(TENANT_ID, "2026-11-01", "2026-12-01")).map((m) => m.deviceId)
    ).toEqual(["meter"]);
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
      ["eq", "devices.device_type", "consumption_meter"],
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

describe("a secondary meter that is another unit's primary (decided on #210, 19 November)", () => {
  /** The unit's own primary meter, from 8 November. */
  const own = meter({ deviceId: "p", name: "Own meter", effectiveFrom: "2026-11-08" });
  /** A secondary meter of the unit since 1 October. */
  const shared = meter({ deviceId: "s", name: "Shared meter", role: "secondary_meter", effectiveFrom: "2026-10-01" });
  /** `shared` is another unit's primary from 1 November on. */
  const sharedElsewhere: PrimaryElsewhereSpan = { deviceId: "s", effectiveFrom: "2026-11-01", effectiveTo: null };

  /** The links half-open as the database reads them, spans from `spans`, and 1 kWh per meter per bucket. */
  function setup(links: TenantMeter[], spans: () => PrimaryElsewhereSpan[] | Error) {
    const repo: TenantAppRepository = {
      listMetersInForce: vi.fn(async (_tenantId: string, date: string) => links.filter((l) => inForceOn(l, date))),
      listMeterAssignments: vi.fn(async (_tenantId: string, from: string, to: string) =>
        links.filter((l) => l.effectiveFrom < to && (l.effectiveTo === null || l.effectiveTo > from))
      ),
    };
    const listPrimaryElsewhere = vi.fn<TenantUsageSource["listPrimaryElsewhere"]>(async () => {
      const answer = spans();
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const readSeries = vi.fn(async (request: TenantUsageSeriesRequest): Promise<TenantUsageSeriesResult> => {
      const buckets: number[] = [];
      for (let date = request.startDate; date <= request.endDate; date = addDaysToDateKey(date, 1)) {
        if (request.resolution === "day") buckets.push(startOfDayInZone(date, request.timezone).getTime());
        else buckets.push(...localHourStarts(date, request.timezone));
      }
      const kwh = Object.fromEntries(request.deviceIds.map((id) => [id, buckets.map(() => 1)]));
      return { ok: true, series: { buckets, kwh, synthetic: false } };
    });
    const capability = new TenantAppCapability(repo, scope(), () => true, () => NOW, {
      readSeries,
      listPrimaryElsewhere,
    });
    return { capability, listPrimaryElsewhere, readSeries };
  }

  it("does not ask for other units' primary links when the unit has no secondary link", async () => {
    const { capability, listPrimaryElsewhere } = setup([own], () => {
      throw new Error("not asked");
    });

    expect((await capability.getUsageMonth({ month: "2026-11" })).ok).toBe(true);
    expect((await capability.getUsageDay({ date: "2026-11-10" })).ok).toBe(true);
    expect((await capability.getHome()).ok).toBe(true);
    expect(listPrimaryElsewhere).not.toHaveBeenCalled();
  });

  it("asks about the unit's secondary meters once, sorted, for the month's half-open range", async () => {
    const other = meter({ deviceId: "r", name: "Other secondary", role: "secondary_meter", effectiveFrom: "2026-10-01" });
    const { capability, listPrimaryElsewhere } = setup([own, shared, other, shared], () => []);

    await capability.getUsageMonth({ month: "2026-11" });

    expect(listPrimaryElsewhere.mock.calls).toEqual([[{ deviceIds: ["r", "s"], fromDate: "2026-11-01", toDate: "2026-12-01" }]]);
  });

  it("shows a day on which the secondary meter is another unit's primary as no meter, and never reads it", async () => {
    const { capability, readSeries } = setup([own, shared], () => [sharedElsewhere]);

    const result = await capability.getUsageMonth({ month: "2026-11" });
    if (!result.ok) throw new Error(result.code);

    for (const day of result.data.days.filter((d) => d.date < "2026-11-08")) {
      expect(day).toEqual({ date: day.date, state: "no-meter", kwh: null });
    }
    for (const day of result.data.days.filter((d) => d.date >= "2026-11-08" && d.date < "2026-11-19")) {
      expect(day).toEqual({ date: day.date, state: "data", kwh: 1 });
    }
    expect(readSeries.mock.calls.map(([request]) => request)).toEqual([
      { deviceIds: ["p"], startDate: "2026-11-08", endDate: "2026-11-19", resolution: "day", timezone: "Africa/Kampala" },
    ]);
  });

  it("reads again, not from the cache, when another unit's primary link changes", async () => {
    let spans: PrimaryElsewhereSpan[] = [];
    const { capability, readSeries } = setup([own, shared], () => spans);

    const before = await capability.getUsageMonth({ month: "2026-11" });
    spans = [sharedElsewhere];
    const after = await capability.getUsageMonth({ month: "2026-11" });

    expect(readSeries.mock.calls.map(([request]) => request.deviceIds)).toEqual([["p", "s"], ["p"]]);
    expect(before.ok && before.data.days.find((d) => d.date === "2026-11-10")).toMatchObject({ kwh: 2 });
    expect(after.ok && after.data.days.find((d) => d.date === "2026-11-10")).toMatchObject({ kwh: 1 });
  });

  it("answers 503, and reads nothing, when other units' primary links cannot be read", async () => {
    const { capability, readSeries } = setup([own, shared], () => new Error("primary-links read failed"));
    const unavailable = {
      ok: false,
      status: 503,
      code: "tenant_app_unavailable",
      message: "Could not read the unit's meters. Retry the request.",
    };

    expect(await capability.getUsageMonth({ month: "2026-11" })).toEqual(unavailable);
    expect(await capability.getUsageDay({ date: "2026-11-10" })).toEqual(unavailable);
    expect(await capability.getHome()).toEqual(unavailable);
    expect(readSeries).not.toHaveBeenCalled();
  });

  it("leaves the secondary meter out of a day on which it is another unit's primary", async () => {
    const { capability, listPrimaryElsewhere, readSeries } = setup([own, shared], () => [sharedElsewhere]);

    const result = await capability.getUsageDay({ date: "2026-11-10" });
    if (!result.ok) throw new Error(result.code);

    expect(listPrimaryElsewhere.mock.calls).toEqual([[{ deviceIds: ["s"], fromDate: "2026-11-10", toDate: "2026-11-11" }]]);
    expect(result.data.meters).toBe(1);
    expect(readSeries.mock.calls.map(([request]) => request.deviceIds)).toEqual([["p"]]);
    expect(result.data.hours.every((h) => h.state === "data" && h.kwh === 1)).toBe(true);
  });

  it("leaves it off the home on a day it is another unit's primary, and lists it on a day it is not", async () => {
    const elsewhere = setup([own, shared], () => [sharedElsewhere]);
    const home = await elsewhere.capability.getHome();

    expect(elsewhere.listPrimaryElsewhere.mock.calls).toEqual([
      [{ deviceIds: ["s"], fromDate: "2026-11-19", toDate: "2026-11-20" }],
    ]);
    expect(home.ok && home.data.meters.map((m) => m.deviceId)).toEqual(["p"]);

    const ended = setup([own, shared], () => [{ deviceId: "s", effectiveFrom: "2026-11-01", effectiveTo: "2026-11-19" }]);
    const listed = await ended.capability.getHome();
    expect(listed.ok && listed.data.meters).toEqual([
      own,
      { ...shared, effectiveFrom: "2026-11-19", effectiveTo: null },
    ]);
  });
});

/**
 * The tenant app's usage source: which client reads what, in which order,
 * and that a microgrid, edge or device id never comes from anywhere but the
 * unit authorizeTenant read and the tenant's own device rows (RFC mgm#197
 * § 5). Nothing the backend says reaches the result or the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MeteringError } from "@/lib/metering/errors";
import type { DeviceEnergySeriesRequest, MeteringProvider } from "@/lib/metering/types";
import type { MeteringProviderFactories } from "@/lib/runtime/services";
import { createTenantUsageSource } from "../infrastructure/usage-source";
import type { TenantUnit, TenantUsageSeriesRequest } from "../types";

const mocks = vi.hoisted(() => ({
  checkGate: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/runtime/gate", () => ({ checkGate: mocks.checkGate }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MICROGRID = "00000000-0000-4000-8000-0000000000c1";
const BACKEND = "https://openems.example.test";

const unit: TenantUnit = {
  tenantId: "00000000-0000-4000-8000-0000000000b1",
  displayName: "Unit 4",
  unitLabel: null,
  microgridId: MICROGRID,
  microgridName: "Kasana East",
  timezone: "Africa/Kampala",
  currency: "UGX",
  organizationId: ORG,
};

/** The view's clock, passed through to the provider unchanged. */
const NOW = Date.parse("2026-11-02T09:00:00Z");

const request = (deviceIds: string[]): TenantUsageSeriesRequest => ({
  deviceIds,
  startDate: "2026-11-01",
  endDate: "2026-11-02",
  resolution: "day",
  timezone: "Africa/Kampala",
  nowMs: NOW,
});

/** Everything the source does, in order, across both clients and the registry. */
let log: unknown[][];

/** A client whose reads record their table and filters and answer `answer(table)`. */
function recordingClient(
  label: "tenant" | "service",
  answer: (table: string) => { data: unknown; error: { code?: string; message: string } | null }
) {
  return {
    from(table: string) {
      const entry: unknown[] = [label, table];
      log.push(entry);
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
          Promise.resolve(answer(table)).then(resolve, reject),
      };
      for (const method of ["select", "in", "eq", "neq", "lt", "or"]) {
        chain[method] = (...args: unknown[]) => {
          entry.push([method, ...args]);
          return chain;
        };
      }
      return chain;
    },
    rpc(fn: string, args: unknown) {
      log.push([label, "rpc", fn, args]);
      return Promise.resolve(answer(`rpc:${fn}`));
    },
  } as unknown as SupabaseClient;
}

type Device = { id: string; edge_id: string | null; openems_component_id: string | null };
type Edge = { id: string; openems_edge_id: string };

type ReadError = { code: string; message: string };

function setup(options: {
  devices?: Device[];
  devicesError?: ReadError;
  edges?: Edge[];
  edgesError?: ReadError;
  /** What fn_tenant_shared_meter_days answers the tenant's own client. */
  sharedDays?: Record<string, unknown>[];
  sharedDaysError?: ReadError;
  provider?: Partial<MeteringProvider> & { getDeviceEnergySeries?: MeteringProvider["getDeviceEnergySeries"] };
  select?: () => Promise<string>;
}) {
  const answer = (rows: unknown, error: ReadError | undefined) => ({ data: error ? null : (rows ?? []), error: error ?? null });
  const tenant = recordingClient("tenant", (table) =>
    table === "devices"
      ? answer(options.devices, options.devicesError)
      : table === "rpc:fn_tenant_shared_meter_days"
        ? answer(options.sharedDays, options.sharedDaysError)
        : { data: null, error: { message: `the tenant client read ${table}` } }
  );
  const service = recordingClient("service", (table) =>
    table === "edges"
      ? answer(options.edges, options.edgesError)
      : { data: null, error: { message: `the service client read ${table}` } }
  );
  mocks.createServiceClient.mockImplementation(() => {
    log.push(["createServiceClient"]);
    return service;
  });
  const provider = {
    getReadings: async () => [],
    ...(options.provider ?? {}),
  } as MeteringProvider;
  const providers = {
    select: vi.fn(async (client: unknown, microgridId: string) => {
      log.push(["select", client === service ? "service" : "other", microgridId]);
      return options.select ? options.select() : "synthetic";
    }),
    create: vi.fn((name: string, client: unknown) => {
      log.push(["create", name, client === service ? "service" : "other"]);
      return provider;
    }),
  };
  const source = createTenantUsageSource({
    supabase: tenant,
    unit,
    providers: providers as unknown as MeteringProviderFactories,
  });
  return { source, tenant, service, providers };
}

/** A provider answering `kwh` per device id for two daily buckets, recording what it was asked. */
function seriesProvider(kwh: Record<string, (number | null)[]>, synthetic = false) {
  const asked: DeviceEnergySeriesRequest[] = [];
  return {
    asked,
    provider: {
      ...(synthetic ? { synthetic: true as const } : {}),
      getDeviceEnergySeries: async (req: DeviceEnergySeriesRequest) => {
        log.push(["getDeviceEnergySeries"]);
        asked.push(req);
        return { buckets: [1, 2], kwh };
      },
    },
  };
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = [];
  mocks.checkGate.mockReset();
  mocks.createServiceClient.mockReset();
  mocks.checkGate.mockImplementation(async () => {
    log.push(["checkGate"]);
    return { ok: true, organizationId: ORG };
  });
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
});

describe("createTenantUsageSource", () => {
  it("asks the gate, reads the devices as the tenant, their edges on the service role, then the unit's microgrid's provider", async () => {
    const { provider, asked } = seriesProvider({ d1: [1.5, null], d2: [0.5, 0.25] });
    const { source, tenant } = setup({
      devices: [
        { id: "d1", edge_id: "e1", openems_component_id: "meter1" },
        { id: "d2", edge_id: "e2", openems_component_id: "meter0" },
      ],
      edges: [
        { id: "e1", openems_edge_id: "SYNTHETIC-EDGE-1" },
        { id: "e2", openems_edge_id: "SYNTHETIC-EDGE-2" },
      ],
      provider,
    });

    const result = await source.readSeries(request(["d1", "d2"]));

    expect(mocks.checkGate).toHaveBeenCalledWith(tenant, {
      plugin: "metering",
      target: { kind: "organization", id: ORG },
      method: "GET",
      access: "write",
    });
    expect(log).toEqual([
      ["checkGate"],
      [
        "tenant",
        "devices",
        ["select", "id, edge_id, openems_component_id"],
        ["in", "id", ["d1", "d2"]],
        // A device of another type has no row, so it reads as no data.
        ["eq", "device_type", "consumption_meter"],
      ],
      ["createServiceClient"],
      ["service", "edges", ["select", "id, openems_edge_id"], ["in", "id", ["e1", "e2"]], ["eq", "microgrid_id", MICROGRID]],
      ["select", "service", MICROGRID],
      ["create", "synthetic", "service"],
      ["getDeviceEnergySeries"],
    ]);
    expect(asked).toEqual([
      {
        microgridId: MICROGRID,
        devices: [
          { id: "d1", edgeOpenemsId: "SYNTHETIC-EDGE-1", componentId: "meter1" },
          { id: "d2", edgeOpenemsId: "SYNTHETIC-EDGE-2", componentId: "meter0" },
        ],
        startDate: "2026-11-01",
        endDate: "2026-11-02",
        resolution: "day",
        timezone: "Africa/Kampala",
        nowMs: NOW,
      },
    ]);
    expect(result).toEqual({
      ok: true,
      series: { buckets: [1, 2], kwh: { d1: [1.5, null], d2: [0.5, 0.25] }, synthetic: false },
    });
  });

  it("never reads microgrids or edges as the tenant, and nothing but edges on the service role", async () => {
    const { provider } = seriesProvider({ d1: [1, 1] });
    const { source } = setup({
      devices: [{ id: "d1", edge_id: "e1", openems_component_id: "meter1" }],
      edges: [{ id: "e1", openems_edge_id: "edge1" }],
      provider,
    });
    await source.readSeries(request(["d1"]));

    const reads = log.filter((entry) => entry[0] === "tenant" || entry[0] === "service").map((e) => `${e[0]}:${e[1]}`);
    expect(reads).toEqual(["tenant:devices", "service:edges"]);
  });

  it("reads nothing while the metering gate says metering is off, and logs nothing", async () => {
    mocks.checkGate.mockResolvedValue({
      ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled.",
    });
    const { source } = setup({ devices: [{ id: "d1", edge_id: "e1", openems_component_id: "meter1" }] });

    expect(await source.readSeries(request(["d1"]))).toEqual({ ok: false, reason: "metering-off" });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("reads nothing when the gate cannot be asked", async () => {
    mocks.checkGate.mockRejectedValue(new Error("root failed to load"));
    const { source } = setup({});

    expect(await source.readSeries(request(["d1"]))).toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("reads nothing when the gate cannot read the plugin state (503): unavailable, not off, logged by code and status", async () => {
    mocks.checkGate.mockResolvedValue({
      ok: false, status: 503, code: "metering_gate_unavailable", message: "Could not verify. Retry the request.",
    });
    const { source } = setup({ devices: [{ id: "d1", edge_id: "e1", openems_component_id: "meter1" }] });

    expect(await source.readSeries(request(["d1"]))).toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("[tenant-app] usage read failed", {
      code: "metering_gate_unavailable",
      status: 503,
    });
  });

  it("reads nothing, not even the gate, for no devices", async () => {
    const { source } = setup({});
    expect(await source.readSeries(request([]))).toEqual({
      ok: true,
      series: { buckets: [], kwh: {}, synthetic: false },
    });
    expect(mocks.checkGate).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("leaves unread, and all null, a device the tenant cannot read, one without a component id and one on another microgrid's edge", async () => {
    const { provider, asked } = seriesProvider({ d1: [2, 3] });
    const { source } = setup({
      // "hidden" is not returned to the tenant at all.
      devices: [
        { id: "d1", edge_id: "e1", openems_component_id: "meter1" },
        { id: "bare", edge_id: "e1", openems_component_id: null },
        { id: "elsewhere", edge_id: "e-other", openems_component_id: "meter0" },
      ],
      // The service read is filtered to the unit's microgrid: e-other is not returned.
      edges: [{ id: "e1", openems_edge_id: "edge1" }],
      provider,
    });

    const result = await source.readSeries(request(["bare", "d1", "elsewhere", "hidden"]));

    expect(asked[0].devices).toEqual([{ id: "d1", edgeOpenemsId: "edge1", componentId: "meter1" }]);
    expect(result).toEqual({
      ok: true,
      series: {
        buckets: [1, 2],
        kwh: { bare: [null, null], d1: [2, 3], elsewhere: [null, null], hidden: [null, null] },
        synthetic: false,
      },
    });
  });

  it("creates no service client when no device row is readable", async () => {
    const { source } = setup({ devices: [{ id: "bare", edge_id: "e1", openems_component_id: null }] });

    expect(await source.readSeries(request(["bare", "hidden"]))).toEqual({
      ok: true,
      series: { buckets: [], kwh: { bare: [], hidden: [] }, synthetic: false },
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("asks no provider when every device's edge is on another microgrid", async () => {
    const { provider, asked } = seriesProvider({});
    const { source, providers } = setup({
      devices: [{ id: "elsewhere", edge_id: "e-other", openems_component_id: "meter0" }],
      edges: [],
      provider,
    });

    expect(await source.readSeries(request(["elsewhere"]))).toEqual({
      ok: true,
      series: { buckets: [], kwh: { elsewhere: [] }, synthetic: false },
    });
    expect(providers.select).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it("answers unsupported for a provider without energy series", async () => {
    const { source } = setup({
      devices: [{ id: "d1", edge_id: "e1", openems_component_id: "meter1" }],
      edges: [{ id: "e1", openems_edge_id: "edge1" }],
    });
    expect(await source.readSeries(request(["d1"]))).toEqual({ ok: false, reason: "unsupported" });
  });

  it("marks the series synthetic when the provider is", async () => {
    const { provider } = seriesProvider({ d1: [1, 2] }, true);
    const { source } = setup({
      devices: [{ id: "d1", edge_id: "e1", openems_component_id: "meter1" }],
      edges: [{ id: "e1", openems_edge_id: "SYNTHETIC-EDGE-1" }],
      provider,
    });
    expect(await source.readSeries(request(["d1"]))).toMatchObject({ ok: true, series: { synthetic: true } });
  });

  it("hands out its own arrays, not the provider's", async () => {
    const values = [1, 2];
    const buckets = [10, 20];
    const { source } = setup({
      devices: [{ id: "d1", edge_id: "e1", openems_component_id: "meter1" }],
      edges: [{ id: "e1", openems_edge_id: "edge1" }],
      provider: { getDeviceEnergySeries: async () => ({ buckets, kwh: { d1: values } }) },
    });
    const result = await source.readSeries(request(["d1"]));
    if (!result.ok) throw new Error("expected a series");
    expect(result.series.kwh.d1).not.toBe(values);
    expect(result.series.buckets).not.toBe(buckets);
  });

  describe("failures", () => {
    const readable = {
      devices: [{ id: "d1", edge_id: "e1", openems_component_id: "meter1" }],
      edges: [{ id: "e1", openems_edge_id: "edge1" }],
    };

    /** Every console.error argument, as text. */
    const logged = () => JSON.stringify(errors.mock.calls);

    it.each([
      [
        "the device read fails",
        { devices: undefined, devicesError: { code: "57014", message: `statement timeout near ${BACKEND}` } },
        { step: "devices", code: "57014" },
      ],
      [
        "the edge read fails",
        { edgesError: { code: "PGRST301", message: `JWT rejected by ${BACKEND}` } },
        { step: "edges", code: "PGRST301" },
      ],
      [
        "the provider cannot be selected (mixed edges)",
        {
          select: async () => {
            throw new MeteringError(`Mixed edges at ${BACKEND}`, "METERING_CONFIGURATION", 409);
          },
        },
        { code: "METERING_CONFIGURATION", status: 409 },
      ],
      [
        "the provider fails",
        {
          provider: {
            getDeviceEnergySeries: async () => {
              throw new MeteringError(`OpenEMS at ${BACKEND} said no`, "METERING_UNAVAILABLE", 502);
            },
          },
        },
        { code: "METERING_UNAVAILABLE", status: 502 },
      ],
      [
        "the provider throws something else",
        {
          provider: {
            getDeviceEnergySeries: async () => {
              throw new TypeError(`fetch ${BACKEND} failed`);
            },
          },
        },
        { code: "TypeError" },
      ],
    ])("answers unavailable when %s, and logs a code and status only", async (_label, options, detail) => {
      const { source } = setup({ ...readable, ...options });

      expect(await source.readSeries(request(["d1"]))).toEqual({ ok: false, reason: "unavailable" });
      expect(errors).toHaveBeenCalledWith("[tenant-app] usage read failed", detail);
      expect(logged()).not.toContain(BACKEND);
    });

    it("answers unavailable when the service client cannot be built", async () => {
      const { source } = setup(readable);
      mocks.createServiceClient.mockImplementation(() => {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
      });

      expect(await source.readSeries(request(["d1"]))).toEqual({ ok: false, reason: "unavailable" });
      expect(errors).toHaveBeenCalledWith("[tenant-app] usage read failed", { code: "Error" });
    });
  });
});

describe("the days the unit's primary meters are also the primary of another unit on its microgrid (D12)", () => {
  const range = { fromDate: "2026-11-01", toDate: "2026-12-01" };
  const row = (device_id: unknown, effective_from: unknown, effective_to: unknown) => ({
    device_id,
    effective_from,
    effective_to,
  });

  it("asks fn_tenant_shared_meter_days on the tenant's own client, for the unit authorizeTenant read and the range, and never builds a service client", async () => {
    const { source } = setup({
      sharedDays: [row("p1", "2026-11-03", "2026-11-09"), row("p2", "2026-11-05", "2026-11-20")],
    });

    const spans = await source.listPrimaryElsewhere(range);

    expect(log).toEqual([
      [
        "tenant",
        "rpc",
        "fn_tenant_shared_meter_days",
        { _tenant_id: unit.tenantId, _from_date: "2026-11-01", _to_date: "2026-12-01" },
      ],
    ]);
    expect(spans).toEqual([
      { deviceId: "p1", effectiveFrom: "2026-11-03", effectiveTo: "2026-11-09" },
      { deviceId: "p2", effectiveFrom: "2026-11-05", effectiveTo: "2026-11-20" },
    ]);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.checkGate).not.toHaveBeenCalled();
  });

  it("keeps only the device id and the dates", async () => {
    const { source } = setup({
      sharedDays: [{ ...row("p1", "2026-11-01", "2026-12-01"), tenant_id: "another-unit" }],
    });

    const spans = await source.listPrimaryElsewhere(range);

    expect(spans).toEqual([{ deviceId: "p1", effectiveFrom: "2026-11-01", effectiveTo: "2026-12-01" }]);
    expect(Object.keys(spans[0]).sort()).toEqual(["deviceId", "effectiveFrom", "effectiveTo"]);
    expect(JSON.stringify(spans)).not.toContain("another-unit");
  });

  it.each([
    ["an open end", row("p1", "2026-11-01", null)],
    ["a date that does not exist", row("p1", "2026-02-30", "2026-03-01")],
    ["a device id that is not a string", row(7, "2026-11-01", "2026-11-02")],
  ])("rejects a row with %s, as a failed read", async (_label, bad) => {
    const { source } = setup({ sharedDays: [row("p2", "2026-11-01", "2026-11-02"), bad] });

    await expect(source.listPrimaryElsewhere(range)).rejects.toThrow();
    expect(errors).toHaveBeenCalledWith("[tenant-app] usage read failed", { step: "shared-days", code: "malformed" });
  });

  it.each([
    ["2026-11-01,effective_to.gt.0", "2026-12-01"],
    ["2026-11-01", "2026-12-01)"],
    ["2026-02-30", "2026-03-01"],
    ["2026-12-01", "2026-11-01"],
  ])("rejects %s .. %s before any read", async (fromDate, toDate) => {
    const { source } = setup({ sharedDays: [] });

    await expect(source.listPrimaryElsewhere({ fromDate, toDate })).rejects.toThrow();
    expect(log).toEqual([]);
    expect(errors).toHaveBeenCalledWith("[tenant-app] usage read failed", { step: "shared-days", code: "invalid_date" });
  });

  it("answers an empty range with no days, without a read", async () => {
    const { source } = setup({ sharedDays: [row("p2", "2026-11-01", "2026-11-02")] });

    await expect(source.listPrimaryElsewhere({ fromDate: "2026-11-01", toDate: "2026-11-01" })).resolves.toEqual([]);
    expect(log).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("rejects when the function fails, logging a step and code only", async () => {
    const { source } = setup({ sharedDaysError: { code: "42501", message: "You do not have access to this unit." } });

    await expect(source.listPrimaryElsewhere(range)).rejects.toThrow();
    expect(errors).toHaveBeenCalledWith("[tenant-app] usage read failed", { step: "shared-days", code: "42501" });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/access to this unit/);
  });
});

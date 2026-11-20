/**
 * The usage views' loaders (RFC mgm#197 § 5): they compose the tenant app
 * for the request's unit and clock, read only their own parameter, dispose
 * the composition in `finally`, answer a composer's refusal with fixed copy,
 * and show the read limit as the tenant meets it: six months read in a
 * minute, the seventh "No data" with the limit's copy, a reload served from
 * the cache, reads again once the window has passed, and kept figures with
 * their read time when over the limit.
 *
 * The capability and the cache are real; composeTenantApp is replaced by one
 * that builds the capability on a fake repository and a counting usage
 * source backed by the synthetic generator.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createFmt } from "@/lib/gui/fmt";
import type { TenantRequest } from "@/lib/gui/surface";
import { generateDeviceEnergySeries } from "@/lib/metering/fixture/meter-energy";
import type { UserRoleRecord } from "@/lib/types/domain";
import { TenantAppCapability } from "../capability";
import type {
  TenantAppCapabilityContract,
  TenantAppRepository,
  TenantAppResult,
  TenantAppScope,
  TenantMeter,
  TenantUsageSeriesRequest,
  TenantUsageSource,
} from "../types";
import { _resetTenantUsageCacheForTests } from "../usage-throttle";

const composeTenantApp = vi.fn();
vi.mock("../compose", () => ({ composeTenantApp: (...args: unknown[]) => composeTenantApp(...args) }));

import { loadTenantUsageDay, loadTenantUsageMonth, TENANT_USAGE_REFUSALS, tenantUsageRefusal } from "../surface/usage";
import { TENANT_USAGE_PROBLEMS } from "../surface/usage-model";

const UNIT = "00000000-0000-4000-8000-0000000000b1";
const OTHER_UNIT = "00000000-0000-4000-8000-0000000000b9";
const ORG = "00000000-0000-4000-8000-0000000000a1";
const MICROGRID = "00000000-0000-4000-8000-0000000000c1";
const METER = "00000000-0000-4000-8000-0000000000d1";
const EDGE = `SYNTHETIC-EDGE-${MICROGRID}`;
const COMPONENT = "meter7";
const BACKEND = "https://openems.example.test";
const KAMPALA = "Africa/Kampala";
const T0 = Date.parse("2026-11-18T09:00:00Z");
const fmt = createFmt({ locale: "en-GB" });

const tenantRow = (scope_id: string) => ({ user_id: "u", role: "tenant", scope_type: "tenant", scope_id }) as UserRoleRecord;

function request(search: string, nowMs: number, roles = [tenantRow(UNIT)]): TenantRequest {
  return {
    supabase: { caller: "tenant" } as unknown as SupabaseClient,
    user: { id: "u" } as User,
    roles,
    organizationId: null,
    tenantId: UNIT,
    params: {},
    search: new URLSearchParams(search),
    locale: "en-GB",
    now: new Date(nowMs),
    fmt,
  };
}

const LINKS: TenantMeter[] = [
  {
    deviceId: METER,
    name: "House meter",
    deviceType: "consumption_meter",
    role: "primary_consumption_meter",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  },
];
const repo: TenantAppRepository = {
  listMetersInForce: async () => LINKS,
  listMeterAssignments: async () => LINKS,
};
const scope: TenantAppScope = {
  tenantId: UNIT,
  organizationId: ORG,
  userId: "u",
  unit: {
    tenantId: UNIT,
    displayName: "Nakato Grace",
    unitLabel: "Unit 4",
    microgridId: MICROGRID,
    microgridName: "Synthetic site",
    timezone: KAMPALA,
    currency: "UGX",
    organizationId: ORG,
  },
};

/** The synthetic generator behind the source port, as the usage source would reach it; every read is recorded. */
const reads: TenantUsageSeriesRequest[] = [];
const source: TenantUsageSource = {
  async readSeries(r) {
    reads.push(r);
    // The vendor's ids and address live here and nowhere a model can reach.
    void BACKEND;
    const series = generateDeviceEnergySeries({
      microgridId: MICROGRID,
      devices: r.deviceIds.map((id) => ({ id, edgeOpenemsId: EDGE, componentId: COMPONENT })),
      startDate: r.startDate,
      endDate: r.endDate,
      resolution: r.resolution,
      timezone: r.timezone,
    });
    return { ok: true, series: { ...series, synthetic: true } };
  },
};

const dispose = vi.fn(async () => {});

beforeEach(() => {
  _resetTenantUsageCacheForTests();
  reads.length = 0;
  dispose.mockClear();
  composeTenantApp.mockReset();
  // A real capability on the request's clock, as composeTenantApp builds it.
  composeTenantApp.mockImplementation(async (options: { now: () => number }) => ({
    ok: true,
    data: { scope, tenantApp: new TenantAppCapability(repo, scope, () => true, options.now, source), dispose },
  }));
});

type Ext = {
  problem: { kind: string } | null;
  stale: boolean;
  readAt: { at: string; label: string | null } | null;
  total: { kwh: number | null };
};
const ext = (loaded: Awaited<ReturnType<typeof loadTenantUsageMonth>>) => {
  if (!loaded.ok) throw new Error(`refused: ${loaded.status}`);
  return { model: loaded.model, data: loaded.model.ext!.data as unknown as Ext };
};

describe("the usage read limit, as a tenant meets it", () => {
  const MONTHS = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"];

  it("reads six months in a minute, answers the seventh with no data and the limit's copy, and serves a reload from the cache", async () => {
    for (const [i, month] of MONTHS.entries()) {
      const { data } = ext(await loadTenantUsageMonth(request(`month=${month}`, T0 + i * 5_000)));
      expect(data.problem, month).toBeNull();
    }
    expect(reads.map((r) => r.startDate.slice(0, 7))).toEqual(MONTHS);

    const limited = ext(await loadTenantUsageMonth(request("month=2026-04", T0 + 40_000)));
    expect(reads).toHaveLength(6);
    expect(limited.data.problem).toEqual({ kind: "limited", ...TENANT_USAGE_PROBLEMS.limited });
    expect(limited.model.subtitle).toBe(`Unit 4 · ${TENANT_USAGE_PROBLEMS.limited.message}`);
    expect(limited.model.body.rows).toHaveLength(30);
    expect(limited.model.body.rows.every((r) => r.cells.usage.text === "No data")).toBe(true);
    expect(limited.model.body.totals?.usage).toEqual({ t: "text", text: "No data" });

    // October was read at T0; 30 s later it comes from the cache, limit or not.
    const cached = ext(await loadTenantUsageMonth(request("month=2026-10", T0 + 30_000)));
    expect(reads).toHaveLength(6);
    expect(cached.data).toMatchObject({ problem: null, stale: false, readAt: { at: new Date(T0).toISOString(), label: null } });
    expect(cached.model.body.rows.some((r) => r.cells.usage.t === "energy")).toBe(true);
  });

  it("reads again once the window has passed, and over the limit serves kept figures with their read time", async () => {
    for (const [i, month] of MONTHS.entries()) await loadTenantUsageMonth(request(`month=${month}`, T0 + i * 1_000));
    // The window slides: 61 s after the first read, that read has left it.
    expect(ext(await loadTenantUsageMonth(request("month=2026-04", T0 + 61_000))).data.problem).toBeNull();
    expect(reads).toHaveLength(7);

    // Once the other five have left it too, five more uncached reads fill it again.
    for (const [i, month] of ["2026-03", "2026-02", "2026-01", "2025-12", "2025-11"].entries()) {
      expect(ext(await loadTenantUsageMonth(request(`month=${month}`, T0 + 67_000 + i * 1_000))).data.problem).toBeNull();
    }
    expect(reads).toHaveLength(12);

    // October's read, from T0, is past its minute but kept: shown, marked stale, with its time in Kampala.
    const kept = ext(await loadTenantUsageMonth(request("month=2026-10", T0 + 80_000)));
    expect(reads).toHaveLength(12);
    expect(kept.data).toMatchObject({
      problem: null,
      stale: true,
      readAt: { at: new Date(T0).toISOString(), label: "As read at 12:00." },
    });
    expect(kept.model.subtitle).toBe("Unit 4 · As read at 12:00.");
    expect(kept.model.body.rows.some((r) => r.cells.usage.t === "energy")).toBe(true);
  });

  it("counts the day view's reads against the same limit", async () => {
    for (const [i, month] of MONTHS.entries()) await loadTenantUsageMonth(request(`month=${month}`, T0 + i * 1_000));
    const loaded = await loadTenantUsageDay(request("date=2026-11-10", T0 + 10_000));
    if (!loaded.ok) throw new Error("refused");
    expect(reads).toHaveLength(6);
    expect((loaded.model.ext!.data as unknown as Ext).problem?.kind).toBe("limited");
  });
});

describe("loadTenantUsageMonth and loadTenantUsageDay", () => {
  it("compose for the request's unit on the caller's client and clock, read the one parameter, and dispose", async () => {
    const req = request("month=2026-10", T0);
    const loaded = await loadTenantUsageMonth(req);
    expect(loaded).toMatchObject({ ok: true, model: { title: "October 2026" } });
    const options = composeTenantApp.mock.calls[0][0] as { supabase: unknown; tenantId: string; now: () => number };
    expect(options.supabase).toBe(req.supabase);
    expect(options.tenantId).toBe(UNIT);
    expect(options.now()).toBe(T0);
    expect(dispose).toHaveBeenCalledOnce();

    const day = await loadTenantUsageDay(request("date=2026-11-10", T0));
    expect(day).toMatchObject({ ok: true, model: { title: expect.stringMatching(/10 November 2026$/) } });
    expect(reads.at(-1)).toMatchObject({ startDate: "2026-11-10", endDate: "2026-11-10", resolution: "hour", timezone: KAMPALA });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("passes the capability only its own parameter, once, and nothing for a repeated one", async () => {
    const getUsageMonth = vi.fn<TenantAppCapabilityContract["getUsageMonth"]>().mockResolvedValue({ ok: false, status: 503, code: "x", message: "x" });
    const getUsageDay = vi.fn<TenantAppCapabilityContract["getUsageDay"]>().mockResolvedValue({ ok: false, status: 503, code: "x", message: "x" });
    composeTenantApp.mockResolvedValue({ ok: true, data: { scope, tenantApp: { getUsageMonth, getUsageDay }, dispose } });

    await loadTenantUsageMonth(request(`month=2026-10&date=2026-10-05&unit=${UNIT}`, T0));
    await loadTenantUsageMonth(request("month=2026-10&month=2026-09", T0));
    await loadTenantUsageMonth(request("", T0));
    expect(getUsageMonth.mock.calls).toEqual([[{ month: "2026-10" }], [{ month: undefined }], [{ month: undefined }]]);

    await loadTenantUsageDay(request("date=2026-10-05&month=2026-10", T0));
    await loadTenantUsageDay(request("date=2026-10-05&date=2026-10-06", T0));
    expect(getUsageDay.mock.calls).toEqual([[{ date: "2026-10-05" }], [{ date: undefined }]]);
  });

  it("shows the current month for a repeated month, through the real capability", async () => {
    const loaded = await loadTenantUsageMonth(request("month=2026-10&month=2026-09", T0));
    expect(loaded).toMatchObject({ ok: true, model: { title: "November 2026" } });
  });

  it("names the unit in the ext's hrefs only for a person with several units", async () => {
    const one = await loadTenantUsageMonth(request("month=2026-10", T0));
    const several = await loadTenantUsageMonth(request("month=2026-10", T0 + 1_000, [tenantRow(UNIT), tenantRow(OTHER_UNIT)]));
    if (!one.ok || !several.ok) throw new Error("refused");
    expect((one.model.ext!.data as { href: string }).href).toBe("/my/usage?month=2026-10");
    expect((several.model.ext!.data as { href: string }).href).toBe(`/my/usage?month=2026-10&unit=${UNIT}`);
  });

  it("disposes when the read fails or throws", async () => {
    const getUsageMonth = vi.fn<TenantAppCapabilityContract["getUsageMonth"]>();
    composeTenantApp.mockResolvedValue({ ok: true, data: { scope, tenantApp: { getUsageMonth }, dispose } });
    getUsageMonth.mockResolvedValue({ ok: false, status: 503, code: "tenant_app_unavailable", message: "the capability's own words" });
    expect(await loadTenantUsageMonth(request("", T0))).toEqual(TENANT_USAGE_REFUSALS.unavailable);
    getUsageMonth.mockRejectedValue(new Error("boom"));
    await expect(loadTenantUsageMonth(request("", T0))).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "tenant_app_unauthenticated", TENANT_USAGE_REFUSALS.signedOut],
    [400, "tenant_app_invalid_tenant", TENANT_USAGE_REFUSALS.notFound],
    [403, "tenant_app_forbidden", TENANT_USAGE_REFUSALS.notFound],
    [409, "tenant_app_disabled", TENANT_USAGE_REFUSALS.disabled],
    [500, "tenant_app_composition_failed", TENANT_USAGE_REFUSALS.failed],
    [503, "tenant_app_gate_unavailable", TENANT_USAGE_REFUSALS.unavailable],
  ])("answer a composer refusal %i (%s) with fixed copy, reading nothing", async (status, code, refusal) => {
    const failure: TenantAppResult<never> = { ok: false, status: status as 400, code, message: "the capability's own words" };
    composeTenantApp.mockResolvedValue(failure);
    expect(await loadTenantUsageMonth(request("", T0))).toEqual(refusal);
    expect(await loadTenantUsageDay(request("", T0))).toEqual(refusal);
    expect(tenantUsageRefusal(failure)).toEqual(refusal);
    expect(reads).toEqual([]);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("put none of the meter's, edge's or microgrid's ids, nor the backend's address, in a model", async () => {
    const outputs = [
      await loadTenantUsageMonth(request("month=2026-10", T0)),
      await loadTenantUsageMonth(request("", T0 + 1_000)),
      await loadTenantUsageDay(request("date=2026-11-10", T0 + 2_000)),
      await loadTenantUsageDay(request("", T0 + 3_000)),
    ];
    expect(outputs.every((o) => o.ok)).toBe(true);
    const text = JSON.stringify(outputs);
    for (const hidden of [METER, MICROGRID, EDGE, COMPONENT, ORG, BACKEND]) expect(text).not.toContain(hidden);
  });
});

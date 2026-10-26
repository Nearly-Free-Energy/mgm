/**
 * Real composers on the shared runtime, several requests at once
 * (docs/cordis-runtime.md § "Two lifetimes"). `runtime.test.ts` covers the
 * same properties with a probe plugin; this pins them for the capability
 * plugins that actually ship.
 *
 * Each request composes with its own client, for a user who manages one
 * organization: `a` and `a2` are two managers of A, `b` manages B. The fakes
 * below answer the way RLS would for that client, and record which client
 * reached them: the repository reads, the plugin-state reads, the bill
 * engine and the metering source. A capability that picked up another
 * request's client would read through that caller's RLS, so the checks are
 * on the client behind every read a capability makes here, not only on the
 * organization id its scope reports.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeBilling } from "@/lib/billing/compose";
import type { RunGenerationParams } from "@/lib/billing/generate";
import { composeMetering } from "@/lib/metering/compose";
import type { MeteringReadRequest } from "@/lib/metering/types";
import { getMgmRuntime, resetMgmRuntimeForTests } from "../root";
import { openOrganizationScope } from "../scope";

const ORG_A = "550e8400-e29b-41d4-a716-44665544000a";
const ORG_B = "550e8400-e29b-41d4-a716-44665544000b";

/** Each organization's microgrid, billing period and meter. */
const SITES: Record<string, { microgridId: string; periodId: string; deviceId: string }> = {
  [ORG_A]: {
    microgridId: "550e8400-e29b-41d4-a716-4466554400a1",
    periodId: "550e8400-e29b-41d4-a716-4466554400a2",
    deviceId: "550e8400-e29b-41d4-a716-4466554400a3",
  },
  [ORG_B]: {
    microgridId: "550e8400-e29b-41d4-a716-4466554400b1",
    periodId: "550e8400-e29b-41d4-a716-4466554400b2",
    deviceId: "550e8400-e29b-41d4-a716-4466554400b3",
  },
};

/** The user behind each client, and the one organization that user manages. */
const CLIENTS: Record<string, { userId: string; orgId: string }> = {
  a: { userId: "user-a", orgId: ORG_A },
  a2: { userId: "user-a2", orgId: ORG_A },
  b: { userId: "user-b", orgId: ORG_B },
};

const mocks = vi.hoisted(() => ({
  /** `${orgId}:${plugin}` pairs that read as disabled; everything else is enabled. */
  disabled: new Set<string>(),
  /** The client each repository or plugin-state read went through, per row it asked for. */
  reads: [] as { client: string; id: string }[],
  /** The client the OpenEMS source was bound to, per microgrid it read. */
  providerReads: [] as { client: string; microgridId: string }[],
  /** The client billing generation ran on, per period. */
  generationRuns: [] as { client: string; periodId: string }[],
}));

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async (supabase: unknown) => {
    const { userId, orgId } = CLIENTS[label(supabase)];
    return [{ user_id: userId, role: "org_manager", scope_type: "org", scope_id: orgId }];
  },
}));

// Keyed by organization. The composers read `isPluginEnabledForOrg`, and the
// capabilities' re-checks read it or a per-plugin helper through their
// repositories, so all three answer from `mocks.disabled` and log alike. If a
// repository reads plugin state through any other function, mock that too:
// unmocked, it reaches a fake client that cannot answer.
// Each read is logged with the client it went through; inside a capability
// that is the client the capability's repository holds.
vi.mock("@/lib/plugins/state", async (importOriginal) => {
  const enabled = async (supabase: unknown, orgId: string, plugin: string) => {
    mocks.reads.push({ client: label(supabase), id: orgId });
    return !mocks.disabled.has(`${orgId}:${plugin}`);
  };
  return {
    ...(await importOriginal<typeof import("@/lib/plugins/state")>()),
    isPluginEnabledForOrg: enabled,
    isBillingEnabled: (supabase: unknown, orgId: string) => enabled(supabase, orgId, "billing"),
    isMeteringEnabled: (supabase: unknown, orgId: string) => enabled(supabase, orgId, "metering"),
  };
});

// Pass-through, so a refused composition can be shown to open no scope.
vi.mock("@/lib/runtime/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime/scope")>();
  return { ...actual, openOrganizationScope: vi.fn(actual.openOrganizationScope) };
});

// The repositories are real apart from the reads that stand in for the
// database: which organization owns a period or microgrid, and its meters.
// Each answers through the client the repository was built on.
vi.mock("@/lib/billing/infrastructure/supabase-repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/billing/infrastructure/supabase-repository")>();
  return {
    ...actual,
    createSupabaseBillingRepository: (supabase: never) => ({
      ...actual.createSupabaseBillingRepository(supabase),
      getPeriodOrganization: async (periodId: string) => {
        const site = visibleSite(supabase, "periodId", periodId);
        return site && { periodId, microgridId: site.microgridId, orgId: site.orgId };
      },
    }),
  };
});

vi.mock("@/lib/metering/infrastructure/supabase-repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/metering/infrastructure/supabase-repository")>();
  return {
    ...actual,
    createSupabaseMeteringRepository: (supabase: never) => ({
      ...actual.createSupabaseMeteringRepository(supabase),
      getMicrogridOrganization: async (microgridId: string) => {
        const site = visibleSite(supabase, "microgridId", microgridId);
        return site && { microgridId, communityId: "community-1", orgId: site.orgId };
      },
      getManagedDevices: async (microgridId: string) => {
        const site = visibleSite(supabase, "microgridId", microgridId);
        if (!site) return [];
        return [
          {
            id: site.deviceId,
            edgeOpenemsId: "edge0",
            componentId: "meter0",
            name: "Meter",
            edgeId: "edge-1",
            deviceType: "meter",
          },
        ];
      },
    }),
  };
});

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: (supabase: never) => ({
    async getReadings(request: MeteringReadRequest) {
      mocks.providerReads.push({ client: label(supabase), microgridId: request.microgridId });
      return request.devices.map((device) => ({
        deviceId: device.id,
        usageKwh: 1,
        startDate: request.startDate,
        endDate: request.endDate,
      }));
    },
  }),
}));

// The bill engine is not under test. The fake records the client generation
// runs on and reads once through the metering source it was handed, so the
// client that source is bound to lands in `providerReads` too.
//
// The real engine awaits its period, rate-schedule and household reads before
// it asks that source for readings (billing/generate.ts), so concurrent runs
// interleave between the source being bound and being used. The fake waits
// as well, longest for A, so the run that started first reads last. If the
// engine stops awaiting before it reads, the wait only makes this stricter.
vi.mock("@/lib/billing/generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/generate")>()),
  runGenerationFor: async (params: RunGenerationParams) => {
    mocks.generationRuns.push({ client: label(params.supabase), periodId: params.periodId });
    const site = siteWhere("periodId", params.periodId);
    await new Promise((resolve) => setTimeout(resolve, site?.orgId === ORG_A ? 10 : 0));
    await params.meteringProvider?.getReadings({
      microgridId: site?.microgridId ?? "",
      devices: [],
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      timezone: "UTC",
    });
    return { results: [] };
  },
}));

function client(name: string) {
  return {
    label: name,
    auth: { getUser: async () => ({ data: { user: { id: CLIENTS[name].userId } } }) },
  } as never;
}

function label(supabase: unknown): string {
  return (supabase as { label: string }).label;
}

function siteWhere(key: "microgridId" | "periodId", value: string) {
  for (const [orgId, site] of Object.entries(SITES)) {
    if (site[key] === value) return { orgId, ...site };
  }
  return null;
}

/**
 * A repository read under RLS: records the client that asked, and returns the
 * row's site only when that client's user manages the owning organization —
 * an org manager's view as the `user_can_access_*` policies give it (00002).
 * If an org manager's visibility stops being per organization, revisit.
 */
function visibleSite(supabase: unknown, key: "microgridId" | "periodId", id: string) {
  mocks.reads.push({ client: label(supabase), id });
  const site = siteWhere(key, id);
  return site && site.orgId === CLIENTS[label(supabase)].orgId ? site : null;
}

/** Empties a log, ordered by client so concurrent calls compare stably. */
function drain<T extends { client: string }>(log: T[]): T[] {
  return log.splice(0).sort((x, y) => x.client.localeCompare(y.client));
}

/** Empties the read log into the clients that read each organization's rows. */
function readersByOrg(): Record<string, string[]> {
  const readers: Record<string, Set<string>> = {};
  for (const { client: name, id } of mocks.reads.splice(0)) {
    const orgId =
      id in SITES ? id : (siteWhere("periodId", id) ?? siteWhere("microgridId", id))?.orgId ?? id;
    (readers[orgId] ??= new Set()).add(name);
  }
  return Object.fromEntries(
    Object.entries(readers).map(([orgId, names]) => [orgId, [...names].sort()])
  );
}

function consumptionQuery(orgId: string) {
  return {
    microgrid_id: SITES[orgId].microgridId,
    start_date: "2026-09-01",
    end_date: "2026-09-30",
    timezone: "UTC",
  };
}

afterEach(async () => {
  mocks.disabled.clear();
  mocks.reads.length = 0;
  mocks.providerReads.length = 0;
  mocks.generationRuns.length = 0;
  vi.clearAllMocks();
  await resetMgmRuntimeForTests();
});

describe("composers on the shared runtime", () => {
  it("keeps concurrent requests apart and leaves the root as it found it", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;

    // `a2` is a second manager of A, composing while `a` is live.
    const [billingA, billingB, billingA2, meteringA, meteringB, meteringA2] = await Promise.all([
      composeBilling({ supabase: client("a"), organizationId: ORG_A }),
      composeBilling({ supabase: client("b"), organizationId: ORG_B }),
      composeBilling({ supabase: client("a2"), organizationId: ORG_A }),
      composeMetering({ supabase: client("a"), organizationId: ORG_A }),
      composeMetering({ supabase: client("b"), organizationId: ORG_B }),
      composeMetering({ supabase: client("a2"), organizationId: ORG_A }),
    ]);
    for (const composed of [billingA, billingB, billingA2, meteringA, meteringB, meteringA2]) {
      expect(composed.ok, JSON.stringify(composed)).toBe(true);
    }
    if (
      !billingA.ok ||
      !billingB.ok ||
      !billingA2.ok ||
      !meteringA.ok ||
      !meteringB.ok ||
      !meteringA2.ok
    ) {
      return;
    }

    expect(billingA.data.scope).toMatchObject({ organizationId: ORG_A, userId: "user-a" });
    expect(billingB.data.scope).toMatchObject({ organizationId: ORG_B, userId: "user-b" });
    expect(billingA2.data.scope).toMatchObject({ organizationId: ORG_A, userId: "user-a2" });
    expect(meteringA.data.scope).toMatchObject({ organizationId: ORG_A, userId: "user-a" });
    expect(meteringB.data.scope).toMatchObject({ organizationId: ORG_B, userId: "user-b" });
    expect(meteringA2.data.scope).toMatchObject({ organizationId: ORG_A, userId: "user-a2" });
    // Every request has its own capability, two requests for A included.
    expect(
      new Set([billingA.data.billing, billingB.data.billing, billingA2.data.billing]).size
    ).toBe(3);
    expect(
      new Set([meteringA.data.metering, meteringB.data.metering, meteringA2.data.metering]).size
    ).toBe(3);
    expect(runtime.root.registry.size).toBeGreaterThan(before);
    // Each composer read plugin state through its own caller's client.
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a", "a2"], [ORG_B]: ["b"] });

    // Billing resolves the period through its own organization's client, and
    // generates on that client through a metering source bound to it.
    const previews = await Promise.all([
      billingA.data.billing.previewBills({ billingPeriodId: SITES[ORG_A].periodId }),
      billingB.data.billing.previewBills({ billingPeriodId: SITES[ORG_B].periodId }),
    ]);
    for (const preview of previews) expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(drain(mocks.generationRuns)).toEqual([
      { client: "a", periodId: SITES[ORG_A].periodId },
      { client: "b", periodId: SITES[ORG_B].periodId },
    ]);
    expect(drain(mocks.providerReads)).toEqual([
      { client: "a", microgridId: SITES[ORG_A].microgridId },
      { client: "b", microgridId: SITES[ORG_B].microgridId },
    ]);
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a"], [ORG_B]: ["b"] });

    // Metering resolves the microgrid, plugin state and meters through its own
    // organization's client, and reads through a source bound to it.
    const [readA, readB] = await Promise.all([
      meteringA.data.metering.getConsumption(consumptionQuery(ORG_A)),
      meteringB.data.metering.getConsumption(consumptionQuery(ORG_B)),
    ]);
    expect(readA).toMatchObject({ ok: true, data: [{ deviceId: SITES[ORG_A].deviceId }] });
    expect(readB).toMatchObject({ ok: true, data: [{ deviceId: SITES[ORG_B].deviceId }] });
    expect(drain(mocks.providerReads)).toEqual([
      { client: "a", microgridId: SITES[ORG_A].microgridId },
      { client: "b", microgridId: SITES[ORG_B].microgridId },
    ]);
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a"], [ORG_B]: ["b"] });

    // Disposing `a`'s scopes makes its capabilities inert, before any read.
    await Promise.all([billingA.data.dispose(), meteringA.data.dispose()]);
    expect(
      await billingA.data.billing.previewBills({ billingPeriodId: SITES[ORG_A].periodId })
    ).toMatchObject({ ok: false, code: "billing_composition_disposed" });
    expect(
      await meteringA.data.metering.getConsumption(consumptionQuery(ORG_A))
    ).toMatchObject({ ok: false, code: "metering_composition_disposed" });
    expect(mocks.generationRuns).toEqual([]);
    expect(mocks.providerReads).toEqual([]);
    expect(mocks.reads).toEqual([]);

    // B and A's second manager are still live: past the disposed guard, and
    // each still on its own client.
    const stillBilling = await Promise.all([
      billingA2.data.billing.previewBills({ billingPeriodId: SITES[ORG_A].periodId }),
      billingB.data.billing.previewBills({ billingPeriodId: SITES[ORG_B].periodId }),
    ]);
    const [stillMeteringA2, stillMeteringB] = await Promise.all([
      meteringA2.data.metering.getConsumption(consumptionQuery(ORG_A)),
      meteringB.data.metering.getConsumption(consumptionQuery(ORG_B)),
    ]);
    for (const still of stillBilling) {
      expect(still).not.toMatchObject({ code: "billing_composition_disposed" });
      expect(still, JSON.stringify(still)).toMatchObject({ ok: true });
    }
    expect(stillMeteringA2).not.toMatchObject({ code: "metering_composition_disposed" });
    expect(stillMeteringB).not.toMatchObject({ code: "metering_composition_disposed" });
    expect(stillMeteringA2).toMatchObject({
      ok: true,
      data: [{ deviceId: SITES[ORG_A].deviceId }],
    });
    expect(stillMeteringB).toMatchObject({ ok: true, data: [{ deviceId: SITES[ORG_B].deviceId }] });
    expect(drain(mocks.generationRuns)).toEqual([
      { client: "a2", periodId: SITES[ORG_A].periodId },
      { client: "b", periodId: SITES[ORG_B].periodId },
    ]);
    expect(drain(mocks.providerReads)).toEqual([
      { client: "a2", microgridId: SITES[ORG_A].microgridId },
      { client: "a2", microgridId: SITES[ORG_A].microgridId },
      { client: "b", microgridId: SITES[ORG_B].microgridId },
      { client: "b", microgridId: SITES[ORG_B].microgridId },
    ]);
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a2"], [ORG_B]: ["b"] });

    // B switches metering off while both are live. A2 and B re-check at once,
    // so a re-check read shared across organizations would hand B A's answer.
    mocks.disabled.add(`${ORG_B}:metering`);
    const [liveA2, offB] = await Promise.all([
      meteringA2.data.metering.getConsumption(consumptionQuery(ORG_A)),
      meteringB.data.metering.getConsumption(consumptionQuery(ORG_B)),
    ]);
    expect(liveA2, JSON.stringify(liveA2)).toMatchObject({ ok: true });
    expect(offB).toMatchObject({ ok: false, status: 409, code: "metering_disabled" });
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a2"], [ORG_B]: ["b"] });

    // Requests that compose one after another each carry their own user, not
    // one an earlier request left behind.
    for (const name of ["a", "b"]) {
      const { userId, orgId } = CLIENTS[name];
      const later = await composeBilling({ supabase: client(name), organizationId: orgId });
      expect(later, JSON.stringify(later)).toMatchObject({
        ok: true,
        data: { scope: { organizationId: orgId, userId } },
      });
      if (later.ok) await later.data.dispose();
    }
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a"], [ORG_B]: ["b"] });

    await Promise.all([
      billingB.data.dispose(),
      meteringB.data.dispose(),
      billingA2.data.dispose(),
      meteringA2.data.dispose(),
    ]);
    expect(runtime.root.registry.size).toBe(before);
  });

  it("refuses only the organization with the plugin off when both compose at once", async () => {
    mocks.disabled.add(`${ORG_B}:billing`);
    mocks.disabled.add(`${ORG_B}:metering`);
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;

    // At the same time, so a plugin-state read shared across organizations
    // would hand B the answer A's composition is waiting on.
    const [billingA, billingB, meteringA, meteringB] = await Promise.all([
      composeBilling({ supabase: client("a"), organizationId: ORG_A }),
      composeBilling({ supabase: client("b"), organizationId: ORG_B }),
      composeMetering({ supabase: client("a"), organizationId: ORG_A }),
      composeMetering({ supabase: client("b"), organizationId: ORG_B }),
    ]);
    expect(billingB).toMatchObject({ ok: false, status: 409, code: "billing_disabled" });
    expect(meteringB).toMatchObject({ ok: false, status: 409, code: "metering_disabled" });
    expect(billingA.ok, JSON.stringify(billingA)).toBe(true);
    expect(meteringA.ok, JSON.stringify(meteringA)).toBe(true);
    if (!billingA.ok || !meteringA.ok) return;
    // Only A's two compositions opened a scope.
    expect(
      vi.mocked(openOrganizationScope).mock.calls.map(([options]) => options.organizationId)
    ).toEqual([ORG_A, ORG_A]);
    expect(runtime.root.registry.size).toBeGreaterThan(before);
    // Each composer read its own organization's state through its caller's client.
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a"], [ORG_B]: ["b"] });

    // B's refusal leaves A's compositions working on A's client.
    expect(
      await billingA.data.billing.previewBills({ billingPeriodId: SITES[ORG_A].periodId })
    ).toMatchObject({ ok: true });
    expect(
      await meteringA.data.metering.getConsumption(consumptionQuery(ORG_A))
    ).toMatchObject({ ok: true, data: [{ deviceId: SITES[ORG_A].deviceId }] });
    expect(drain(mocks.generationRuns)).toEqual([
      { client: "a", periodId: SITES[ORG_A].periodId },
    ]);
    expect(drain(mocks.providerReads)).toEqual([
      { client: "a", microgridId: SITES[ORG_A].microgridId },
      { client: "a", microgridId: SITES[ORG_A].microgridId },
    ]);
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a"] });

    // A's write-time re-check reads A's state through A's client, so B's
    // switch does not reach it.
    const generated = await billingA.data.billing.generateBills({
      billingPeriodId: SITES[ORG_A].periodId,
    });
    expect(generated, JSON.stringify(generated)).toMatchObject({ ok: true });
    expect(drain(mocks.generationRuns)).toEqual([{ client: "a", periodId: SITES[ORG_A].periodId }]);
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a"] });

    // A's own switch does reach it, before anything is generated.
    mocks.disabled.add(`${ORG_A}:billing`);
    expect(
      await billingA.data.billing.generateBills({ billingPeriodId: SITES[ORG_A].periodId })
    ).toMatchObject({ ok: false, status: 409, code: "billing_disabled" });
    expect(drain(mocks.generationRuns)).toEqual([]);
    expect(readersByOrg()).toEqual({ [ORG_A]: ["a"] });

    // Disposing A's compositions returns the root to its starting size, so
    // B's refusals left nothing behind.
    await Promise.all([billingA.data.dispose(), meteringA.data.dispose()]);
    expect(runtime.root.registry.size).toBe(before);
  });
});

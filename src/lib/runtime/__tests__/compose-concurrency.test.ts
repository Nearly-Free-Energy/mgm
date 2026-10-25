/**
 * Real composers on the shared runtime, two organizations at once
 * (docs/cordis-runtime.md § "Two lifetimes"). `runtime.test.ts` covers the
 * same properties with a probe plugin; this pins them for the capability
 * plugins that actually ship.
 *
 * Each organization has its own client, and a client sees only its own
 * organization's rows, as RLS would. The bill engine and the OpenEMS source
 * record the client they run with, so a composition that ends up with the
 * other organization's client fails here even when its scope names the
 * right organization.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunGenerationParams } from "@/lib/billing/generate";
import type { MeteringReadRequest } from "@/lib/metering/types";
import { composeBilling } from "@/lib/billing/compose";
import { composeMetering } from "@/lib/metering/compose";
import { getMgmRuntime, resetMgmRuntimeForTests } from "../root";

const ORG_A = "550e8400-e29b-41d4-a716-44665544000a";
const ORG_B = "550e8400-e29b-41d4-a716-44665544000b";

type Tenant = {
  label: string;
  organizationId: string;
  microgridId: string;
  periodId: string;
  deviceId: string;
};

const A: Tenant = {
  label: "a",
  organizationId: ORG_A,
  microgridId: "550e8400-e29b-41d4-a716-4466554400a1",
  periodId: "550e8400-e29b-41d4-a716-4466554400a2",
  deviceId: "550e8400-e29b-41d4-a716-4466554400a3",
};
const B: Tenant = {
  label: "b",
  organizationId: ORG_B,
  microgridId: "550e8400-e29b-41d4-a716-4466554400b1",
  periodId: "550e8400-e29b-41d4-a716-4466554400b2",
  deviceId: "550e8400-e29b-41d4-a716-4466554400b3",
};

/** What reached the bill engine and the OpenEMS source, and through which client. */
const recorded = vi.hoisted(() => ({
  generations: [] as { client: string; periodId: string }[],
  reads: [] as { client: string; microgridId: string }[],
}));

/** Plugins switched off, as `<organization id>/<plugin>`. */
const disabled = vi.hoisted(() => new Set<string>());

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () =>
    [ORG_A, ORG_B].map((scope_id) => ({
      user_id: "user-1",
      role: "org_manager",
      scope_type: "org",
      scope_id,
    })),
}));

vi.mock("@/lib/plugins/state", async (importOriginal) => {
  // One answer for the per-plugin helpers and for the generic read behind
  // `checkGate`, so the state holds whichever one a composer calls.
  const enabled = async (_supabase: unknown, organizationId: string, plugin: string) =>
    !disabled.has(`${organizationId}/${plugin}`);
  return {
    ...(await importOriginal<typeof import("@/lib/plugins/state")>()),
    isPluginEnabledForOrg: enabled,
    isBillingEnabled: (supabase: unknown, organizationId: string) =>
      enabled(supabase, organizationId, "billing"),
    isMeteringEnabled: (supabase: unknown, organizationId: string) =>
      enabled(supabase, organizationId, "metering"),
  };
});

// Only the lookups these tests reach are faked. Each answers from the calling
// client's rows, so a repository holding the other organization's client
// resolves nothing and the capability refuses with a scope mismatch.
vi.mock("@/lib/billing/infrastructure/supabase-repository", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/billing/infrastructure/supabase-repository")
  >();
  return {
    ...actual,
    createSupabaseBillingRepository: (supabase: SupabaseClient) => ({
      ...actual.createSupabaseBillingRepository(supabase),
      async getPeriodOrganization(periodId: string) {
        const tenant = tenantOf(supabase);
        if (periodId !== tenant.periodId) return null;
        return { periodId, microgridId: tenant.microgridId, orgId: tenant.organizationId };
      },
    }),
  };
});

vi.mock("@/lib/metering/infrastructure/supabase-repository", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/metering/infrastructure/supabase-repository")
  >();
  return {
    ...actual,
    createSupabaseMeteringRepository: (supabase: SupabaseClient) => ({
      ...actual.createSupabaseMeteringRepository(supabase),
      async getMicrogridOrganization(microgridId: string) {
        const tenant = tenantOf(supabase);
        if (microgridId !== tenant.microgridId) return null;
        return {
          microgridId,
          communityId: `community-${tenant.label}`,
          orgId: tenant.organizationId,
        };
      },
      async getManagedDevices(microgridId: string) {
        const tenant = tenantOf(supabase);
        if (microgridId !== tenant.microgridId) return [];
        return [
          {
            id: tenant.deviceId,
            edgeOpenemsId: "edge0",
            componentId: "meter0",
            name: "Meter",
            edgeId: `edge-${tenant.label}`,
            deviceType: "meter",
          },
        ];
      },
    }),
  };
});

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: (supabase: SupabaseClient) => ({
    async getReadings(request: MeteringReadRequest) {
      recorded.reads.push({ client: tenantOf(supabase).label, microgridId: request.microgridId });
      return request.devices.map((device) => ({
        deviceId: device.id,
        usageKwh: 1,
        startDate: request.startDate,
        endDate: request.endDate,
      }));
    },
  }),
}));

// The engine's own queries are out of scope. It records the client billing
// hands it, then reads the period's microgrid through the metering source
// billing bound to that client, as a real run does.
vi.mock("@/lib/billing/generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/generate")>()),
  runGenerationFor: async (params: RunGenerationParams) => {
    recorded.generations.push({
      client: tenantOf(params.supabase).label,
      periodId: params.periodId,
    });
    const owner = [A, B].find((tenant) => tenant.periodId === params.periodId);
    await params.meteringProvider?.getReadings({
      microgridId: owner?.microgridId ?? "unknown",
      devices: [],
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      timezone: "UTC",
    });
    return { results: [] };
  },
}));

/** A caller's client. It sees only its own organization's rows. */
function client(tenant: Tenant): SupabaseClient {
  return {
    tenant,
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  } as unknown as SupabaseClient;
}

function tenantOf(supabase: unknown): Tenant {
  return (supabase as { tenant: Tenant }).tenant;
}

function consumption(tenant: Tenant) {
  return {
    microgrid_id: tenant.microgridId,
    start_date: "2026-09-01",
    end_date: "2026-09-30",
    timezone: "UTC",
    provider: "openems",
  };
}

/** Everything recorded since the last call. */
function take() {
  return {
    generations: recorded.generations.splice(0),
    reads: recorded.reads.splice(0),
  };
}

afterEach(async () => {
  take();
  disabled.clear();
  await resetMgmRuntimeForTests();
});

describe("composers on the shared runtime", () => {
  it("keeps concurrent organizations apart and leaves the root as it found it", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;

    const [billingA, billingB, meteringA, meteringB] = await Promise.all([
      composeBilling({ supabase: client(A), organizationId: ORG_A }),
      composeBilling({ supabase: client(B), organizationId: ORG_B }),
      composeMetering({ supabase: client(A), organizationId: ORG_A }),
      composeMetering({ supabase: client(B), organizationId: ORG_B }),
    ]);
    for (const composed of [billingA, billingB, meteringA, meteringB]) {
      expect(composed.ok, JSON.stringify(composed)).toBe(true);
    }
    if (!billingA.ok || !billingB.ok || !meteringA.ok || !meteringB.ok) return;

    expect(billingA.data.scope.organizationId).toBe(ORG_A);
    expect(billingB.data.scope.organizationId).toBe(ORG_B);
    expect(meteringA.data.scope.organizationId).toBe(ORG_A);
    expect(meteringB.data.scope.organizationId).toBe(ORG_B);
    expect(billingA.data.billing).not.toBe(billingB.data.billing);
    expect(meteringA.data.metering).not.toBe(meteringB.data.metering);
    expect(runtime.root.registry.size).toBeGreaterThan(before);

    // Each capability runs on its own organization's client. If one client
    // won for both, A's records would name "b" while its scope still said A.
    const results = [
      await billingA.data.billing.previewBills({ billingPeriodId: A.periodId }),
      await billingB.data.billing.previewBills({ billingPeriodId: B.periodId }),
      await meteringA.data.metering.getConsumption(consumption(A)),
      await meteringB.data.metering.getConsumption(consumption(B)),
    ];
    for (const result of results) {
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    expect(take()).toEqual({
      generations: [
        { client: "a", periodId: A.periodId },
        { client: "b", periodId: B.periodId },
      ],
      reads: [
        { client: "a", microgridId: A.microgridId }, // billing A's metering source
        { client: "b", microgridId: B.microgridId }, // billing B's metering source
        { client: "a", microgridId: A.microgridId }, // metering A's OpenEMS source
        { client: "b", microgridId: B.microgridId }, // metering B's OpenEMS source
      ],
    });

    // Disposing A's scopes makes A's capabilities inert and leaves B's working.
    await Promise.all([billingA.data.dispose(), meteringA.data.dispose()]);
    expect(
      await billingA.data.billing.previewBills({ billingPeriodId: A.periodId })
    ).toMatchObject({ ok: false, code: "billing_composition_disposed" });
    expect(await meteringA.data.metering.getConsumption(consumption(A))).toMatchObject({
      ok: false,
      code: "metering_composition_disposed",
    });
    // B still runs to the engine and the vendor, not just past validation, so
    // no failure code (billing_composition_disposed included) can pass here,
    // and the records hold only B's: A's calls reached neither.
    const stillBilling = await billingB.data.billing.previewBills({ billingPeriodId: B.periodId });
    const stillMetering = await meteringB.data.metering.getConsumption(consumption(B));
    expect(stillBilling, JSON.stringify(stillBilling)).toMatchObject({ ok: true });
    expect(stillMetering, JSON.stringify(stillMetering)).toMatchObject({ ok: true });
    expect(take()).toEqual({
      generations: [{ client: "b", periodId: B.periodId }],
      reads: [
        { client: "b", microgridId: B.microgridId },
        { client: "b", microgridId: B.microgridId },
      ],
    });

    await Promise.all([billingB.data.dispose(), meteringB.data.dispose()]);
    expect(runtime.root.registry.size).toBe(before);
  });

  it("reads plugin state per organization when both compose at once", async () => {
    disabled.add(`${ORG_B}/billing`);
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;

    const [billingA, billingB] = await Promise.all([
      composeBilling({ supabase: client(A), organizationId: ORG_A }),
      composeBilling({ supabase: client(B), organizationId: ORG_B }),
    ]);
    expect(billingB).toMatchObject({ ok: false, status: 409, code: "billing_disabled" });
    expect(billingA.ok, JSON.stringify(billingA)).toBe(true);
    if (!billingA.ok) return;

    // A's write-time check reads A's state too, so B's switch does not reach it.
    const generated = await billingA.data.billing.generateBills({ billingPeriodId: A.periodId });
    expect(generated, JSON.stringify(generated)).toMatchObject({ ok: true });
    expect(take().generations).toEqual([{ client: "a", periodId: A.periodId }]);

    await billingA.data.dispose();
    // B's refused composition left nothing on the root.
    expect(runtime.root.registry.size).toBe(before);
  });
});

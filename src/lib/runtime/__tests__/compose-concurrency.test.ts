/**
 * Real composers on the shared runtime, two organizations at once
 * (docs/cordis-runtime.md § "Two lifetimes"). `runtime.test.ts` covers the
 * same properties with a probe plugin; this pins them for the capability
 * plugins that actually ship.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeBilling } from "@/lib/billing/compose";
import { composeMetering } from "@/lib/metering/compose";
import { getMgmRuntime, resetMgmRuntimeForTests } from "../root";

const ORG_A = "550e8400-e29b-41d4-a716-44665544000a";
const ORG_B = "550e8400-e29b-41d4-a716-44665544000b";

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () =>
    [ORG_A, ORG_B].map((scope_id) => ({
      user_id: "user-1",
      role: "org_manager",
      scope_type: "org",
      scope_id,
    })),
}));

vi.mock("@/lib/plugins/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugins/state")>()),
  isBillingEnabled: async () => true,
  isMeteringEnabled: async () => true,
}));

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: (supabase: unknown) => ({ kind: "openems", supabase }),
}));

function client(label: string) {
  return {
    label,
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  } as never;
}

afterEach(async () => {
  await resetMgmRuntimeForTests();
});

describe("composers on the shared runtime", () => {
  it("keeps concurrent organizations apart and leaves the root as it found it", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;

    const [billingA, billingB, meteringA, meteringB] = await Promise.all([
      composeBilling({ supabase: client("a"), organizationId: ORG_A }),
      composeBilling({ supabase: client("b"), organizationId: ORG_B }),
      composeMetering({ supabase: client("a"), organizationId: ORG_A }),
      composeMetering({ supabase: client("b"), organizationId: ORG_B }),
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
    expect(runtime.root.registry.size).toBeGreaterThan(before);

    // Disposing A's scopes leaves B's capabilities working.
    await Promise.all([billingA.data.dispose(), meteringA.data.dispose()]);
    const afterA = await billingA.data.billing.previewBills({ billingPeriodId: "not-a-uuid" });
    expect(afterA).toMatchObject({ ok: false, code: "billing_composition_disposed" });
    const stillB = await billingB.data.billing.previewBills({ billingPeriodId: "not-a-uuid" });
    // B is still live: it reaches input validation instead of the disposed guard.
    expect(stillB).toMatchObject({ ok: false, status: 400 });

    await Promise.all([billingB.data.dispose(), meteringB.data.dispose()]);
    expect(runtime.root.registry.size).toBe(before);
  });
});

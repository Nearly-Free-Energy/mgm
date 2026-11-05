/**
 * Every community-management write re-reads plugin state just before it
 * writes (`requireScopedAccess`, through `requireCommunityPlugin`, in
 * operations/shared.ts), because the plugin can be turned off between
 * composition and the write. A disabled plugin is
 * `409 community_management_disabled`; state that cannot be read is
 * `503 community_management_gate_unavailable`. Either way nothing past the
 * re-check runs: the lookups that resolve the organization come first, and
 * every other repository method only after the re-check passes. Whether the
 * wording matches the gate's is checked end to end, through the real
 * repository, in runtime/__tests__/compose-fail-closed.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { CommunityManagementCapability } from "../capability";
import type { CommunityManagementRepository, OrganizationScope } from "../types";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440001";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const HH_ID = "770e8400-e29b-41d4-a716-446655440000";

const scope: OrganizationScope = { organizationId: ORG_ID, userId: "user-1", roles: [] };

const READ_BEFORE_RECHECK = new Set<string>([
  "getCommunityOrganizationId",
  "getMicrogridOrganization",
  "findHousehold",
  "isPluginEnabled",
]);

function stubRepo(
  isPluginEnabled: CommunityManagementRepository["isPluginEnabled"]
): CommunityManagementRepository {
  return {
    getAuthenticatedUserId: async () => "user-1",
    getUserRoles: async () => [],
    isPluginEnabled,
    getCommunityOrganizationId: async () => ORG_ID,
    getMicrogridOrganization: async () => ({
      microgridId: MG_ID,
      communityId: COMMUNITY_ID,
      orgId: ORG_ID,
    }),
    findHousehold: async () => ({
      data: { id: HH_ID, display_name: "Household 1", microgrid_id: MG_ID },
      error: null,
    }),
    updateHouseholdFields: async () => ({ data: { id: HH_ID } as never, error: null }),
    insertCommunity: async () => ({ data: { id: COMMUNITY_ID } as never, error: null }),
    updateCommunity: async () => ({ data: { id: COMMUNITY_ID } as never, error: null }),
    insertMicrogrid: async () => ({ data: { id: MG_ID } as never, error: null }),
    updateMicrogrid: async () => ({ data: { id: MG_ID } as never, error: null }),
    createHousehold: async () => ({ data: HH_ID, error: null }),
    findDeviceLink: async () => null,
    getOpenDeviceLink: async () => null,
    closeDeviceLink: async () => null,
    replaceDeviceLink: async () => ({ id: null, error: null }),
    deleteDeviceLink: async () => null,
    refetchHousehold: async () => ({ data: { id: HH_ID } as never, error: null }),
    countBillingLineItems: async () => ({ count: 0, error: null }),
    deleteHousehold: async () => ({ data: [{ id: HH_ID }], error: null }),
    resolveHierarchyLevels: async () => [],
  };
}

const WRITES: {
  method: string;
  run: (capability: CommunityManagementCapability) => Promise<unknown>;
}[] = [
  { method: "createCommunity", run: (c) => c.createCommunity({ org_id: ORG_ID, name: "Community A" }) },
  { method: "updateCommunity", run: (c) => c.updateCommunity(COMMUNITY_ID, { name: "Community B" }) },
  {
    method: "createMicrogrid",
    run: (c) => c.createMicrogrid({ community_id: COMMUNITY_ID, name: "North", currency: "UGX" }),
  },
  { method: "updateMicrogrid", run: (c) => c.updateMicrogrid(MG_ID, { name: "North II" }) },
  {
    method: "createHousehold",
    run: (c) =>
      c.createHousehold({
        microgrid_id: MG_ID,
        display_name: "Household 1",
        primary_phone: "+256700000000",
      }),
  },
  { method: "updateHousehold", run: (c) => c.updateHousehold(HH_ID, { display_name: "Household 2" }) },
  { method: "deleteHousehold", run: (c) => c.deleteHousehold(HH_ID) },
];

function spiedSetup(isPluginEnabled: CommunityManagementRepository["isPluginEnabled"]) {
  const repo = Object.fromEntries(
    Object.entries(stubRepo(isPluginEnabled)).map(([name, fn]) => [name, vi.fn(fn)])
  ) as unknown as CommunityManagementRepository & Record<string, ReturnType<typeof vi.fn>>;
  const capability = new CommunityManagementCapability(repo, scope, () => true);
  const calledAfterRecheck = () =>
    Object.entries(repo)
      .filter(([name, spy]) => !READ_BEFORE_RECHECK.has(name) && spy.mock.calls.length > 0)
      .map(([name]) => name);
  return { capability, repo, calledAfterRecheck };
}

describe("CommunityManagementCapability plugin re-check before each write", () => {
  it.each(WRITES)("$method answers 409 and writes nothing when the plugin is disabled", async ({ run }) => {
    const { capability, repo, calledAfterRecheck } = spiedSetup(async () => false);
    const result = await run(capability);
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "community_management_disabled",
    });
    expect(repo.isPluginEnabled).toHaveBeenCalledWith(ORG_ID);
    expect(calledAfterRecheck()).toEqual([]);
  });

  it.each(WRITES)("$method answers 503 and writes nothing when plugin state cannot be read", async ({ run }) => {
    const { capability, repo, calledAfterRecheck } = spiedSetup(async () => {
      throw new Error("canceling statement due to statement timeout");
    });
    const result = await run(capability);
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      code: "community_management_gate_unavailable",
    });
    expect(repo.isPluginEnabled).toHaveBeenCalledWith(ORG_ID);
    expect(calledAfterRecheck()).toEqual([]);
  });

  it.each(WRITES)("$method goes on to the repository when the plugin is enabled", async ({ run }) => {
    // Keeps the two refusals above from passing vacuously.
    const { capability, calledAfterRecheck } = spiedSetup(async () => true);
    await run(capability);
    expect(calledAfterRecheck()).not.toEqual([]);
  });

  it("resolves hierarchy levels without reading plugin state", async () => {
    const { capability, repo } = spiedSetup(async () => {
      throw new Error("canceling statement due to statement timeout");
    });
    const result = await capability.resolveHierarchy({ kind: "communities", orgId: ORG_ID });
    expect(result).toMatchObject({ ok: true });
    expect(repo.isPluginEnabled).not.toHaveBeenCalled();
  });
});

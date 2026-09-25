import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeCommunityManagement } from "../compose";

let user: { id: string } | null = { id: "user-1" };
let roles: unknown[] = [];
let pluginEnabled = true;

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => roles,
}));

vi.mock("@/lib/plugins/state", () => ({
  isCommunityManagementEnabled: async () => pluginEnabled,
}));

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ORG_ID = "550e8400-e29b-41d4-a716-446655440001";

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
  } as never;
}

describe("composeCommunityManagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    user = { id: "user-1" };
    roles = [
      {
        user_id: "user-1",
        role: "org_manager",
        scope_type: "org",
        scope_id: ORG_ID,
      },
    ];
    pluginEnabled = true;
  });

  it("rejects malformed organization ids", async () => {
    const result = await composeCommunityManagement({
      supabase: makeSupabase(),
      organizationId: "not-a-uuid",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("requires authentication", async () => {
    user = null;
    const result = await composeCommunityManagement({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects organizations outside the caller's roles", async () => {
    roles = [];
    const result = await composeCommunityManagement({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed when the plugin is disabled", async () => {
    pluginEnabled = false;
    const result = await composeCommunityManagement({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "community_management_disabled",
    });
  });

  it("provides an organization-scoped capability and deactivates it on dispose", async () => {
    const result = await composeCommunityManagement({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    if (!result.ok) throw new Error("expected composition");
    expect(result.data.scope).toMatchObject({
      organizationId: ORG_ID,
      userId: "user-1",
    });

    const crossOrg = await result.data.communityManagement.createCommunity({
      org_id: OTHER_ORG_ID,
      name: "Elsewhere",
    });
    expect(crossOrg).toMatchObject({
      ok: false,
      status: 403,
      code: "community_scope_mismatch",
    });

    await result.data.dispose();
    const afterDispose = await result.data.communityManagement.createCommunity({
      org_id: ORG_ID,
      name: "Too late",
    });
    expect(afterDispose).toMatchObject({
      ok: false,
      code: "community_composition_disposed",
    });
  });

  it("rejects hierarchy scopes outside the composition organization", async () => {
    const result = await composeCommunityManagement({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    if (!result.ok) throw new Error("expected composition");
    const crossOrg = await result.data.communityManagement.resolveHierarchy({
      kind: "communities",
      orgId: OTHER_ORG_ID,
    });
    expect(crossOrg).toMatchObject({
      ok: false,
      status: 403,
      code: "community_scope_mismatch",
    });
    await result.data.dispose();
  });

  it("resolves hierarchy levels inside the composition organization", async () => {
    const supabase = {
      auth: { getUser: async () => ({ data: { user } }) },
      from: (table: string) => {
        if (table !== "organizations") {
          throw new Error(`Unexpected table: ${table}`);
        }
        return {
          select: () => ({
            order: () => ({
              returns: async () => ({
                data: [{ id: ORG_ID, name: "Acme Energy" }],
                error: null,
              }),
            }),
          }),
        };
      },
    } as never;
    const result = await composeCommunityManagement({
      supabase,
      organizationId: ORG_ID,
    });
    if (!result.ok) throw new Error("expected composition");
    const levels = await result.data.communityManagement.resolveHierarchy({
      kind: "communities",
      orgId: ORG_ID,
    });
    if (!levels.ok) throw new Error("expected levels");
    expect(levels.data).toHaveLength(1);
    expect(levels.data[0]).toMatchObject({
      kind: "Organization",
      label: "Acme Energy",
    });
    await result.data.dispose();
  });
});

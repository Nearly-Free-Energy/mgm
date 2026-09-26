import { beforeEach, describe, expect, it, vi } from "vitest";
import { setOrganizationPluginEnabled } from "../state";

let canAccessOrg = true;
let user: { id: string } | null = { id: "user-1" };
let pluginRows: unknown[] = [];
let rpcImpl: () => Promise<{ data: unknown; error: null }> = async () => ({
  data: null,
  error: null,
});

const mockRpc = vi.fn(() => rpcImpl());

function mockFrom() {
  return {
    select: () => ({
      eq: () => ({
        returns: async () => ({ data: pluginRows, error: null }),
      }),
    }),
  };
}

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrg,
}));

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => mockFrom(),
    rpc: mockRpc,
  } as never;
}

describe("setOrganizationPluginEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrg = true;
    user = { id: "user-1" };
    pluginRows = [];
    rpcImpl = async () => ({ data: null, error: null });
  });

  it("rejects a malformed organization id", async () => {
    await expect(
      setOrganizationPluginEnabled(makeSupabase(), "not-a-uuid", "community-management", false)
    ).rejects.toMatchObject({ status: 400, code: "invalid_org_id" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    user = null;
    await expect(
      setOrganizationPluginEnabled(makeSupabase(), ORG_ID, "community-management", false)
    ).rejects.toMatchObject({ status: 401 });
  });

  it("requires organization access", async () => {
    canAccessOrg = false;
    await expect(
      setOrganizationPluginEnabled(makeSupabase(), ORG_ID, "community-management", false)
    ).rejects.toMatchObject({ status: 403, code: "plugin_forbidden" });
  });

  it("rejects unknown plugins", async () => {
    await expect(
      setOrganizationPluginEnabled(makeSupabase(), ORG_ID, "online-payments", true)
    ).rejects.toMatchObject({ status: 400, code: "unknown_plugin" });
  });

  it("locks the organization directory", async () => {
    await expect(
      setOrganizationPluginEnabled(makeSupabase(), ORG_ID, "organization-directory", false)
    ).rejects.toMatchObject({ status: 409, code: "plugin_core_locked" });
  });

  it("returns current state without an audit write when nothing changes", async () => {
    pluginRows = [
      {
        org_id: ORG_ID,
        plugin_name: "community-management",
        version: "0.1.0",
        enabled: true,
      },
    ];
    const status = await setOrganizationPluginEnabled(
      makeSupabase(),
      ORG_ID,
      "community-management",
      true
    );
    expect(status.enabled).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects disabling community management while metering is enabled", async () => {
    pluginRows = [
      {
        org_id: ORG_ID,
        plugin_name: "community-management",
        version: "0.1.0",
        enabled: true,
      },
    ];
    await expect(
      setOrganizationPluginEnabled(
        makeSupabase(),
        ORG_ID,
        "community-management",
        false
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "plugin_dependency_required",
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("persists a valid toggle through the atomic RPC", async () => {
    pluginRows = [
      {
        org_id: ORG_ID,
        plugin_name: "community-management",
        version: "0.1.0",
        enabled: true,
      },
      {
        org_id: ORG_ID,
        plugin_name: "metering",
        version: "0.1.0",
        enabled: false,
      },
      {
        org_id: ORG_ID,
        plugin_name: "billing",
        version: "0.1.0",
        enabled: false,
      },
    ];
    rpcImpl = async () => {
      pluginRows = [
        {
          org_id: ORG_ID,
          plugin_name: "community-management",
          version: "0.1.0",
          enabled: false,
        },
      ];
      return {
        data: {
          org_id: ORG_ID,
          plugin_name: "community-management",
          version: "0.1.0",
          enabled: false,
        },
        error: null,
      };
    };

    const status = await setOrganizationPluginEnabled(
      makeSupabase(),
      ORG_ID,
      "community-management",
      false
    );
    expect(mockRpc).toHaveBeenCalledWith("fn_mgm_set_plugin_enabled", {
      _enabled: false,
      _org_id: ORG_ID,
      _plugin_name: "community-management",
      _plugin_version: "0.1.0",
    });
    expect(status.enabled).toBe(false);
  });
});

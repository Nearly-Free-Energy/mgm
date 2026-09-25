import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class PluginServiceError extends Error {
    status: number;
    code: string;
    field?: string;
    constructor(status: number, code: string, message: string, field?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.field = field;
    }
  }
  return {
    mockList: vi.fn(),
    mockSet: vi.fn(),
    mockAudit: vi.fn(),
    PluginServiceError,
  };
});

const mockRevalidate = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({}),
}));
vi.mock("@/lib/plugins/state", () => ({
  listOrganizationPlugins: (...args: unknown[]) => mocks.mockList(...args),
  setOrganizationPluginEnabled: (...args: unknown[]) => mocks.mockSet(...args),
  listOrganizationPluginAudit: (...args: unknown[]) => mocks.mockAudit(...args),
  PluginServiceError: mocks.PluginServiceError,
}));

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";

function makePatch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/organizations/${ORG_ID}/plugins`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("organization plugin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockList.mockResolvedValue([]);
    mocks.mockAudit.mockResolvedValue([]);
  });

  it("GET returns plugins and audit history", async () => {
    mocks.mockList.mockResolvedValue([
      {
        plugin: {
          name: "community-management",
          displayName: "Community management",
          description: "desc",
          core: false,
          dependencies: ["organization-directory"],
          provides: [],
          routes: [],
        },
        enabled: true,
        version: "0.1.0",
        ready: true,
        disabledDependencies: [],
      },
    ]);
    const { GET } = await import("../route");
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.plugins[0]).toMatchObject({
      name: "community-management",
      enabled: true,
      ready: true,
    });
    expect(json.audit).toEqual([]);
  });

  it("PATCH validates the enabled flag", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatch({ plugin: "community-management" }), {
      params: Promise.resolve({ id: ORG_ID }),
    });
    expect(res.status).toBe(400);
    expect(mocks.mockSet).not.toHaveBeenCalled();
  });

  it("PATCH maps dependency errors without writing", async () => {
    mocks.mockSet.mockRejectedValue(
      new mocks.PluginServiceError(
        409,
        "plugin_core_locked",
        "Organization directory cannot be disabled."
      )
    );
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatch({ plugin: "organization-directory", enabled: false }),
      { params: Promise.resolve({ id: ORG_ID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("plugin_core_locked");
  });

  it("PATCH persists a valid toggle and revalidates settings", async () => {
    mocks.mockSet.mockResolvedValue({
      plugin: { name: "community-management", displayName: "Community management" },
      enabled: false,
      version: "0.1.0",
      ready: true,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatch({ plugin: "community-management", enabled: false }),
      { params: Promise.resolve({ id: ORG_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mockRevalidate).toHaveBeenCalledWith("/settings/plugins", "page");
  });
});

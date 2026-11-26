/**
 * Community management's described actions (../surface.ts), one row each:
 * the route, what binds it, its risk, confirmation and what a repeat does.
 * gui-surface.test.ts holds each to its route file, schema, gate and
 * release; repeat.db.test.ts sends each "safe" one twice; actions.db.test.ts
 * prepares the guarded ones against a database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDef, SurfaceRequest } from "@/lib/gui/surface";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { COMMUNITY_MANAGEMENT_SURFACE, TENANT_ACCESS_KIND } from "../surface";

/** Each organization's tenant app state, as isPluginEnabledForOrg answers it; a missing one throws. */
const tenantApp = new Map<string, boolean>();
vi.mock("@/lib/plugins/state", () => ({
  isPluginEnabledForOrg: vi.fn(async (_supabase: unknown, org: string, plugin: string) => {
    expect(plugin).toBe("tenant-app");
    const on = tenantApp.get(org);
    if (on === undefined) throw new Error("statement timeout");
    return on;
  }),
}));

const ACTIONS = COMMUNITY_MANAGEMENT_SURFACE.actions as ActionDef[];

describe("community management's actions", () => {
  it("describe each write route once, as these rows say", () => {
    const rows = ACTIONS.map((a) => [a.id, a.method, a.path, a.target, a.bind, a.risk, a.confirm, a.repeat, !!a.prepare]);
    expect(rows).toEqual([
      ["community.create-community", "POST", "/api/communities", "organization", { body: { org_id: "organization" } }, "write", "none", "unsafe", false],
      ["community.update-community", "PATCH", "/api/communities/[id]", "community", { path: { id: "community" } }, "write", "none", "safe", false],
      ["community.delete-community", "DELETE", "/api/communities/[id]", "community", { path: { id: "community" } }, "destructive", "typed", "safe", true],
      ["community.create-microgrid", "POST", "/api/microgrids", "community", { body: { community_id: "community" } }, "write", "none", "safe", false],
      ["community.update-microgrid", "PATCH", "/api/microgrids/[id]", "microgrid", { path: { id: "microgrid" } }, "write", "none", "safe", false],
      ["community.delete-microgrid", "DELETE", "/api/microgrids/[id]", "microgrid", { path: { id: "microgrid" } }, "destructive", "typed", "safe", true],
      ["community.create-tenant", "POST", "/api/tenants/with-meter", "microgrid", { body: { microgrid_id: "microgrid" } }, "write", "none", "unsafe", false],
      ["community.update-tenant", "PATCH", "/api/tenants/[id]", "tenant", { path: { id: "tenant" } }, "write", "none", "safe", false],
      ["community.delete-tenant", "DELETE", "/api/tenants/[id]", "tenant", { path: { id: "tenant" } }, "destructive", "typed", "safe", true],
      ["community.grant-tenant-access", "POST", "/api/tenants/[id]/access", "tenant", { path: { id: "tenant" } }, "external", "confirm", "safe", true],
      [
        "community.revoke-tenant-access",
        "DELETE",
        "/api/tenants/[id]/access/[accessId]",
        "tenant",
        { path: { id: "tenant", accessId: "community.tenant-access" } },
        "write",
        "ceremony",
        "safe",
        true,
      ],
    ]);
  });

  it("are all human-only and offered only where a view links them", () => {
    // targeted: false keeps them off other plugins' views of their target:
    // billing's view of a microgrid would otherwise offer Edit and Delete
    // microgrid. No page of this plugin is a view yet.
    for (const a of ACTIONS) expect([a.id, a.humanOnly, a.targeted], a.id).toEqual([a.id, true, false]);
  });

  it("declare the access entity kind the removal's path names", () => {
    expect(COMMUNITY_MANAGEMENT_SURFACE.entities?.map((e) => e.kind)).toEqual([TENANT_ACCESS_KIND]);
    expect(TENANT_ACCESS_KIND).toBe("community.tenant-access");
  });
});

describe("community.grant-tenant-access's available()", () => {
  const ON_ORG = "e2780000-0000-4000-8000-0000000000a1";
  const OFF_ORG = "e2780000-0000-4000-8000-0000000000a2";
  const ON_UNIT = "e2780000-0000-4000-8004-0000000000a1";
  const OFF_UNIT = "e2780000-0000-4000-8004-0000000000a2";
  const OFF_UNIT_2 = "e2780000-0000-4000-8004-0000000000a3";
  const HIDDEN = "e2780000-0000-4000-8004-0000000000a4";
  const available = ACTIONS.find((a) => a.id === "community.grant-tenant-access")!.available!;

  beforeEach(() => {
    tenantApp.clear();
    vi.mocked(isPluginEnabledForOrg).mockClear();
  });

  /** A request whose client sees the tenants in `orgOf`, each in its organization, as the inner join returns them. */
  function request(orgOf: Record<string, string>, readError = false) {
    const asked: string[][] = [];
    const supabase = {
      from: (table: string) => {
        expect(table).toBe("tenants");
        return {
          select: (columns: string) => {
            expect(columns).toBe("id, microgrids!inner(communities!inner(org_id))");
            return {
              in: async (column: string, ids: string[]) => {
                expect(column).toBe("id");
                asked.push(ids);
                if (readError) return { data: null, error: { message: "boom" } };
                return {
                  data: ids.filter((id) => orgOf[id]).map((id) => ({ id, microgrids: { communities: { org_id: orgOf[id] } } })),
                  error: null,
                };
              },
            };
          },
        };
      },
    };
    return { req: { supabase, organizationId: ON_ORG } as unknown as SurfaceRequest, asked };
  }

  it("is the only community management action that declares available()", () => {
    expect(ACTIONS.filter((a) => a.available).map((a) => a.id)).toEqual(["community.grant-tenant-access"]);
  });

  it("says the tenant app is off for each unit whose organization has it off, and that a hidden unit is not found", async () => {
    tenantApp.set(ON_ORG, true).set(OFF_ORG, false);
    const { req, asked } = request({ [ON_UNIT]: ON_ORG, [OFF_UNIT]: OFF_ORG, [OFF_UNIT_2]: OFF_ORG });
    expect(await available(req, [ON_UNIT, OFF_UNIT, OFF_UNIT_2, HIDDEN, "not-a-uuid"])).toEqual({
      [ON_UNIT]: true,
      [OFF_UNIT]: "The tenant app is not on for this organization yet. You can give access once it is on.",
      [OFF_UNIT_2]: "The tenant app is not on for this organization yet. You can give access once it is on.",
      [HIDDEN]: "This tenant could not be found.",
      "not-a-uuid": "This tenant could not be found.",
    });
    // One read for every valid id; each organization's state asked once.
    expect(asked).toEqual([[ON_UNIT, OFF_UNIT, OFF_UNIT_2, HIDDEN]]);
    expect(vi.mocked(isPluginEnabledForOrg).mock.calls.map(([, org]) => org).sort()).toEqual([ON_ORG, OFF_ORG].sort());
  });

  it("throws when the tenants or the tenant app state cannot be read, so the host shows it not checked", async () => {
    tenantApp.set(ON_ORG, true);
    await expect(available(request({ [ON_UNIT]: ON_ORG }, true).req, [ON_UNIT])).rejects.toThrow();
    // OFF_ORG's state cannot be read (the mock throws for it).
    await expect(available(request({ [OFF_UNIT]: OFF_ORG }).req, [OFF_UNIT])).rejects.toThrow();
  });
});

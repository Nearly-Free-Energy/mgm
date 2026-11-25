/**
 * Community management's described actions (../surface.ts), one row each:
 * the route, what binds it, its risk, confirmation and what a repeat does.
 * gui-surface.test.ts holds each to its route file, schema, gate and
 * release; repeat.db.test.ts sends each "safe" one twice; actions.db.test.ts
 * prepares the guarded ones against a database.
 */
import { describe, expect, it } from "vitest";
import type { ActionDef } from "@/lib/gui/surface";
import { COMMUNITY_MANAGEMENT_SURFACE, TENANT_ACCESS_KIND } from "../surface";

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

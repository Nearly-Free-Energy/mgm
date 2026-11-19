/**
 * DELETE /api/tenants/[id]/access/[accessId] — route tests (RFC mgm#197 § 6).
 *
 * The caller's client, the role rows and the plugin state are mocked;
 * composeCommunityManagement runs for real on them. The route uses the
 * caller's own client only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { NextRequest } from "next/server";

const TENANT_ID = "7e560000-0000-4000-8005-000000000001";
const MG_ID = "7e560000-0000-4000-8002-000000000001";
const ORG_ID = "7e560000-0000-4000-8000-000000000001";
const MANAGER_ID = "7e560000-0000-4000-8009-000000000001";
const ACCESS_ID = "7e560000-0000-4000-8008-000000000001";

type Role = { role: string; scope_type: string; scope_id: string | null };
type PgError = { code?: string; message: string };

let currentUser: { id: string } | null;
let roleRows: Role[];
let plugins: Record<string, boolean>;
let tenantRow: { id: string; microgrid_id: string } | null;
let microgridRow: { id: string; communities: { org_id: string } } | null;
let revokeResult: { data: boolean | null; error: PgError | null };

const rpcSpy = vi.fn();
const createServiceSpy = vi.fn();

function maybeSingleOf<T>(read: () => T) {
  return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: read(), error: null }) }) }) };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "tenants") return maybeSingleOf(() => tenantRow);
      if (table === "microgrids") return maybeSingleOf(() => microgridRow);
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: async (fn: string, args: unknown) => {
      rpcSpy(fn, args);
      return revokeResult;
    },
    auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    createServiceSpy();
    throw new Error("the revoke route must not use the service role");
  },
}));

vi.mock("@/lib/auth/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/access")>()),
  getCurrentUserRoles: async () => roleRows,
}));

vi.mock("@/lib/plugins/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugins/state")>()),
  isPluginEnabledForOrg: async (_client: unknown, _org: string, name: string) => plugins[name] ?? true,
}));

import { DELETE } from "../route";

async function call(id = TENANT_ID, accessId = ACCESS_ID) {
  const res = await DELETE(
    new NextRequest(`http://localhost/api/tenants/${id}/access/${accessId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id, accessId }) }
  );
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  currentUser = { id: MANAGER_ID };
  roleRows = [{ role: "org_manager", scope_type: "org", scope_id: ORG_ID }];
  plugins = { "community-management": true, "tenant-app": true };
  tenantRow = { id: TENANT_ID, microgrid_id: MG_ID };
  microgridRow = { id: MG_ID, communities: { org_id: ORG_ID } };
  revokeResult = { data: true, error: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/tenants/[id]/access/[accessId]", () => {
  it.each([
    ["not-a-uuid", ACCESS_ID, "Invalid tenant ID — expected UUID"],
    [TENANT_ID, "not-a-uuid", "Invalid access ID — expected UUID"],
  ])("refuses %s / %s with 400", async (id, accessId, error) => {
    const out = await call(id, accessId);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("answers 204 with an empty body", async () => {
    for (const data of [true, false]) {
      revokeResult = { data, error: null };
      const out = await call();
      expect(out.status).toBe(204);
      expect(out.text).toBe("");
    }
    expect(rpcSpy).toHaveBeenCalledWith("fn_tenant_access_revoke", {
      _tenant_id: TENANT_ID,
      _access_id: ACCESS_ID,
    });
    expect(createServiceSpy).not.toHaveBeenCalled();
  });

  it("works while the tenant app is off", async () => {
    plugins["tenant-app"] = false;
    expect((await call()).status).toBe(204);
  });

  it("answers 404 for a unit the caller cannot read", async () => {
    tenantRow = null;
    const out = await call();
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "Tenant not found", code: "tenant_not_found" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("refuses a tenant-only caller, who reads their unit but not its microgrid", async () => {
    roleRows = [{ role: "tenant", scope_type: "tenant", scope_id: TENANT_ID }];
    microgridRow = null;
    const out = await call();
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("forbidden");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("refuses a tenant-only caller through the composer too", async () => {
    roleRows = [{ role: "tenant", scope_type: "tenant", scope_id: TENANT_ID }];
    const out = await call();
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("community_forbidden");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("refuses another organization's manager, and answers 409 while community management is off", async () => {
    roleRows = [{ role: "org_manager", scope_type: "org", scope_id: "7e560000-0000-4000-8000-000000000002" }];
    expect((await call()).status).toBe(403);
    roleRows = [{ role: "org_manager", scope_type: "org", scope_id: ORG_ID }];
    plugins["community-management"] = false;
    const off = await call();
    expect(off.status).toBe(409);
    expect(off.body.code).toBe("community_management_disabled");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "42501", message: "You do not have permission to manage access to this tenant." }, 403, "forbidden", "You do not have permission to manage access to this unit."],
    [{ code: "P0002", message: "This tenant has no such access." }, 404, "access_not_found", "This address no longer has access to this unit."],
    [{ code: "P0002", message: "Tenant not found." }, 404, "tenant_not_found", "Tenant not found"],
    [{ code: "XX000", message: "boom" }, 500, "tenant_access_failed", "Could not remove access. Retry the request."],
  ])("maps %j", async (error, status, code, copy) => {
    revokeResult = { data: null, error };
    const out = await call();
    expect(out.status).toBe(status);
    expect(out.body.code).toBe(code);
    expect(out.body.error).toBe(copy);
  });

  it("imports no service-role module", () => {
    const source = readFileSync(path.join(__dirname, "..", "route.ts"), "utf8");
    expect(source).not.toMatch(/@\/lib\/supabase\/service|createServiceClient/);
  });
});

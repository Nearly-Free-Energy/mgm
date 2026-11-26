import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { hostContext, installationRequest, surfaceRequest, tenantRequest, type HostContext } from "../access";
import { ORG_A, ORG_B, contextFor, fakeFmt, managerOf, superAdmin, tenantOf } from "./host-fakes";
import { BROWSER } from "@/lib/runtime/caller";

const deps = { newClient: vi.fn(), makeFmt: () => fakeFmt, caller: BROWSER };

describe("hostContext", () => {
  it("refuses a request with no user with 401", () => {
    expect(hostContext({ user: null, roles: [] }, new Headers(), deps)).toMatchObject({
      ok: false,
      status: 401,
      code: "gui_unauthenticated",
    });
  });

  it("refuses a user with no role rows with 403", () => {
    expect(hostContext({ user: { id: "u" } as User, roles: [] }, new Headers(), deps)).toMatchObject({
      ok: false,
      status: 403,
      code: "gui_no_access",
    });
  });

  it("takes the locale from Accept-Language and falls back to en on a tag Intl refuses", () => {
    const access = { user: { id: "u" } as User, roles: [managerOf(ORG_A)] };
    const lg = hostContext(access, new Headers({ "accept-language": "lg-UG,en;q=0.5" }), deps);
    const bad = hostContext(access, new Headers({ "accept-language": "not a tag!" }), deps);
    expect(lg.ok && lg.ctx.locale).toBe("lg-UG");
    expect(bad.ok && bad.ctx.locale).toBe("en");
  });

  it("gives a person whose rows are all tenant rows a context, which carries those rows only", () => {
    // RFC mgm#197 § 4: the host serves a tenant their own units; each staff
    // entry point refuses them by their roles (below, and in the files of
    // gate-state, organization, entities and view).
    const unit = "e7400000-0000-4000-8000-00000000000a";
    const made = hostContext({ user: { id: "u" } as User, roles: [tenantOf(unit)] }, new Headers(), deps);
    expect(made.ok && made.ctx.access.roles).toEqual([tenantOf(unit)]);
  });

  it("freezes the context, its access and a copy of the roles", () => {
    const roles = [managerOf(ORG_A)];
    const made = hostContext({ user: { id: "u" } as User, roles }, new Headers(), deps);
    if (!made.ok) throw new Error("refused");
    expect(Object.isFrozen(made.ctx)).toBe(true);
    expect(Object.isFrozen(made.ctx.access)).toBe(true);
    expect(Object.isFrozen(made.ctx.access.roles)).toBe(true);
    roles.push(superAdmin());
    expect(made.ctx.access.roles).toEqual([managerOf(ORG_A)]);
  });
});

describe("surfaceRequest and installationRequest", () => {
  it("give every call a new client from the factory", async () => {
    let n = 0;
    const newClient = vi.fn(async () => ({ n: ++n }) as unknown as SupabaseClient);
    const ctx = contextFor([managerOf(ORG_A)], newClient);
    const a = await surfaceRequest(ctx, ORG_A, {}, new URLSearchParams());
    const b = await surfaceRequest(ctx, ORG_A, {}, new URLSearchParams());
    const c = await installationRequest(ctx, {}, new URLSearchParams());
    expect(newClient).toHaveBeenCalledTimes(3);
    expect(new Set([a.supabase, b.supabase, c.supabase]).size).toBe(3);
    expect(a.organizationId).toBe(ORG_A);
    expect(c.organizationId).toBeNull();
  });

  it("carry the checked user, roles, params and locale, and drop ui.* parameters", async () => {
    const ctx = contextFor([managerOf(ORG_A)]);
    const req = await surfaceRequest(ctx, ORG_A, { id: "x" }, new URLSearchParams("day=2026-11-09&ui.tab=2"));
    expect(req.user).toBe(ctx.access.user);
    expect(req.roles).toEqual([managerOf(ORG_A)]);
    expect(req.params).toEqual({ id: "x" });
    expect(req.search.toString()).toBe("day=2026-11-09");
    expect(req.locale).toBe("en-UG");
    expect(req.fmt).toBe(fakeFmt);
  });

  it("refuse an organization the caller's roles do not reach", async () => {
    await expect(surfaceRequest(contextFor([managerOf(ORG_A)]), ORG_B, {}, new URLSearchParams())).rejects.toThrow(
      /cannot access/,
    );
    await expect(
      surfaceRequest(contextFor([superAdmin()]), ORG_B, {}, new URLSearchParams()),
    ).resolves.toMatchObject({ organizationId: ORG_B });
  });

  it("refuse a person whose rows are all tenant rows, before opening a client", async () => {
    const newClient = vi.fn(async () => ({}) as SupabaseClient);
    const ctx = contextFor([tenantOf("e7400000-0000-4000-8000-00000000000a")], newClient);
    await expect(surfaceRequest(ctx, ORG_A, {}, new URLSearchParams())).rejects.toThrow(/cannot access/);
    await expect(installationRequest(ctx, {}, new URLSearchParams())).rejects.toThrow(/no staff role/);
    expect(newClient).not.toHaveBeenCalled();
    // A tenant row beside a staff row takes nothing away.
    const both = contextFor([tenantOf("e7400000-0000-4000-8000-00000000000a"), managerOf(ORG_A)], newClient);
    await expect(installationRequest(both, {}, new URLSearchParams())).resolves.toMatchObject({ organizationId: null });
    await expect(surfaceRequest(both, ORG_A, {}, new URLSearchParams())).resolves.toMatchObject({ organizationId: ORG_A });
  });

  it("refuse a context hostContext did not issue", async () => {
    const forged = { ...contextFor([superAdmin()]) } as HostContext;
    await expect(installationRequest(forged, {}, new URLSearchParams())).rejects.toThrow(/did not issue/);
    await expect(surfaceRequest(forged, ORG_A, {}, new URLSearchParams())).rejects.toThrow(/did not issue/);
    const frozenCopy = Object.freeze({ ...contextFor([superAdmin()]) }) as HostContext;
    await expect(installationRequest(frozenCopy, {}, new URLSearchParams())).rejects.toThrow(/did not issue/);
  });
});

describe("tenantRequest", () => {
  const UNIT = "e7400000-0000-4000-8000-00000000000a";
  const OTHER_UNIT = "e7400000-0000-4000-8000-00000000000b";

  it("carries the unit, no organization and no params, on a new client, and drops ui.* parameters", async () => {
    const newClient = vi.fn(async () => ({}) as SupabaseClient);
    const ctx = contextFor([tenantOf(UNIT)], newClient);
    const req = await tenantRequest(ctx, UNIT, new URLSearchParams("month=2026-11&ui.tab=2"));
    expect(req).toMatchObject({ tenantId: UNIT, organizationId: null, params: {}, locale: "en-UG", fmt: fakeFmt });
    expect(req.search.toString()).toBe("month=2026-11");
    expect(req.supabase).toBe(await newClient.mock.results[0].value);
  });

  it("refuses a unit the caller holds no tenant row for, staff rows included", async () => {
    await expect(tenantRequest(contextFor([tenantOf(UNIT)]), OTHER_UNIT, new URLSearchParams())).rejects.toThrow(/does not hold/);
    await expect(tenantRequest(contextFor([superAdmin()]), UNIT, new URLSearchParams())).rejects.toThrow(/does not hold/);
    await expect(tenantRequest(contextFor([managerOf(ORG_A)]), UNIT, new URLSearchParams())).rejects.toThrow(/does not hold/);
  });

  it("refuses a context hostContext did not issue", async () => {
    const forged = { ...contextFor([tenantOf(UNIT)]) } as HostContext;
    await expect(tenantRequest(forged, UNIT, new URLSearchParams())).rejects.toThrow(/did not issue/);
  });
});

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { hostContext, installationRequest, surfaceRequest, type HostContext } from "../access";
import { ORG_A, ORG_B, contextFor, fakeFmt, managerOf, superAdmin } from "./host-fakes";

const deps = { newClient: vi.fn(), makeFmt: () => fakeFmt };

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

  it("refuse a context hostContext did not issue", async () => {
    const forged = { ...contextFor([superAdmin()]) } as HostContext;
    await expect(installationRequest(forged, {}, new URLSearchParams())).rejects.toThrow(/did not issue/);
    await expect(surfaceRequest(forged, ORG_A, {}, new URLSearchParams())).rejects.toThrow(/did not issue/);
    const frozenCopy = Object.freeze({ ...contextFor([superAdmin()]) }) as HostContext;
    await expect(installationRequest(frozenCopy, {}, new URLSearchParams())).rejects.toThrow(/did not issue/);
  });
});

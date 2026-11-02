/**
 * request-access.ts — the per-render user and role read for Server
 * Components.
 *
 * React `cache()` memoizes only inside a Server Component render, so here
 * (no render) every call reads again; these tests cover what each helper
 * reads and on which client, not the memo itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type RoleRow = {
  user_id: string;
  role: string;
  scope_type: string;
  scope_id: string | null;
};

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  roles: [] as RoleRow[],
  /** Tables read through the client createClient() returns. */
  accessCalls: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        state.accessCalls.push("auth.getUser");
        return { data: { user: state.user }, error: null };
      },
    },
    from: (table: string) => {
      state.accessCalls.push(table);
      return {
        select: () => ({
          eq: () => ({
            returns: async () => ({ data: state.roles, error: null }),
          }),
        }),
      };
    },
  }),
}));

import {
  getRequestUserAccess,
  requestUserCanAccessMicrogrid,
  requestUserIsSuperAdmin,
} from "../request-access";

/** The page's client: answers only the microgrid → org lookup. */
function pageClient(orgId: string | null): SupabaseClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    auth: {
      getUser: async () => {
        throw new Error("the page's client must not read the user");
      },
    },
    from: (table: string) => {
      calls.push(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: orgId ? { communities: { org_id: orgId } } : null,
              error: null,
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient & { calls: string[] };
}

const orgManager = (orgId: string): RoleRow => ({
  user_id: "u1",
  role: "org_manager",
  scope_type: "org",
  scope_id: orgId,
});
const superAdmin: RoleRow = {
  user_id: "u1",
  role: "super_admin",
  scope_type: "org",
  scope_id: null,
};

beforeEach(() => {
  state.user = { id: "u1" };
  state.roles = [];
  state.accessCalls = [];
});

describe("getRequestUserAccess", () => {
  it("reads the user and their role rows on a client of its own", async () => {
    state.roles = [orgManager("org-a")];
    const access = await getRequestUserAccess();
    expect(access.user?.id).toBe("u1");
    expect(access.roles).toEqual([orgManager("org-a")]);
    expect(state.accessCalls).toEqual(["auth.getUser", "user_roles"]);
  });

  it("returns no rows for a signed-out request", async () => {
    state.user = null;
    expect(await getRequestUserAccess()).toEqual({ user: null, roles: [] });
  });
});

describe("requestUserIsSuperAdmin", () => {
  it("is true only with a super_admin row", async () => {
    state.roles = [superAdmin];
    expect(await requestUserIsSuperAdmin()).toBe(true);
    state.roles = [orgManager("org-a")];
    expect(await requestUserIsSuperAdmin()).toBe(false);
  });
});

describe("requestUserCanAccessMicrogrid", () => {
  it("allows an org_manager of the microgrid's org, looking the org up on the page's client", async () => {
    state.roles = [orgManager("org-a")];
    const client = pageClient("org-a");
    expect(await requestUserCanAccessMicrogrid(client, "m1")).toBe(true);
    expect(client.calls).toEqual(["microgrids"]);
  });

  it("refuses an org_manager of another org", async () => {
    state.roles = [orgManager("org-a")];
    expect(await requestUserCanAccessMicrogrid(pageClient("org-b"), "m1")).toBe(false);
  });

  it("refuses when the microgrid is not found", async () => {
    state.roles = [orgManager("org-a")];
    expect(await requestUserCanAccessMicrogrid(pageClient(null), "m1")).toBe(false);
  });

  it("allows a super_admin whatever the lookup finds", async () => {
    state.roles = [superAdmin];
    expect(await requestUserCanAccessMicrogrid(pageClient(null), "m1")).toBe(true);
  });

  it("refuses a signed-out request", async () => {
    state.user = null;
    expect(await requestUserCanAccessMicrogrid(pageClient("org-a"), "m1")).toBe(false);
  });
});

/**
 * access.ts — unit tests for the server-only auth helpers (#76).
 *
 * All Supabase I/O is mocked. These cover the branch logic in
 *   - getCurrentUserRoles        (unauth → [] / auth → user_roles rows)
 *   - currentUserIsSuperAdmin    (super_admin detection)
 *   - currentUserCanAccessOrg    (super_admin short-circuit + scoped match)
 *   - currentUserCanAccessCommunity  (delegates via communities.org_id)
 *   - currentUserCanAccessMicrogrid  (delegates via microgrids → community → org)
 * and the round trips each check makes: one getUser, one user_roles read,
 * and at most one parent lookup.
 *
 * RLS enforcement is tested separately in `src/lib/supabase/__tests__/rls.test.ts`.
 */

import { describe, it, expect } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  getCurrentUserAccess,
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
  currentUserCanAccessCommunity,
  currentUserCanAccessMicrogrid,
  readMicrogridOrgId,
  rolesCanAccessMicrogrid,
  rolesCanAccessOrg,
  rolesIncludeSuperAdmin,
} from "../access";
import type { UserRoleRecord } from "@/lib/types/domain";

type RoleRow = {
  user_id: string;
  role: string;
  scope_type: string;
  scope_id: string | null;
};

/**
 * Builds a minimal mock SupabaseClient for these helpers. `roles` controls
 * what user_roles returns; `community` and `microgrid` control the parent
 * resolution queries. A microgrid row carries its community embedded, as
 * the `communities(org_id)` select returns it. `calls` counts the round
 * trips each helper makes.
 */
function makeMockClient(opts: {
  user: { id: string } | null;
  roles: RoleRow[];
  community?: { id: string; org_id: string } | null;
  microgrid?: {
    id: string;
    communities: { org_id: string } | { org_id: string }[] | null;
  } | null;
}): SupabaseClient & { calls: string[] } {
  const calls: string[] = [];
  const client = {
    calls,
    auth: {
      getUser: async () => {
        calls.push("auth.getUser");
        return {
          data: { user: opts.user },
          error: null,
        };
      },
    },
    from: (table: string) => {
      calls.push(table);
      if (table === "user_roles") {
        return {
          select: () => ({
            eq: () => ({
              returns: () =>
                Promise.resolve({ data: opts.roles, error: null }),
            }),
          }),
        };
      }
      if (table === "communities") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.community ?? null,
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "microgrids") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.microgrid ?? null,
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table in mock: ${table}`);
    },
  };
  return client as unknown as SupabaseClient & { calls: string[] };
}

describe("getCurrentUserRoles", () => {
  it("returns [] when there is no authenticated user", async () => {
    const client = makeMockClient({ user: null, roles: [] });
    const roles = await getCurrentUserRoles(client);
    expect(roles).toEqual([]);
  });

  it("returns the user's role rows when authenticated", async () => {
    const rows = [
      {
        user_id: "u1",
        role: "org_manager",
        scope_type: "org",
        scope_id: "org-a",
      },
    ];
    const client = makeMockClient({ user: { id: "u1" }, roles: rows });
    const roles = await getCurrentUserRoles(client);
    expect(roles).toHaveLength(1);
    expect(roles[0].role).toBe("org_manager");
  });
});

describe("currentUserIsSuperAdmin", () => {
  it("returns true for a super_admin", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
    });
    expect(await currentUserIsSuperAdmin(client)).toBe(true);
  });

  it("returns false for an org_manager", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
    });
    expect(await currentUserIsSuperAdmin(client)).toBe(false);
  });

  it("returns false for an unauthenticated user", async () => {
    const client = makeMockClient({ user: null, roles: [] });
    expect(await currentUserIsSuperAdmin(client)).toBe(false);
  });
});

describe("currentUserCanAccessOrg", () => {
  it("returns true for super_admin on any org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
    });
    expect(await currentUserCanAccessOrg(client, "org-x")).toBe(true);
  });

  it("returns true for org_manager scoped to the same org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
    });
    expect(await currentUserCanAccessOrg(client, "org-a")).toBe(true);
  });

  it("returns false for org_manager on a different org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
    });
    expect(await currentUserCanAccessOrg(client, "org-b")).toBe(false);
  });

  it("returns false for users with no roles", async () => {
    const client = makeMockClient({ user: { id: "u1" }, roles: [] });
    expect(await currentUserCanAccessOrg(client, "org-a")).toBe(false);
  });
});

describe("currentUserCanAccessCommunity", () => {
  it("delegates via communities.org_id → org access check", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      community: { id: "c1", org_id: "org-a" },
    });
    expect(await currentUserCanAccessCommunity(client, "c1")).toBe(true);
  });

  it("returns false when the community's org is not accessible", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      community: { id: "c2", org_id: "org-b" },
    });
    expect(await currentUserCanAccessCommunity(client, "c2")).toBe(false);
  });

  it("returns false when the community is not found", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      community: null,
    });
    expect(await currentUserCanAccessCommunity(client, "c-missing")).toBe(
      false
    );
  });

  it("reads the user, the role rows and the org once each for an org_manager", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      community: { id: "c1", org_id: "org-a" },
    });
    expect(await currentUserCanAccessCommunity(client, "c1")).toBe(true);
    expect([...client.calls].sort()).toEqual(
      ["auth.getUser", "communities", "user_roles"].sort()
    );
  });

  it("super_admin short-circuits without needing the community row", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
      community: null,
    });
    expect(await currentUserCanAccessCommunity(client, "anything")).toBe(true);
  });
});

describe("currentUserCanAccessMicrogrid", () => {
  it("delegates via microgrids → communities → org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: { id: "m1", communities: { org_id: "org-a" } },
    });
    expect(await currentUserCanAccessMicrogrid(client, "m1")).toBe(true);
  });

  it("returns false when the microgrid parent chain lands on a different org", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: { id: "m2", communities: { org_id: "org-b" } },
    });
    expect(await currentUserCanAccessMicrogrid(client, "m2")).toBe(false);
  });

  it("returns false when RLS hides the microgrid's community", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: { id: "m1", communities: null },
    });
    expect(await currentUserCanAccessMicrogrid(client, "m1")).toBe(false);
  });

  it("reads the user, the role rows and the org once each for an org_manager", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: { id: "m1", communities: { org_id: "org-a" } },
    });
    expect(await currentUserCanAccessMicrogrid(client, "m1")).toBe(true);
    expect([...client.calls].sort()).toEqual(
      ["auth.getUser", "microgrids", "user_roles"].sort()
    );
  });

  it("returns false without a lookup when there is no user", async () => {
    const client = makeMockClient({
      user: null,
      roles: [],
      microgrid: { id: "m1", communities: { org_id: "org-a" } },
    });
    expect(await currentUserCanAccessMicrogrid(client, "m1")).toBe(false);
    expect(client.calls).toEqual(["auth.getUser"]);
  });

  it("returns false when the microgrid is not found", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-a",
        },
      ],
      microgrid: null,
    });
    expect(await currentUserCanAccessMicrogrid(client, "missing")).toBe(false);
  });

  it("super_admin can access whatever the parent lookup finds", async () => {
    const client = makeMockClient({
      user: { id: "u1" },
      roles: [
        {
          user_id: "u1",
          role: "super_admin",
          scope_type: "org",
          scope_id: null,
        },
      ],
      microgrid: null,
    });
    expect(await currentUserCanAccessMicrogrid(client, "anything")).toBe(true);
  });
});

describe("getCurrentUserAccess / getCurrentUserRoles with a known user", () => {
  const rows: RoleRow[] = [
    { user_id: "u1", role: "org_manager", scope_type: "org", scope_id: "org-a" },
  ];

  it("returns the verified user and their rows from one getUser", async () => {
    const client = makeMockClient({ user: { id: "u1" }, roles: rows });
    const access = await getCurrentUserAccess(client);
    expect(access.user?.id).toBe("u1");
    expect(access.roles).toHaveLength(1);
    expect(client.calls).toEqual(["auth.getUser", "user_roles"]);
  });

  it("returns no user and no rows when unauthenticated, without a role read", async () => {
    const client = makeMockClient({ user: null, roles: rows });
    expect(await getCurrentUserAccess(client)).toEqual({ user: null, roles: [] });
    expect(client.calls).toEqual(["auth.getUser"]);
  });

  it("skips getUser when the caller passes the user it already read", async () => {
    const client = makeMockClient({ user: { id: "u1" }, roles: rows });
    expect(await getCurrentUserRoles(client, { id: "u1" } as User)).toHaveLength(1);
    expect(client.calls).toEqual(["user_roles"]);
  });

  it("returns [] without any read when the caller passes no user", async () => {
    const client = makeMockClient({ user: { id: "u1" }, roles: rows });
    expect(await getCurrentUserRoles(client, null)).toEqual([]);
    expect(client.calls).toEqual([]);
  });
});

describe("role-row predicates", () => {
  const row = (role: string, scopeId: string | null) =>
    ({ user_id: "u1", role, scope_type: "org", scope_id: scopeId }) as UserRoleRecord;

  it("rolesIncludeSuperAdmin", () => {
    expect(rolesIncludeSuperAdmin([row("super_admin", null)])).toBe(true);
    expect(rolesIncludeSuperAdmin([row("org_manager", "org-a")])).toBe(false);
    expect(rolesIncludeSuperAdmin([])).toBe(false);
  });

  it("rolesCanAccessOrg", () => {
    expect(rolesCanAccessOrg([row("super_admin", null)], "org-x")).toBe(true);
    expect(rolesCanAccessOrg([row("org_manager", "org-a")], "org-a")).toBe(true);
    expect(rolesCanAccessOrg([row("org_manager", "org-a")], "org-b")).toBe(false);
    expect(rolesCanAccessOrg([], "org-a")).toBe(false);
  });

  it("rolesCanAccessMicrogrid", () => {
    expect(rolesCanAccessMicrogrid([row("super_admin", null)], "org-x")).toBe(true);
    // A super_admin reaches a microgrid whose org lookup found nothing.
    expect(rolesCanAccessMicrogrid([row("super_admin", null)], null)).toBe(true);
    expect(rolesCanAccessMicrogrid([row("org_manager", "org-a")], "org-a")).toBe(true);
    expect(rolesCanAccessMicrogrid([row("org_manager", "org-a")], "org-b")).toBe(false);
    expect(rolesCanAccessMicrogrid([row("org_manager", "org-a")], null)).toBe(false);
    expect(rolesCanAccessMicrogrid([], "org-a")).toBe(false);
  });
});

describe("readMicrogridOrgId", () => {
  it("reads the org from the embedded community", async () => {
    const client = makeMockClient({
      user: null,
      roles: [],
      microgrid: { id: "m1", communities: { org_id: "org-a" } },
    });
    expect(await readMicrogridOrgId(client, "m1")).toBe("org-a");
    expect(client.calls).toEqual(["microgrids"]);
  });

  it("tolerates the embed arriving as a one-element array", async () => {
    const client = makeMockClient({
      user: null,
      roles: [],
      microgrid: { id: "m1", communities: [{ org_id: "org-a" }] },
    });
    expect(await readMicrogridOrgId(client, "m1")).toBe("org-a");
  });

  it("returns null when the microgrid is not found", async () => {
    const client = makeMockClient({ user: null, roles: [], microgrid: null });
    expect(await readMicrogridOrgId(client, "missing")).toBeNull();
  });
});

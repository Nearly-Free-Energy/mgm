/**
 * SidebarNav — the server half of the dashboard sidebar.
 *
 * Its super_admin check comes from the render's shared user and role read
 * (`getRequestUserAccess`), not a read of its own; its organization and
 * plugin rows load on their own client and can be started early by
 * `preloadSidebarNav`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarEntry } from "../sidebar-nav-links";

const mocks = vi.hoisted(() => ({
  getRequestUserAccess: vi.fn(),
  orgs: [] as { id: string }[],
  plugins: [] as { org_id: string; enabled: boolean }[],
  tables: [] as string[],
}));

vi.mock("@/lib/auth/request-access", () => ({
  getRequestUserAccess: mocks.getRequestUserAccess,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        throw new Error("SidebarNav must not read the user itself");
      },
    },
    from: (table: string) => {
      mocks.tables.push(table);
      if (table === "organizations") {
        return { select: async () => ({ data: mocks.orgs, error: null }) };
      }
      if (table === "mgm_plugins") {
        return {
          select: () => ({
            eq: async () => ({ data: mocks.plugins, error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));
vi.mock("../sidebar-nav-links", () => ({
  SidebarNavLinks: (props: { entries: SidebarEntry[] }) => props,
}));

import { preloadSidebarNav, SidebarNav } from "../sidebar-nav";

async function labels(): Promise<string[]> {
  const element = (await SidebarNav()) as unknown as {
    props: { entries: SidebarEntry[] };
  };
  return element.props.entries.map((entry) => entry.label);
}

const role = (r: string) => ({
  user_id: "u1",
  role: r,
  scope_type: "org",
  scope_id: r === "super_admin" ? null : "org-1",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgs = [{ id: "org-1" }];
  mocks.plugins = [];
  mocks.tables = [];
});

describe("SidebarNav", () => {
  it("shows Organizations to a super_admin", async () => {
    mocks.getRequestUserAccess.mockResolvedValue({ user: { id: "u1" }, roles: [role("super_admin")] });
    expect(await labels()).toEqual(["Dashboard", "Organizations", "Communities", "Microgrids", "Settings"]);
  });

  it("hides Organizations from an org_manager", async () => {
    mocks.getRequestUserAccess.mockResolvedValue({ user: { id: "u1" }, roles: [role("org_manager")] });
    expect(await labels()).toEqual(["Dashboard", "Communities", "Microgrids", "Settings"]);
  });

  it("hides community management when every visible org disabled it", async () => {
    mocks.getRequestUserAccess.mockResolvedValue({ user: { id: "u1" }, roles: [role("org_manager")] });
    mocks.plugins = [{ org_id: "org-1", enabled: false }];
    expect(await labels()).toEqual(["Dashboard", "Settings"]);
  });

  it("preloadSidebarNav starts the organization and plugin reads", async () => {
    preloadSidebarNav();
    await vi.waitFor(() => expect(mocks.tables).toEqual(["organizations", "mgm_plugins"]));
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
  });
});

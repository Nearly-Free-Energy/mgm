import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  from: vi.fn(),
  getUser: vi.fn(),
  organizationExists: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
}));
vi.mock("@/lib/mgm/organization-exists", () => ({
  organizationExists: mocks.organizationExists,
}));
vi.mock("../logout-button", () => ({ LogoutButton: () => null }));
vi.mock("../sidebar-nav", () => ({ SidebarNav: () => null }));
vi.mock("@/components/ui/navigation-progress", () => ({
  NavigationProgress: () => null,
}));

import DashboardLayout from "../layout";

function wire({ user, orgCount, roleCount }: {
  user: { id: string } | null;
  orgCount: number;
  roleCount: number;
}) {
  mocks.getUser.mockResolvedValue({ data: { user } });
  mocks.organizationExists.mockResolvedValue(orgCount > 0);
  mocks.from.mockImplementation((table: string) => {
    if (table === "organizations") {
      return {
        select: () => Promise.resolve({ data: [], error: null, count: orgCount }),
      };
    }
    if (table === "user_roles") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null, count: roleCount }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe("DashboardLayout first-run routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to /login", async () => {
    wire({ user: null, orgCount: 0, roleCount: 0 });
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/login"
    );
  });

  it("redirects the eligible first user to /setup before the role gate", async () => {
    wire({ user: { id: "user-1" }, orgCount: 0, roleCount: 0 });
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/setup"
    );
    expect(mocks.organizationExists).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalledWith("user_roles");
  });

  it("retains /no-access when RLS hides an existing org from an unassigned user", async () => {
    wire({ user: { id: "user-1" }, orgCount: 1, roleCount: 0 });
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/no-access"
    );
  });

  it("renders the dashboard for users with roles", async () => {
    wire({ user: { id: "user-1" }, orgCount: 1, roleCount: 1 });
    const tree = await DashboardLayout({ children: "child" });
    expect(tree).toBeTruthy();
  });
});

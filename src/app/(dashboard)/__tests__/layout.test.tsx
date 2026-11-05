import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  getRequestUserAccess: vi.fn(),
  organizationExists: vi.fn(),
  preloadSidebarNav: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/request-access", () => ({
  getRequestUserAccess: mocks.getRequestUserAccess,
}));
vi.mock("@/lib/mgm/organization-exists", () => ({
  organizationExists: mocks.organizationExists,
}));
vi.mock("../logout-button", () => ({ LogoutButton: () => null }));
vi.mock("../sidebar-nav", () => ({
  SidebarNav: () => null,
  preloadSidebarNav: mocks.preloadSidebarNav,
}));
vi.mock("@/components/ui/navigation-progress", () => ({
  NavigationProgress: () => null,
}));

import DashboardLayout from "../layout";

function wire({ user, orgCount, roleCount }: {
  user: { id: string } | null;
  orgCount: number;
  roleCount: number;
}) {
  mocks.getRequestUserAccess.mockResolvedValue({
    user,
    roles: user
      ? Array.from({ length: roleCount }, () => ({
          user_id: user.id,
          role: "org_manager",
          scope_type: "org",
          scope_id: "org-1",
        }))
      : [],
  });
  mocks.organizationExists.mockResolvedValue(orgCount > 0);
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

  it("redirects unauthenticated users to /login even when the organization check fails", async () => {
    wire({ user: null, orgCount: 0, roleCount: 0 });
    mocks.organizationExists.mockRejectedValue(new Error("unavailable"));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/login"
    );
  });

  it("surfaces a failed organization check for a signed-in user", async () => {
    wire({ user: { id: "user-1" }, orgCount: 0, roleCount: 1 });
    mocks.organizationExists.mockRejectedValue(new Error("unavailable"));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "unavailable"
    );
  });

  it("redirects the eligible first user to /setup before the role gate", async () => {
    // No organization and no roles: /setup wins over /no-access.
    wire({ user: { id: "user-1" }, orgCount: 0, roleCount: 0 });
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/setup"
    );
    expect(mocks.organizationExists).toHaveBeenCalledOnce();
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

  it("starts the organization check and the sidebar's reads before the user read resolves", async () => {
    let resolveAccess: (value: unknown) => void = () => {};
    mocks.getRequestUserAccess.mockReturnValue(
      new Promise((resolve) => {
        resolveAccess = resolve;
      })
    );
    mocks.organizationExists.mockResolvedValue(true);

    const rendering = DashboardLayout({ children: null });
    expect(mocks.preloadSidebarNav).toHaveBeenCalledOnce();
    expect(mocks.organizationExists).toHaveBeenCalledOnce();

    resolveAccess({
      user: { id: "user-1" },
      roles: [{ user_id: "user-1", role: "super_admin", scope_type: "org", scope_id: null }],
    });
    expect(await rendering).toBeTruthy();
  });
});

type Node = { type?: unknown; props?: { className?: string; children?: unknown } };

function childrenOf(node: Node): Node[] {
  const c = node.props?.children;
  if (c == null) return [];
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(
    (x): x is Node => typeof x === "object" && x !== null
  );
}

function findParentOf(node: Node, type: string): Node | null {
  const kids = childrenOf(node);
  if (kids.some((k) => k.type === type)) return node;
  for (const k of kids) {
    const found = findParentOf(k, type);
    if (found) return found;
  }
  return null;
}

describe("DashboardLayout content column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A flex item's default min-width is its content's width, so without
  // min-w-0 a wide table stretches the column (and the page) instead of
  // scrolling inside its own overflow-auto container.
  it("lets the content column shrink below its content's width", async () => {
    wire({ user: { id: "user-1" }, orgCount: 1, roleCount: 1 });
    const tree = (await DashboardLayout({ children: "child" })) as Node;
    const column = findParentOf(tree, "main");
    expect(column).not.toBeNull();
    const classes = (column!.props?.className ?? "").split(/\s+/);
    expect(classes).toContain("flex-1");
    expect(classes).toContain("min-w-0");
  });
});

/**
 * SettingsUsersPage server component tests.
 *
 * The page passes the user list RPC result to UsersPageClient. An RPC error
 * must reach the client as `loadFailed` (so it does not render the "No users
 * yet" empty state) and be logged server-side. A person whose rows are all
 * tenant rows (RFC mgm#197) is not staff: the page is not found for them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type React from "react";

const mockRpc = vi.fn();

// The page's first call keeps a tenant-only person to tenant pages; that is
// tested for every page in src/app/(gui)/__tests__/tenant-only-pages.test.tsx.
vi.mock("@/lib/gui/host/server/tenant-pages", () => ({ keepTenantOnlyToTenantPages: async () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: mockRpc,
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: "caller-1" } }, error: null }),
    },
  }),
}));

const getCurrentUserRoles = vi.fn();
const currentUserIsSuperAdmin = vi.fn();
vi.mock("@/lib/auth/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/access")>()),
  currentUserIsSuperAdmin: (...args: unknown[]) => currentUserIsSuperAdmin(...args),
  getCurrentUserRoles: (...args: unknown[]) => getCurrentUserRoles(...args),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
}));

const row = (role: string, scope_type: string, scope_id: string | null) => ({ user_id: "caller-1", role, scope_type, scope_id });
const SUPER_ADMIN_ROW = row("super_admin", "org", null);
const tenantRow = (id: string) => row("tenant", "tenant", id);

import SettingsUsersPage from "../page";
import type { UsersPageClientProps } from "../users-page-client";

async function renderPageProps(): Promise<UsersPageClientProps> {
  const element =
    (await SettingsUsersPage()) as React.ReactElement<UsersPageClientProps>;
  return element.props;
}

describe("SettingsUsersPage", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockRpc.mockReset();
    getCurrentUserRoles.mockReset().mockResolvedValue([SUPER_ADMIN_ROW]);
    currentUserIsSuperAdmin.mockReset().mockResolvedValue(true);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("marks the list as failed and logs the error when the RPC fails", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.fn_list_visible_users",
        details: null,
        hint: null,
      },
    });

    const props = await renderPageProps();

    expect(mockRpc).toHaveBeenCalledWith("fn_list_visible_users");
    expect(props.loadFailed).toBe(true);
    expect(props.rows).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleError.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({
      event: "settings_users.list_error",
      code: "PGRST202",
    });
  });

  it("passes the rows through and does not log when the RPC succeeds", async () => {
    mockRpc.mockResolvedValue({
      data: [
        { user_id: "user-1", email: "one@example.com" },
        { user_id: null, email: "orphan@example.com" },
      ],
      error: null,
    });

    const props = await renderPageProps();

    expect(props.loadFailed).toBe(false);
    expect(props.rows.map((r) => r.user_id)).toEqual(["user-1"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("is not found for a person whose rows are all tenant rows, before the list is read", async () => {
    getCurrentUserRoles.mockResolvedValue([tenantRow("unit-1"), tenantRow("unit-2")]);
    await expect(renderPageProps()).rejects.toThrow("not-found");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(currentUserIsSuperAdmin).not.toHaveBeenCalled();
  });

  it("counts only a manager's organization rows, not their tenant rows, as their scopes", async () => {
    currentUserIsSuperAdmin.mockResolvedValue(false);
    getCurrentUserRoles.mockResolvedValue([row("org_manager", "org", "org-1"), tenantRow("unit-1")]);
    mockRpc.mockResolvedValue({ data: [], error: null });
    const props = await renderPageProps();
    expect(props.callerRole).toBe("org_manager");
    expect(props.callerOrgIds).toEqual(["org-1"]);
  });
});

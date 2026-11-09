/**
 * SettingsUsersPage server component tests.
 *
 * The page passes the user list RPC result to UsersPageClient. An RPC error
 * must reach the client as `loadFailed` (so it does not render the "No users
 * yet" empty state) and be logged server-side.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type React from "react";

const mockRpc = vi.fn();

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

vi.mock("@/lib/auth/access", () => ({
  currentUserIsSuperAdmin: vi.fn().mockResolvedValue(true),
  getCurrentUserRoles: vi.fn().mockResolvedValue([]),
}));

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
});

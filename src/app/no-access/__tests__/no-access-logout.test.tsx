// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(async (): Promise<{ error: unknown }> => ({ error: null })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: mocks.signOut } }) }));

const clearAppBadge = vi.fn(async () => {});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
});

async function clickLogOut() {
  Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: clearAppBadge });
  const { NoAccessLogout } = await import("../no-access-logout");
  render(<NoAccessLogout />);
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/login"));
}

describe("NoAccessLogout", () => {
  it("clears the app badge once the session is gone", async () => {
    await clickLogOut();
    expect(clearAppBadge).toHaveBeenCalledOnce();
  });

  it("leaves the badge to /login when sign-out resolves an error", async () => {
    mocks.signOut.mockResolvedValueOnce({ error: { message: "Failed to fetch" } });
    await clickLogOut();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });
});

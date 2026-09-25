// @vitest-environment jsdom
/**
 * LoginPage tests (UX5d / #190 — link addition only).
 *
 * Coverage (per AC9 of #190):
 *   - "Forgot password?" link is visible and points to /forgot-password.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { replace, signInWithPassword } = vi.hoisted(() => ({
  replace: vi.fn(),
  signInWithPassword: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword,
    },
  }),
}));

describe("LoginPage", () => {
  it("renders a 'Forgot password?' link to /forgot-password", async () => {
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);

    const link = screen.getByRole("link", { name: /forgot password/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("/forgot-password");
  });

  it("redirects straight to /review after successful sign-in", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);
    fireEvent.submit(screen.getByRole("button", { name: /sign in/i }).closest("form")!);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/review"));
  });
});

// @vitest-environment jsdom
/**
 * LoginPage tests.
 *
 * Coverage:
 *   - "Forgot password?" link is visible and points to /forgot-password.
 *   - A successful sign-in goes to the management dashboard.
 *   - The sign-in button and the "Forgot password?" link are at least
 *     44 px tall, and the button's focus ring is offset on the card colour.
 *   - A sign-in error is announced to screen readers as an alert.
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

function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe("LoginPage", () => {
  it("renders a 'Forgot password?' link to /forgot-password", async () => {
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);

    const link = screen.getByRole("link", { name: /forgot password/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("/forgot-password");
  });

  it("redirects to the management dashboard after successful sign-in", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);
    fireEvent.submit(screen.getByRole("button", { name: /sign in/i }).closest("form")!);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  // min-h-11 is 44 px on Tailwind's default 0.25rem spacing step; if
  // --spacing is redefined in globals.css, revisit these class names.
  it("gives the sign-in button a 44 px minimum height and a focus ring offset on the card", async () => {
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);

    const button = classesOf(screen.getByRole("button", { name: /sign in/i }));
    expect(button).toContain("min-h-11");
    expect(button).toContain("focus:ring-offset-card");
    expect(button).not.toContain("focus:ring-offset-background");
  });

  it("gives the 'Forgot password?' link a 44 px minimum height with its text centred", async () => {
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);

    const link = classesOf(screen.getByRole("link", { name: /forgot password/i }));
    expect(link).toEqual(
      expect.arrayContaining(["inline-flex", "min-h-11", "items-center"]),
    );
  });

  it("announces a sign-in error as an alert", async () => {
    replace.mockClear();
    signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);

    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "someone@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "wrong" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /sign in/i }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Invalid login credentials");
    expect(replace).not.toHaveBeenCalledWith("/");
  });
});

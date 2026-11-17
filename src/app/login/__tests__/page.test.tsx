// @vitest-environment jsdom
/**
 * LoginPage tests: sign-in by email link (RFC #186). MGM has no passwords.
 *
 * Coverage:
 *   - No password field and no "Forgot password?" link.
 *   - The page asks for an address before sending.
 *   - The request carries the same-site return path from ?next= (#126).
 *   - After sending, it says to open the link on this device and offers a
 *     new email.
 *   - A refusal is announced to screen readers as an alert.
 *   - The button is at least 44 px tall, its focus ring offset on the card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function respond(...bodies: [number, unknown][]) {
  const fetchMock = vi.fn();
  for (const [status, body] of bodies) {
    fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const SENT = "If this address has access to MGM, a sign-in email is on its way.";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("LoginPage", () => {
  it("has no password field and no password reset link", async () => {
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /forgot password/i })).toBeNull();
    expect(screen.getByLabelText(/^email$/i)).toBeDefined();
  });

  it("asks for the address before sending a link", async () => {
    const fetchMock = respond();
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/email address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["/microgrids/m1/operations?date=2026-11-08", "/microgrids/m1/operations?date=2026-11-08"],
    [null, null],
  ])("sends the link request with next=%s, then offers a new email", async (next, expected) => {
    if (next) window.history.replaceState(null, "", `/login?next=${encodeURIComponent(next)}`);
    const fetchMock = respond([202, { message: SENT }], [202, { message: SENT }]);
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "someone@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));

    expect((await screen.findByRole("status")).textContent).toMatch(/on its way.*this device/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/sign-in-link",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "someone@example.com", next: expected }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /send a new email/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("announces a refusal as an alert", async () => {
    respond([429, { error: "Too many requests. Wait a minute and try again." }]);
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "someone@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/too many requests/i);
  });

  // min-h-11 is 44 px on Tailwind's default 0.25rem spacing step; if
  // --spacing is redefined in globals.css, revisit these class names.
  it("gives the button a 44 px minimum height and a focus ring offset on the card", async () => {
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);
    const button = classesOf(screen.getByRole("button", { name: /email me a sign-in link/i }));
    expect(button).toContain("min-h-11");
    expect(button).toContain("focus:ring-offset-card");
    expect(button).not.toContain("focus:ring-offset-background");
  });
});

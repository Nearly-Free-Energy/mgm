// @vitest-environment jsdom
/**
 * ConfirmSignInPage tests: where the sign-in email's link lands (RFC #186).
 *
 * Coverage:
 *   - Opening the page spends nothing; Continue verifies the token.
 *   - After a good token the page loads the return path in full (loadPage),
 *     the start page when ?next= is missing or not same-site. A client-side
 *     navigation into the (gui) group that the server answers with a
 *     redirect within it never settles, and the layout redirects a tenant
 *     from "/" to /my (see the comment in ../page.tsx).
 *   - A refused token shows the expired-link message and loads nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  loadPage: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { verifyOtp: mocks.verifyOtp } }),
}));

vi.mock("../load-page", () => ({ loadPage: mocks.loadPage }));

afterEach(() => {
  mocks.verifyOtp.mockReset();
  mocks.loadPage.mockReset();
  window.history.replaceState(null, "", "/");
});

async function openAt(search: string) {
  window.history.replaceState(null, "", `/auth/confirm${search}`);
  const { default: ConfirmSignInPage } = await import("../page");
  render(<ConfirmSignInPage />);
  return screen.findByRole("button", { name: "Continue" });
}

describe("ConfirmSignInPage", () => {
  it("verifies nothing until Continue is pressed", async () => {
    await openAt("?token_hash=abc");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });

  it.each([
    ["?token_hash=abc", "/"],
    ["?token_hash=abc&next=%2Fmicrogrids%2Fm1%2Foperations%3Fdate%3D2026-11-08", "/microgrids/m1/operations?date=2026-11-08"],
    ["?token_hash=abc&next=https%3A%2F%2Fexample.com%2F", "/"],
  ])("after a good token at %s, loads %s in full", async (search, expected) => {
    mocks.verifyOtp.mockResolvedValue({ error: null });
    const button = await openAt(search);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.loadPage).toHaveBeenCalledTimes(1));
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: "abc", type: "email" });
    expect(mocks.loadPage).toHaveBeenCalledWith(expected);
  });

  it("shows the expired-link message for a refused token and loads nothing", async () => {
    mocks.verifyOtp.mockResolvedValue({ error: { message: "expired" } });
    const button = await openAt("?token_hash=abc");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toMatch(/expired or was already used/);
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });
});

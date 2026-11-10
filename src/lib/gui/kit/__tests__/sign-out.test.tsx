import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KitRuntimeProvider } from "../../host/client/kit-runtime";
import { recordingRuntime } from "../../host/client/__tests__/kit-test-utils";
import { SIGN_OUT_FAILED, SignOut } from "../sign-out";

type SignOutResult = { error: { name: string; message: string; status?: number } | null };
const supabase = vi.hoisted(() => {
  const mocks = {
    loaded: vi.fn(),
    signOut: vi.fn<(options?: { scope: "global" | "local" | "others" }) => Promise<SignOutResult>>(async () => ({
      error: null,
    })),
  };
  const client = () => {
    mocks.loaded();
    return { createClient: () => ({ auth: { signOut: mocks.signOut } }) };
  };
  return { ...mocks, client };
});
vi.mock("@/lib/supabase/client", supabase.client);

/**
 * What @supabase/auth-js 2.99 resolves when the logout request cannot reach
 * the server or gets a 502, 503 or 504: an error, with the session kept.
 */
const offline: SignOutResult = { error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 } };

const assign = vi.fn();
const realLocation = window.location;
const ORG_VALUE = "mgm-org=00000000-0000-4000-8000-000000000001";

function renderSignOut() {
  Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
  document.cookie = `${ORG_VALUE}; Path=/`;
  render(<SignOut />);
  return screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement;
}

/** Waits for the failure to show, then checks that nothing was cleared and the button works again. */
async function expectStillHere(button: HTMLButtonElement) {
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SIGN_OUT_FAILED));
  // Shown in words on the page, not only to screen readers.
  expect(screen.getByRole("alert").className).toBe("text-caption text-destructive-fg");
  expect(assign).not.toHaveBeenCalled();
  expect(document.cookie).toContain(ORG_VALUE);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  supabase.signOut.mockReset();
  supabase.signOut.mockImplementation(async () => ({ error: null }));
  vi.doMock("@/lib/supabase/client", supabase.client);
  document.cookie = "mgm-org=; Max-Age=0; Path=/";
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("SignOut", () => {
  it("loads the Supabase client only on click, clears the organization cookie, then goes to /login", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
    document.cookie = `${ORG_VALUE}; Path=/`;
    render(<SignOut className="x" />);
    expect(supabase.loaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(supabase.loaded).toHaveBeenCalledOnce();
    expect(supabase.signOut).toHaveBeenCalledOnce();
    expect(supabase.signOut).toHaveBeenCalledWith();
    expect(document.cookie).not.toContain("mgm-org=");
  });

  it("keeps an empty live region beside the button until something goes wrong", () => {
    render(<SignOut />);
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");
    expect(region.className).toBe("sr-only");
    expect(screen.getByRole("button", { name: "Sign out" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("uses an injected runtime's sign-out instead", async () => {
    const signOut = vi.fn(async () => {});
    render(
      <KitRuntimeProvider runtime={recordingRuntime({ signOut })}>
        <SignOut />
      </KitRuntimeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(supabase.signOut).not.toHaveBeenCalled();
  });

  it("expires the cookie at Path=/, so it is cleared from every page", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
    const real = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    const written: string[] = [];
    vi.spyOn(document, "cookie", "set").mockImplementation((value: string) => {
      written.push(value);
      real.set!.call(document, value);
    });
    render(<SignOut />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(written).toEqual([expect.stringMatching(/^mgm-org=; Max-Age=0; Path=\/(;|$)/)]);
  });

  it("falls back to ending only this session when signing out everywhere resolves an error", async () => {
    supabase.signOut.mockResolvedValueOnce({ error: { name: "AuthApiError", message: "Internal error", status: 500 } });
    const button = renderSignOut();
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(supabase.signOut).toHaveBeenCalledTimes(2);
    expect(supabase.signOut).toHaveBeenLastCalledWith({ scope: "local" });
    expect(document.cookie).not.toContain("mgm-org=");
  });

  it("stays on the page, keeps the cookie and says so when both sign-outs resolve an error", async () => {
    supabase.signOut.mockResolvedValue(offline);
    const button = renderSignOut();
    fireEvent.click(button);
    await expectStillHere(button);
    expect(supabase.signOut.mock.calls).toEqual([[], [{ scope: "local" }]]);
  });

  it("stays on the page when both sign-outs throw", async () => {
    supabase.signOut.mockRejectedValue(new Error("unexpected"));
    const button = renderSignOut();
    fireEvent.click(button);
    await expectStillHere(button);
    expect(supabase.signOut).toHaveBeenCalledTimes(2);
  });

  it("stays on the page when the Supabase client fails to load", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/client", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    const { SignOut: Fresh } = await import("../sign-out");
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
    document.cookie = `${ORG_VALUE}; Path=/`;
    render(<Fresh />);
    const button = screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement;
    fireEvent.click(button);
    await expectStillHere(button);
    expect(supabase.signOut).not.toHaveBeenCalled();
  });

  it("leaves on a second try once the connection is back, and clears the message while trying", async () => {
    supabase.signOut.mockResolvedValueOnce(offline).mockResolvedValueOnce(offline);
    const button = renderSignOut();
    fireEvent.click(button);
    await expectStillHere(button);
    fireEvent.click(button);
    expect(screen.getByRole("alert").textContent).toBe("");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(document.cookie).not.toContain("mgm-org=");
  });

  it("is disabled while signing out, and enabled again with the message when it fails", async () => {
    let fail: (error: Error) => void = () => {};
    const signOut = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    render(
      <KitRuntimeProvider runtime={recordingRuntime({ signOut })}>
        <SignOut />
      </KitRuntimeProvider>,
    );
    const button = screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    // Focus is on the body, where a browser moves it from a focused button
    // that becomes disabled (fireEvent.click never focused it here).
    expect(document.activeElement).toBe(document.body);
    await act(async () => fail(new Error("offline")));
    expect(button.disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe(SIGN_OUT_FAILED);
    expect(document.activeElement).toBe(button);
  });

  it("leaves focus where the person moved it when sign-out fails", async () => {
    let fail: (error: Error) => void = () => {};
    const signOut = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    render(
      <KitRuntimeProvider runtime={recordingRuntime({ signOut })}>
        <SignOut />
        <input aria-label="elsewhere" />
      </KitRuntimeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const elsewhere = screen.getByRole("textbox", { name: "elsewhere" });
    act(() => elsewhere.focus());
    await act(async () => fail(new Error("offline")));
    expect(document.activeElement).toBe(elsewhere);
  });
});

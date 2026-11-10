import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KitRuntimeProvider } from "../../host/client/kit-runtime";
import { recordingRuntime } from "../../host/client/__tests__/kit-test-utils";
import { SignOut } from "../sign-out";

const supabase = vi.hoisted(() => ({ loaded: vi.fn(), signOut: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/supabase/client", () => {
  supabase.loaded();
  return { createClient: () => ({ auth: { signOut: supabase.signOut } }) };
});

const assign = vi.fn();
const realLocation = window.location;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("SignOut", () => {
  it("loads the Supabase client only on click, clears the organization cookie, then goes to /login", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
    document.cookie = "mgm-org=00000000-0000-4000-8000-000000000001; Path=/";
    render(<SignOut className="x" />);
    expect(supabase.loaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(supabase.loaded).toHaveBeenCalledOnce();
    expect(supabase.signOut).toHaveBeenCalledOnce();
    expect(document.cookie).not.toContain("mgm-org=");
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

  it("still clears the cookie and goes to /login when signing out fails", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
    supabase.signOut.mockRejectedValueOnce(new Error("offline"));
    document.cookie = "mgm-org=00000000-0000-4000-8000-000000000001; Path=/";
    render(<SignOut />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(document.cookie).not.toContain("mgm-org=");
  });

  it("is disabled while signing out, and enabled again when it fails", async () => {
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
    await act(async () => fail(new Error("offline")));
    expect(button.disabled).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAppBadge, setAppBadge } from "../app-badge";

type Badging = { setAppBadge?: unknown; clearAppBadge?: unknown };
const nav = navigator as Badging;

function install(api: Badging) {
  for (const [key, value] of Object.entries(api)) Object.defineProperty(navigator, key, { configurable: true, value });
}

afterEach(() => {
  delete nav.setAppBadge;
  delete nav.clearAppBadge;
});

describe("app badge", () => {
  it("does nothing, and throws nothing, where the Badging API is missing", () => {
    expect("setAppBadge" in navigator).toBe(false);
    expect(() => setAppBadge(3)).not.toThrow();
    expect(() => clearAppBadge()).not.toThrow();
  });

  it("sets the count, and clears the badge at zero or for a count that is no number", () => {
    const set = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    install({ setAppBadge: set, clearAppBadge: clear });
    setAppBadge(4);
    expect(set).toHaveBeenCalledWith(4);
    setAppBadge(0);
    setAppBadge(Number.NaN);
    setAppBadge(-1);
    expect(clear).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenCalledOnce();
  });

  it("clears with setAppBadge(0) where only setAppBadge exists", () => {
    const set = vi.fn(async () => {});
    install({ setAppBadge: set });
    clearAppBadge();
    expect(set).toHaveBeenCalledWith(0);
  });

  it("swallows a rejection and a synchronous throw", async () => {
    const rejected = vi.fn(() => Promise.reject(new DOMException("Not allowed", "NotAllowedError")));
    install({ setAppBadge: rejected, clearAppBadge: rejected });
    setAppBadge(2);
    clearAppBadge();
    await Promise.resolve();
    install({
      setAppBadge: () => {
        throw new TypeError("Illegal invocation");
      },
      clearAppBadge: () => {
        throw new TypeError("Illegal invocation");
      },
    });
    expect(() => setAppBadge(2)).not.toThrow();
    expect(() => clearAppBadge()).not.toThrow();
  });
});

describe("app badge after sign-out", () => {
  it("clears the badge on markSignedOut and sets it no more for the rest of the page's life", async () => {
    vi.resetModules();
    const fresh = await import("../app-badge");
    const set = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    install({ setAppBadge: set, clearAppBadge: clear });
    fresh.setAppBadge(2);
    expect(fresh.isSignedOut()).toBe(false);
    fresh.markSignedOut();
    expect(fresh.isSignedOut()).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    fresh.setAppBadge(5);
    expect(set.mock.calls).toEqual([[2]]);
    fresh.clearAppBadge();
    expect(clear).toHaveBeenCalledTimes(2);
  });
});

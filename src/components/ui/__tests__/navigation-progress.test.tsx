// @vitest-environment jsdom
/**
 * navigation-progress.test.tsx — tests for <NavigationProgress>.
 *
 * Covers:
 *   - hidden on mount (no flash on first load)
 *   - appears on mgm:navigation-start event with role="status"
 *   - hides after pathname settles, or after only the query changes
 *   - back and forward show it, unless only the hash changes
 *   - announceNavigationStart dispatches the window event
 *   - a hold stays up through URL changes until it settles, or 4s pass
 *   - isCurrentLocation compares path and query
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

let mockPathname = "/";
let mockSearch = "";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

import {
  NavigationProgress,
  announceNavigationHold,
  announceNavigationSettled,
  announceNavigationStart,
  isCurrentLocation,
  locationKey,
  MGM_NAVIGATION_START_EVENT,
} from "../navigation-progress";

beforeEach(() => {
  mockPathname = "/";
  mockSearch = "";
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("NavigationProgress", () => {
  it("is hidden on mount (no first-load flash)", () => {
    render(<NavigationProgress />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("appears when a navigation start is announced", () => {
    render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
  });

  it("announceNavigationStart dispatches the window event with href detail", () => {
    const seen: string[] = [];
    const listener = (e: Event) =>
      seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(MGM_NAVIGATION_START_EVENT, listener);
    announceNavigationStart("/communities");
    window.removeEventListener(MGM_NAVIGATION_START_EVENT, listener);
    expect(seen).toEqual(["/communities"]);
  });

  it("hides after the pathname settles", () => {
    vi.useFakeTimers();
    const { rerender } = render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();

    // Simulate the route settling: pathname changes → 350ms → hidden.
    mockPathname = "/microgrids";
    rerender(<NavigationProgress />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays visible while a slow navigation is still in flight (pr-374)", () => {
    vi.useFakeTimers();
    render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
    });
    // 1s passes with NO pathname change — the 350ms settle-hide must not
    // fire; only a real transition or the 4s safety may hide the bar.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    // And the 4s safety still applies when the route never settles.
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides once only the query changes (the next day on the same page)", () => {
    vi.useFakeTimers();
    mockPathname = "/microgrids/m1/operations";
    mockSearch = "date=2026-11-14";
    const { rerender } = render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids/m1/operations?date=2026-11-13");
    });
    // Still loading: the URL has not moved yet.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    mockSearch = "date=2026-11-13";
    rerender(<NavigationProgress />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("still hides when the URL changes twice within the settle delay", () => {
    vi.useFakeTimers();
    const { rerender } = render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
    });
    mockPathname = "/microgrids";
    rerender(<NavigationProgress />);
    // A GUI writing its own query right after the page arrives.
    mockSearch = "ui.row=a";
    rerender(<NavigationProgress />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows on back or forward to another URL, and hides when it commits", () => {
    vi.useFakeTimers();
    mockPathname = "/microgrids/m1/operations";
    mockSearch = "date=2026-11-13";
    const { rerender } = render(<NavigationProgress />);
    // The browser has already moved the address bar when popstate fires.
    window.history.replaceState(null, "", "/microgrids/m1/operations?date=2026-11-14");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    mockSearch = "date=2026-11-14";
    rerender(<NavigationProgress />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays up for a hold through the URL change until it settles (an organization switch's rebuild)", () => {
    vi.useFakeTimers();
    mockPathname = "/communities";
    mockSearch = "org=a";
    const { rerender } = render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/communities?org=b");
    });
    // The URL changes, and the manifest's rebuild for the new organization starts.
    mockSearch = "org=b";
    rerender(<NavigationProgress />);
    act(() => {
      announceNavigationHold();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    // A later URL change does not end the hold either.
    mockSearch = "org=b&ui.row=x";
    rerender(<NavigationProgress />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    act(() => {
      announceNavigationSettled();
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds the bar even when the hold arrives before the URL change commits", () => {
    vi.useFakeTimers();
    mockPathname = "/communities";
    const { rerender } = render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/communities?org=b");
      announceNavigationHold();
    });
    mockSearch = "org=b";
    rerender(<NavigationProgress />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
  });

  it("hides a hold that never settles after the 4s safety timeout", () => {
    vi.useFakeTimers();
    render(<NavigationProgress />);
    act(() => {
      announceNavigationHold();
    });
    act(() => {
      vi.advanceTimersByTime(3900);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves a navigation that is not a hold to its URL change when a settle arrives", () => {
    vi.useFakeTimers();
    render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
      announceNavigationSettled();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
  });

  it("does not show on back or forward between entries that differ only in their hash", () => {
    mockPathname = "/microgrids";
    render(<NavigationProgress />);
    window.history.replaceState(null, "", "/microgrids#main");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("isCurrentLocation", () => {
  it("compares path and query, in any spelling, and ignores the hash", () => {
    window.history.replaceState(null, "", "/microgrids/m1/operations?date=2026-11-14");
    expect(isCurrentLocation("/microgrids/m1/operations?date=2026-11-14")).toBe(true);
    expect(isCurrentLocation("/microgrids/m1/operations?date=2026-11-14#main")).toBe(true);
    expect(isCurrentLocation("/microgrids/m1/operations?date=2026-11-13")).toBe(false);
    expect(isCurrentLocation("/microgrids/m1/operations")).toBe(false);
    expect(isCurrentLocation("/microgrids/m1/billing?date=2026-11-14")).toBe(false);
    expect(isCurrentLocation("//elsewhere.example/microgrids/m1/operations?date=2026-11-14")).toBe(false);
  });

  it("compares with the shown page when it is given", () => {
    const here = locationKey("/microgrids", "?a=1&b=2");
    expect(isCurrentLocation("/microgrids?a=1&b=2", here)).toBe(true);
    expect(isCurrentLocation("/microgrids?a=2", here)).toBe(false);
    expect(locationKey("/x", "")).toBe("/x");
  });
});

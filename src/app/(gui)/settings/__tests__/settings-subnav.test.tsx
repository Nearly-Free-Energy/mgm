// @vitest-environment jsdom
/**
 * SettingsSubNav tests.
 *
 * Covers:
 *   - Tabs render through next/link, so switching tabs is a client-side
 *     navigation instead of a full document reload, and keep their tab
 *     semantics (aria-controls, roving tabindex).
 *   - Clicks and arrow keys announce the navigation to NavigationProgress.
 *   - Every tab opens a released page, and the bar scrolls sideways inside
 *     its own width on a narrow screen instead of widening the page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MGM_NAVIGATION_START_EVENT } from "@/components/ui/navigation-progress";
import { isReleasedRoute } from "@/lib/mgm/released-routes";

let mockPathname = "/settings/profile";
const routerPushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: routerPushMock }),
}));

// Stand-in for next/link that marks its anchor, so the tests can tell a Link
// from a raw <a>, and stops jsdom from attempting a real navigation.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
    [key: string]: unknown;
  }) => (
    <a
      href={href}
      data-next-link=""
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

import { SettingsSubNav } from "../settings-subnav";

let announced: string[];
const onNavigationStart = (e: Event) =>
  announced.push((e as CustomEvent<string>).detail);

beforeEach(() => {
  announced = [];
  routerPushMock.mockClear();
  window.addEventListener(MGM_NAVIGATION_START_EVENT, onNavigationStart);
});

afterEach(() => {
  window.removeEventListener(MGM_NAVIGATION_START_EVENT, onNavigationStart);
});

describe("SettingsSubNav", () => {
  it("renders every tab as a client-side Link that keeps its tab semantics", () => {
    mockPathname = "/settings/users";
    render(<SettingsSubNav />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      "/settings/profile",
      "/settings/users",
      "/settings/plugins",
    ]);
    for (const t of tabs) {
      expect(t.hasAttribute("data-next-link")).toBe(true);
      expect(t.getAttribute("aria-controls")).toBe("settings-panel");
    }
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1",
    ]);
  });

  it("links only to released settings pages", () => {
    mockPathname = "/settings/profile";
    render(<SettingsSubNav />);
    const unreleased = screen
      .getAllByRole("tab")
      .map((t) => t.getAttribute("href") ?? "")
      .filter((href) => !isReleasedRoute(href));
    expect(unreleased).toEqual([]);
  });

  it("scrolls sideways inside its own width on a narrow screen", () => {
    mockPathname = "/settings/profile";
    render(<SettingsSubNav />);
    const bar = screen.getByRole("tablist").className.split(/\s+/);
    expect(bar).toEqual(expect.arrayContaining(["max-w-full", "overflow-x-auto"]));
    for (const t of screen.getAllByRole("tab")) {
      expect(t.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["shrink-0", "whitespace-nowrap"])
      );
    }
  });

  it("announces the navigation when a tab is clicked", () => {
    mockPathname = "/settings/profile";
    render(<SettingsSubNav />);
    fireEvent.click(screen.getByRole("tab", { name: "Plugins" }));
    expect(announced).toEqual(["/settings/plugins"]);
  });

  it("ArrowLeft wraps to the last tab and announces it", () => {
    mockPathname = "/settings/profile";
    render(<SettingsSubNav />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Profile" }), {
      key: "ArrowLeft",
    });
    expect(routerPushMock).toHaveBeenCalledWith("/settings/plugins");
    expect(announced).toEqual(["/settings/plugins"]);
  });
});

// @vitest-environment jsdom
/**
 * SetupSubNav tests.
 *
 * Covers:
 *   - Tabs render through next/link, so switching tabs is a client-side
 *     navigation instead of a full document reload.
 *   - Longest-prefix active tab on nested routes.
 *   - Clicks and arrow keys announce the navigation to NavigationProgress.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MGM_NAVIGATION_START_EVENT } from "@/components/ui/navigation-progress";

let mockPathname = "/microgrids/mg-1/setup/edges";
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

import { SetupSubNav } from "../setup-subnav";

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

describe("SetupSubNav", () => {
  it("renders every tab as a client-side Link to its sub-route", () => {
    render(<SetupSubNav microgridId="mg-1" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      "/microgrids/mg-1/setup/edges",
      "/microgrids/mg-1/setup/households",
      "/microgrids/mg-1/setup/openems-backend",
      "/microgrids/mg-1/setup/rates",
    ]);
    for (const t of tabs) expect(t.hasAttribute("data-next-link")).toBe(true);
  });

  it.each([
    ["/microgrids/mg-1/setup/edges/edge-1", /edges/i],
    ["/microgrids/mg-1/setup/households/hh-1", /households/i],
  ])("keeps the parent tab selected on %s", (pathname, name) => {
    mockPathname = pathname;
    render(<SetupSubNav microgridId="mg-1" />);
    const selected = screen.getByRole("tab", { name });
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.getAttribute("tabindex")).toBe("0");
  });

  it("announces the navigation when a tab is clicked", () => {
    mockPathname = "/microgrids/mg-1/setup/edges";
    render(<SetupSubNav microgridId="mg-1" />);
    fireEvent.click(screen.getByRole("tab", { name: /households/i }));
    expect(announced).toEqual(["/microgrids/mg-1/setup/households"]);
  });

  it("ArrowRight moves to the next tab and announces it", () => {
    mockPathname = "/microgrids/mg-1/setup/edges";
    render(<SetupSubNav microgridId="mg-1" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /edges/i }), {
      key: "ArrowRight",
    });
    expect(routerPushMock).toHaveBeenCalledWith(
      "/microgrids/mg-1/setup/households",
    );
    expect(announced).toEqual(["/microgrids/mg-1/setup/households"]);
  });

  it("Home on the first tab does not announce a navigation to the same page", () => {
    mockPathname = "/microgrids/mg-1/setup/edges";
    render(<SetupSubNav microgridId="mg-1" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /edges/i }), {
      key: "Home",
    });
    expect(announced).toEqual([]);
  });

  it("scrolls sideways inside its own width on a narrow screen", () => {
    render(<SetupSubNav microgridId="mg-1" />);
    const bar = screen.getByRole("tablist").className.split(/\s+/);
    expect(bar).toEqual(expect.arrayContaining(["max-w-full", "overflow-x-auto"]));
    for (const t of screen.getAllByRole("tab")) {
      expect(t.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["shrink-0", "whitespace-nowrap"])
      );
    }
  });
});

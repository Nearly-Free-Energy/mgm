// @vitest-environment jsdom
/**
 * TabNav tests.
 *
 * Covers:
 *   - Tabs render through next/link, so a click is a client-side navigation
 *     instead of a full document reload.
 *   - Each tab links to the page a click lands on, not to a URL that
 *     redirects (/microgrids/<id> → Operations, /setup → Edges).
 *   - The highlighted tab for every sub-route, including Operations, whose
 *     ?date= query is not part of the pathname usePathname() returns.
 *   - A click announces the navigation to NavigationProgress, except on the
 *     page the user is already on and on a click that opens a new tab.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MGM_NAVIGATION_START_EVENT } from "@/components/ui/navigation-progress";

let mockPathname = "/microgrids/mg-1/billing";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
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

import { TabNav } from "../tab-nav";

const TAB_NAMES = ["Operations", "Billing", "Setup"];

let announced: string[];
const onNavigationStart = (e: Event) =>
  announced.push((e as CustomEvent<string>).detail);

beforeEach(() => {
  announced = [];
  window.addEventListener(MGM_NAVIGATION_START_EVENT, onNavigationStart);
});

afterEach(() => {
  window.removeEventListener(MGM_NAVIGATION_START_EVENT, onNavigationStart);
});

function tab(name: string) {
  return screen.getByRole("tab", { name });
}

describe("TabNav", () => {
  it("renders the tabs in workflow order", () => {
    render(<TabNav microgridId="mg-1" />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(TAB_NAMES);
  });

  it("renders every tab as a client-side Link", () => {
    render(<TabNav microgridId="mg-1" />);
    for (const name of TAB_NAMES) {
      expect(tab(name).hasAttribute("data-next-link")).toBe(true);
    }
  });

  it("links each tab to the page a click lands on, skipping redirects", () => {
    render(<TabNav microgridId="mg-1" />);
    expect(tab("Operations").getAttribute("href")).toBe(
      "/microgrids/mg-1/operations",
    );
    expect(tab("Billing").getAttribute("href")).toBe("/microgrids/mg-1/billing");
    expect(tab("Setup").getAttribute("href")).toBe("/microgrids/mg-1/setup/edges");
  });

  it.each([
    // usePathname() never includes the query, so /operations?date=… arrives
    // as the bare path and must still highlight Operations.
    ["/microgrids/mg-1/operations", "Operations"],
    ["/microgrids/mg-1/billing", "Billing"],
    ["/microgrids/mg-1/billing/p-1", "Billing"],
    ["/microgrids/mg-1/billing/p-1/history", "Billing"],
    ["/microgrids/mg-1/setup/edges", "Setup"],
    ["/microgrids/mg-1/setup/edges/edge-1", "Setup"],
    ["/microgrids/mg-1/setup/households", "Setup"],
    ["/microgrids/mg-1/setup/households/hh-1", "Setup"],
    ["/microgrids/mg-1/setup/rates", "Setup"],
  ])("on %s highlights only %s", (pathname, selected) => {
    mockPathname = pathname;
    render(<TabNav microgridId="mg-1" />);
    for (const name of TAB_NAMES) {
      expect(tab(name).getAttribute("aria-selected")).toBe(
        String(name === selected),
      );
    }
  });

  // The microgrid index never renders (middleware redirects it to
  // Operations), and no tab claims it or a page outside the tabs.
  it.each(["/microgrids/mg-1", "/microgrids/mg-1/", "/microgrids/mg-1/tenants"])(
    "highlights nothing on %s",
    (pathname) => {
      mockPathname = pathname;
      render(<TabNav microgridId="mg-1" />);
      for (const name of TAB_NAMES) {
        expect(tab(name).getAttribute("aria-selected")).toBe("false");
      }
    },
  );

  it("announces the navigation to Operations from another tab", () => {
    mockPathname = "/microgrids/mg-1/billing";
    render(<TabNav microgridId="mg-1" />);
    fireEvent.click(tab("Operations"));
    expect(announced).toEqual(["/microgrids/mg-1/operations"]);
  });

  it("does not announce a click on Operations while it is shown", () => {
    mockPathname = "/microgrids/mg-1/operations";
    render(<TabNav microgridId="mg-1" />);
    fireEvent.click(tab("Operations"));
    expect(announced).toEqual([]);
  });

  it("announces the navigation when a tab leads somewhere else", () => {
    mockPathname = "/microgrids/mg-1/billing";
    render(<TabNav microgridId="mg-1" />);
    fireEvent.click(tab("Setup"));
    expect(announced).toEqual(["/microgrids/mg-1/setup/edges"]);
  });

  it("does not announce a click on the page already shown", () => {
    mockPathname = "/microgrids/mg-1/billing";
    render(<TabNav microgridId="mg-1" />);
    fireEvent.click(tab("Billing"));
    expect(announced).toEqual([]);
  });

  it("does not announce a click that opens a new tab or window", () => {
    mockPathname = "/microgrids/mg-1/billing";
    render(<TabNav microgridId="mg-1" />);
    fireEvent.click(tab("Setup"), { metaKey: true });
    fireEvent.click(tab("Setup"), { ctrlKey: true });
    fireEvent.click(tab("Setup"), { shiftKey: true });
    fireEvent.click(tab("Setup"), { button: 1 });
    expect(announced).toEqual([]);
  });

  it("scrolls sideways on a narrow screen instead of widening the page", () => {
    render(<TabNav microgridId="mg-1" />);
    expect(screen.getByRole("tablist").className.split(/\s+/)).toContain("overflow-x-auto");
    for (const t of screen.getAllByRole("tab")) {
      expect(t.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["shrink-0", "whitespace-nowrap"])
      );
    }
  });
});

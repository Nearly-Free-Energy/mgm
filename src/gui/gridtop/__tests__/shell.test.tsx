import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderShell, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import type { EntityRef, Icon, InitialView, NavEntry, NavGroup } from "@/lib/gui/contract";
import { GridtopGui } from "..";

const nav = (id: NavEntry["id"], title: string, group: NavGroup, order: number, href: NavEntry["href"], icon = "sites"): NavEntry => ({
  id,
  title,
  icon: icon as Icon,
  group,
  order,
  href,
  needs: [...href.matchAll(/\[(\w+)\]/g)].map((m) => m[1] as NavEntry["needs"][number]),
  legacy: true,
});

// The legacy entries, with the kind-named hrefs the manifest builder writes.
const NAV: NavEntry[] = [
  nav("org.today", "Dashboard", "operate", 10, "/", "today"),
  nav("community.microgrids", "Microgrids", "operate", 20, "/microgrids"),
  nav("community.communities", "Communities", "operate", 30, "/communities", "communities"),
  nav("metering.operations", "Operations", "operate", 40, "/microgrids/[microgrid]/operations", "live"),
  nav("metering.devices", "Edges & Devices", "operate", 60, "/microgrids/[microgrid]/setup/edges", "devices"),
  nav("billing.periods", "Billing", "money", 10, "/microgrids/[microgrid]/billing", "billing"),
  nav("billing.tariff", "Rate Schedule", "configure", 10, "/microgrids/[microgrid]/setup/rates", "tariff"),
  nav("billing.invoice-branding", "Invoice branding", "configure", 30, "/communities/[community]/invoice", "branding"),
  nav("org.users", "Users", "system", 20, "/settings/users", "users"),
  nav("org.organizations", "Organizations", "system", 40, "/organizations", "organizations"),
];

const ORG: EntityRef = { kind: "organization", id: "o1", label: "Org One", href: "/organizations/o1" };
const COMMUNITY: EntityRef = { kind: "community", id: "c1", label: "Kasana", href: "/communities/c1" };
const site = (id: string, label: string) => ({ kind: "microgrid" as const, id, label, href: `/microgrids/${id}` as const, parent: "c1" });
const [M1, M2] = [site("m1", "East"), site("m2", "West")];

function fixture(over: { nav?: NavEntry[]; sites?: number; pathname?: string; initial?: Partial<InitialView> } = {}): ManifestFixture {
  return {
    name: "shell",
    pathname: over.pathname ?? "/",
    manifest: {
      type: "manifest",
      contract: "0.1.0",
      release: null,
      locale: "en",
      now: "2026-11-10T12:00:00.000Z",
      gui: "gridtop",
      user: { name: "Ann", email: "ann@example.test" },
      org: {
        id: "o1",
        name: "Org One",
        href: "/organizations/o1",
        timezone: null,
        nav: over.nav ?? [...NAV].reverse(),
        status: [],
        places: [COMMUNITY, M1, M2].slice(0, 1 + (over.sites ?? 2)),
      },
      orgs: [{ id: "o1", name: "Org One", href: "/organizations/o1" }],
    },
    initial: { view: null, title: "Dashboard", trail: [], tabs: [], scope: { organization: ORG }, ...over.initial },
  };
}

let rendered: Rendered | null = null;
async function shell(f: ManifestFixture) {
  rendered = await renderShell(GridtopGui, f, <p>The page</p>);
  const [dock, bottom] = screen.getAllByRole("navigation", { name: "Apps" });
  return { dock, bottom, log: rendered.log, goTo: rendered.goTo };
}
afterEach(() => rendered?.unmount());

const titles = (links: HTMLElement[]) => links.map((link) => link.textContent);
const current = (root: HTMLElement) => titles(within(root).queryAllByRole("link", { current: "page" }));
// Class names are written whole, with gt:, because Gridtop's stylesheet build
// reads this file too, and a bare name would be a utility globals.css emits.
const tokens = (el: Element) => [...el.classList];
/** 44 px or more on a touch screen: a height, min-height, size or line height of 11 or more, coarse-only or always. */
const TALL = /^gt:(?:pointer-coarse:)?(?:min-h|h|size|leading)-(\d+)$/;
const tall = (el: Element) => tokens(el).some((t) => Number(TALL.exec(t)?.[1] ?? 0) >= 11);
const BOX = new Set(["gt:block", "gt:inline-block", "gt:flex", "gt:inline-flex", "gt:grid"]);

describe("Gridtop's shell", () => {
  it("lists the groups in order and each group's entries by order", async () => {
    const { dock } = await shell(fixture({ sites: 1 }));
    const groups = within(dock).getAllByRole("list").filter((list) => list.hasAttribute("aria-labelledby"));
    expect(groups.map((g) => g.getAttribute("aria-labelledby") && document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent))
      .toEqual(["Operate", "Money", "Configure", "System"]);
    expect(titles(within(groups[0]).getAllByRole("link"))).toEqual(["Dashboard", "Microgrids", "Communities", "Operations", "Edges & Devices"]);
  });

  it.each([
    ["/", {}, "Dashboard", true],
    ["/microgrids/m1/setup/edges/e9", { microgrid: M1, community: COMMUNITY }, "Edges & Devices", false],
    ["/microgrids/m1/billing/p4/history", { microgrid: M1, community: COMMUNITY }, "Billing", true],
    ["/communities/c1/payment", { community: COMMUNITY }, "Communities", false],
    // Two microgrids and none in scope: the apps that need one link here too, but are not this page.
    ["/microgrids", {}, "Microgrids", false],
    ["/settings/profile", {}, null, false],
  ])("marks the current app of %s, and only that app", async (pathname, scope, app, isPinned) => {
    // The scope is what legacyView resolves for the path (legacy-view.test.ts).
    const { dock, bottom } = await shell(fixture({ pathname, initial: { scope: { organization: ORG, ...scope } } }));
    expect(current(dock)).toEqual(app ? [app] : []);
    expect(current(bottom)).toEqual(app && isPinned ? [app] : []);
  });

  it("marks the app with the longest matching href, whatever the manifest's order", async () => {
    const at = { pathname: "/microgrids/m1/operations", initial: { scope: { organization: ORG, microgrid: M1 } } };
    const { dock } = await shell(fixture({ ...at, sites: 1, nav: NAV }));
    expect(current(dock)).toEqual(["Operations"]);
  });

  it("marks the last crumb of the trail as the current page", async () => {
    const trail = [
      { label: "Org One", href: "/organizations/o1" as const },
      { label: "East", href: "/microgrids/m1" as const },
      { label: "Billing", href: "/microgrids/m1/billing" as const },
    ];
    await shell(fixture({ pathname: "/microgrids/m1/billing", initial: { trail, scope: { organization: ORG, microgrid: M1 } } }));
    const here = screen.getByRole("navigation", { name: "You are here" });
    expect(titles(within(here).getAllByRole("link"))).toEqual(["Org One", "East", "Billing"]);
    expect(current(here)).toEqual(["Billing"]);
    // Below 600 px only the last crumb shows.
    const items = within(here).getAllByRole("listitem");
    for (const item of items.slice(0, -1)) expect(tokens(item)).toEqual(expect.arrayContaining(["gt:hidden", "gt:medium:flex"]));
    expect(tokens(items[items.length - 1])).toContain("gt:flex");
    expect(tokens(items[items.length - 1])).not.toContain("gt:hidden");
  });

  it("links the mark to the dashboard", async () => {
    await shell(fixture());
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/");
  });

  it("links an app that needs a microgrid straight to the only one", async () => {
    const { dock } = await shell(fixture({ sites: 1 }));
    expect(within(dock).getByRole("link", { name: "Operations" }).getAttribute("href")).toBe("/microgrids/m1/operations");
  });

  it("links an app that needs a microgrid to the list of microgrids while there are several", async () => {
    const { dock } = await shell(fixture());
    expect(within(dock).getByRole("link", { name: "Operations, choose a microgrid" }).getAttribute("href")).toBe("/microgrids");
  });

  it("shows Organizations only when the manifest lists it", async () => {
    const { dock } = await shell(fixture({ nav: NAV.filter((e) => e.id !== "org.organizations") }));
    expect(within(dock).queryByRole("link", { name: "Organizations" })).toBeNull();
    rendered!.unmount();
    const again = await shell(fixture());
    expect(within(again.dock).getByRole("link", { name: "Organizations" })).toBeTruthy();
  });

  it("signs out through the kit", async () => {
    const { log } = await shell(fixture());
    await act(async () => fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Sign out" })));
    expect(log.signOut).toBe(1);
  });

  it("has its landmarks, one main that is the skip link's target, and no tabs", async () => {
    const { dock, bottom } = await shell(fixture());
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.classList).toContain("gt:min-w-0");
    // The page scrolls inside main, and the skip link can move focus into it.
    expect(main.classList).toContain("gt:overflow-y-auto");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    // One Apps nav is shown at a time: the dock from 600 px, the bottom dock below.
    expect(dock.className).toMatch(/(^| )gt:hidden( |$)/);
    expect(dock.className).toContain("gt:medium:block");
    expect(bottom.className).toContain("gt:medium:hidden");
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect([...document.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0)).toEqual([]);
  });

  it("pins three apps to the bottom dock, then More", async () => {
    const { bottom } = await shell(fixture());
    const items = within(bottom).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Dashboard", "Operations, choose a microgrid", "Billing, choose a microgrid", "More"]);
  });

  it("puts the next app in group order in place of a pinned app that is absent", async () => {
    const { bottom } = await shell(fixture({ sites: 1, nav: NAV.filter((e) => !e.id.startsWith("billing.")) }));
    expect(within(bottom).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Dashboard", "Operations", "Microgrids", "More"]);
  });

  it("uses each replacement once when two pinned apps are absent", async () => {
    const { bottom } = await shell(fixture({ sites: 1, nav: NAV.filter((e) => !/^(billing|metering)\./.test(e.id)) }));
    expect(within(bottom).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Dashboard", "Microgrids", "Communities", "More"]);
  });

  it("opens every group from More, and closes them on Escape", async () => {
    const { bottom } = await shell(fixture({ sites: 1 }));
    const more = within(bottom).getByRole("button", { name: "More" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(bottom).getByRole("link", { name: "Invoice branding" }).getAttribute("href")).toBe("/communities/c1/invoice");
    fireEvent.keyDown(more, { key: "Escape" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(bottom).queryByRole("link", { name: "Invoice branding" })).toBeNull();
  });

  it("puts the More panel after More in tab order, and Escape inside it returns focus to More", async () => {
    const { bottom } = await shell(fixture({ sites: 1 }));
    const more = within(bottom).getByRole("button", { name: "More" });
    fireEvent.click(more);
    const link = within(bottom).getByRole("link", { name: "Invoice branding" });
    expect(more.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => link.focus());
    fireEvent.keyDown(link, { key: "Escape" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });

  it("closes the More panel when the page changes", async () => {
    const { bottom, goTo } = await shell(fixture({ sites: 1 }));
    const more = within(bottom).getByRole("button", { name: "More" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    await goTo("/communities/c1/invoice");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(bottom).queryByRole("link", { name: "Invoice branding" })).toBeNull();
  });

  it("gives every link and button a 44 px target on touch screens", async () => {
    const trail = [
      { label: "Org One", href: "/organizations/o1" as const },
      { label: "East", href: "/microgrids/m1" as const },
    ];
    const { bottom } = await shell(fixture({ initial: { trail } }));
    fireEvent.click(within(bottom).getByRole("button", { name: "More" }));
    // The skip link shows only on focus, over the page.
    const controls = [...document.querySelectorAll("a, button")].filter((el) => !tokens(el).includes("gt:sr-only"));
    expect(controls.length).toBeGreaterThan(20);
    expect(controls.filter((el) => !tall(el)).map((el) => el.textContent)).toEqual([]);
    // Height and min-height size a link only as a box.
    const links = controls.filter((el) => el.tagName === "A");
    expect(links.filter((el) => !tokens(el).some((t) => BOX.has(t))).map((el) => el.textContent)).toEqual([]);
  });

  it("keeps the label of an entry whose icon it does not know in view", async () => {
    const tickets = nav("acme.tickets", "Tickets", "operate", 90, "/settings/tickets", "ticket");
    const { dock } = await shell(fixture({ nav: [...NAV, tickets] }));
    const link = within(dock).getByRole("link", { name: "Tickets" });
    expect(link.querySelector("svg")).toBeNull();
    expect(link.querySelector("span")?.className).not.toContain("gt:expanded:opacity-0");
    expect(within(dock).getByRole("link", { name: "Users" }).querySelector("span")?.className).toContain("gt:expanded:opacity-0");
  });
});

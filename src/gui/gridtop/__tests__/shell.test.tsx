import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderShell, settle, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import type { EntityRef, Icon, InitialView, Manifest, NavEntry, NavGroup, Signals, StatusItem } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
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
  nav("org.profile", "Profile", "system", 30, "/settings/profile", "profile"),
  nav("org.organizations", "Organizations", "system", 40, "/organizations", "organizations"),
];

const ORG: EntityRef = { kind: "organization", id: "o1", label: "Org One", href: "/organizations/o1" };
const COMMUNITY: EntityRef = { kind: "community", id: "c1", label: "Kasana", href: "/communities/c1" };
const site = (id: string, label: string) => ({ kind: "microgrid" as const, id, label, href: `/microgrids/${id}` as const, parent: "c1" });
const [M1, M2] = [site("m1", "East"), site("m2", "West")];

type Over = { nav?: NavEntry[]; sites?: number; pathname?: string; initial?: Partial<InitialView> } & Partial<Pick<Manifest, "orgs">> &
  Partial<Pick<Manifest["org"], "status">>;

function fixture(over: Over = {}): ManifestFixture {
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
        status: over.status ?? [],
        places: [COMMUNITY, M1, M2].slice(0, 1 + (over.sites ?? 2)),
      },
      orgs: over.orgs ?? [{ id: "o1", name: "Org One", href: "/organizations/o1" }],
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
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
});

const titles = (links: HTMLElement[]) => links.map((link) => link.textContent);
const current = (root: HTMLElement) => titles(within(root).queryAllByRole("link", { current: "page" }));
// Class names are written whole, with gt:, because Gridtop's stylesheet build
// reads this file too, and a bare name would be a utility globals.css emits.
const tokens = (el: Element) => [...el.classList];
/** 44 px or more on a touch screen: a height, min-height, size or line height of 11 or more, coarse-only or always. */
const TALL = /^gt:(?:pointer-coarse:)?(?:min-h|h|size|leading)-(\d+)$/;
const tall = (el: Element) => tokens(el).some((t) => Number(TALL.exec(t)?.[1] ?? 0) >= 11);
/** As wide on a touch screen: a width, min-width or size of 11 or more, or the full width. */
const WIDE = /^gt:(?:pointer-coarse:)?(?:min-w|w|size)-(\d+|full)$/;
const wide = (el: Element) => tokens(el).some((t) => {
  const m = WIDE.exec(t)?.[1];
  return m === "full" || Number(m ?? 0) >= 11;
});
const BOX = new Set(["gt:block", "gt:inline-block", "gt:flex", "gt:inline-flex", "gt:grid"]);
const signals = (count: number, top: Signals["top"] = [], unchecked: Signals["unchecked"] = []): Signals => ({
  type: "signals",
  org: "o1",
  count,
  top,
  checked: ["billing.periods"],
  unchecked,
});
const hrefs = (root: HTMLElement) => within(root).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]);
/** Opens the sheet a button controls, and returns it. */
async function openSheet(button: HTMLElement, name: string | RegExp) {
  await act(async () => fireEvent.click(button));
  return screen.getByRole("dialog", { name });
}

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
    ["/settings/plugins", {}, null, false],
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

  it("shows the mark without a link when the nav has no dashboard", async () => {
    await shell(fixture({ nav: NAV.filter((entry) => entry.id !== "org.today") }));
    const banner = screen.getByRole("banner");
    expect(within(banner).queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(banner.textContent).toContain("◆");
  });

  it("links an app that needs a microgrid straight to the only one", async () => {
    const { dock } = await shell(fixture({ sites: 1 }));
    expect(within(dock).getByRole("link", { name: "Operations" }).getAttribute("href")).toBe("/microgrids/m1/operations");
  });

  it("asks which microgrid while there are several, and each choice opens the app there", async () => {
    const { dock } = await shell(fixture());
    const picker = within(dock).getByRole("button", { name: "Operations, choose a microgrid" });
    expect(picker.getAttribute("aria-haspopup")).toBe("dialog");
    const sheet = await openSheet(picker, "Operations: choose a microgrid");
    expect(hrefs(sheet)).toEqual([
      ["East", "/microgrids/m1/operations"],
      ["West", "/microgrids/m2/operations"],
    ]);
  });

  it("fills the organization from the manifest and asks only for the microgrid", async () => {
    const xapp = nav("acme.xapp", "Xapp", "operate", 90, "/organizations/[organization]/m/[microgrid]");
    expect(xapp.needs).toEqual(["organization", "microgrid"]);
    const { dock } = await shell(fixture({ nav: [...NAV, xapp], initial: { scope: {} } }));
    const sheet = await openSheet(within(dock).getByRole("button", { name: "Xapp, choose a microgrid" }), "Xapp: choose a microgrid");
    expect(hrefs(sheet)).toEqual([
      ["East", "/organizations/o1/m/m1"],
      ["West", "/organizations/o1/m/m2"],
    ]);
  });

  describe("an app that needs a community and a microgrid", () => {
    const xsite = nav("acme.site", "Site page", "operate", 90, "/communities/[community]/microgrids/[microgrid]/x");
    const OTHER: EntityRef = { kind: "community", id: "c2", label: "Other", href: "/communities/c2" };
    const M3 = { ...site("m3", "North"), parent: "c2" };
    function twoCommunities() {
      const f = fixture({ nav: [...NAV, xsite] });
      f.manifest.org.places = [COMMUNITY, OTHER, M1, M2, M3];
      return f;
    }

    it("asks for the community first, then the microgrid in it", async () => {
      expect(xsite.needs).toEqual(["community", "microgrid"]);
      const { dock } = await shell(twoCommunities());
      const sheet = await openSheet(within(dock).getByRole("button", { name: "Site page, choose a community" }), "Site page: choose a community");
      expect(within(sheet).queryByText("No communities yet.")).toBeNull();
      expect(within(sheet).queryAllByRole("link")).toEqual([]);
      await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Kasana, then choose a microgrid" })));
      const next = screen.getByRole("dialog", { name: "Site page: choose a microgrid in Kasana" });
      expect(hrefs(next)).toEqual([
        ["East", "/communities/c1/microgrids/m1/x"],
        ["West", "/communities/c1/microgrids/m2/x"],
      ]);
    });

    it("says when the community it was given has no microgrid", async () => {
      const f = twoCommunities();
      f.manifest.org.places = [COMMUNITY, OTHER, M1, M2];
      const { dock } = await shell(f);
      const sheet = await openSheet(within(dock).getByRole("button", { name: "Site page, choose a community" }), /Site page/);
      await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Other, then choose a microgrid" })));
      const next = screen.getByRole("dialog", { name: "Site page: choose a microgrid in Other" });
      expect(within(next).getByText("No microgrids in Other yet.")).toBeTruthy();
      expect(hrefs(next)).toEqual([["Microgrids", "/microgrids"]]);
    });

    it("skips the community when there is only one, as the link would", async () => {
      const { dock } = await shell(fixture({ nav: [...NAV, xsite] }));
      const sheet = await openSheet(within(dock).getByRole("button", { name: "Site page, choose a microgrid" }), "Site page: choose a microgrid in Kasana");
      expect(hrefs(sheet)).toEqual([
        ["East", "/communities/c1/microgrids/m1/x"],
        ["West", "/communities/c1/microgrids/m2/x"],
      ]);
    });

    it("pairs no community with another community's only microgrid", async () => {
      const f = twoCommunities();
      f.manifest.org.places = [COMMUNITY, OTHER, M1];
      const { dock } = await shell(f);
      const sheet = await openSheet(within(dock).getByRole("button", { name: "Site page, choose a community" }), "Site page: choose a community");
      expect(hrefs(sheet)).toEqual([["Kasana", "/communities/c1/microgrids/m1/x"]]);
      await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Other, then choose a microgrid" })));
      const next = screen.getByRole("dialog", { name: "Site page: choose a microgrid in Other" });
      expect(within(next).getByText("No microgrids in Other yet.")).toBeTruthy();
      expect(hrefs(next)).toEqual([["Microgrids", "/microgrids"]]);
    });

    it("does not link the community in scope to another community's only microgrid", async () => {
      const f = twoCommunities();
      f.initial.scope = { organization: ORG, community: OTHER };
      f.manifest.org.places = [COMMUNITY, OTHER, M1];
      const { dock } = await shell(f);
      expect(within(dock).queryByRole("link", { name: "Site page" })).toBeNull();
      const sheet = await openSheet(within(dock).getByRole("button", { name: "Site page, choose a microgrid" }), "Site page: choose a microgrid in Other");
      expect(within(sheet).getByText("No microgrids in Other yet.")).toBeTruthy();
    });

    it("lists only the microgrids of the community in scope", async () => {
      const f = twoCommunities();
      f.initial.scope = { organization: ORG, community: OTHER };
      f.manifest.org.places = [COMMUNITY, OTHER, M1, M2, M3, { ...site("m4", "South"), parent: "c2" }];
      const { dock } = await shell(f);
      const sheet = await openSheet(within(dock).getByRole("button", { name: "Site page, choose a microgrid" }), "Site page: choose a microgrid in Other");
      expect(hrefs(sheet)).toEqual([
        ["North", "/communities/c2/microgrids/m3/x"],
        ["South", "/communities/c2/microgrids/m4/x"],
      ]);
    });
  });

  it("keeps an app that needs a microgrid when there is none, and says so", async () => {
    const { dock } = await shell(fixture({ sites: 0 }));
    const sheet = await openSheet(within(dock).getByRole("button", { name: "Billing, choose a microgrid" }), "Billing: choose a microgrid");
    expect(within(sheet).getByText("No microgrids yet.")).toBeTruthy();
    expect(hrefs(sheet)).toEqual([["Microgrids", "/microgrids"]]);
  });

  it("offers no list link when the manifest has no list of microgrids", async () => {
    const { dock } = await shell(fixture({ sites: 0, nav: NAV.filter((e) => e.id !== "community.microgrids") }));
    const sheet = await openSheet(within(dock).getByRole("button", { name: "Billing, choose a microgrid" }), /Billing/);
    expect(within(sheet).queryAllByRole("link")).toEqual([]);
  });

  it("shows Organizations only when the manifest lists it", async () => {
    const { dock } = await shell(fixture({ nav: NAV.filter((e) => e.id !== "org.organizations") }));
    expect(within(dock).queryByRole("link", { name: "Organizations" })).toBeNull();
    rendered!.unmount();
    const again = await shell(fixture());
    expect(within(again.dock).getByRole("link", { name: "Organizations" })).toBeTruthy();
  });

  it("shows who is signed in, their profile and Sign out in the account menu", async () => {
    const { log } = await shell(fixture());
    const sheet = await openSheet(within(screen.getByRole("banner")).getByRole("button", { name: "Account: Ann" }), "Account");
    expect(within(sheet).getByText("Ann")).toBeTruthy();
    expect(within(sheet).getByText("ann@example.test")).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/settings/profile");
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Sign out" })));
    expect(log.signOut).toBe(1);
  });

  it("names the account by email when the person has no name, and leaves Profile out when the manifest has no profile page", async () => {
    const f = fixture({ nav: NAV.filter((e) => e.id !== "org.profile") });
    f.manifest.user = { name: null, email: "ann@example.test" };
    await shell(f);
    const sheet = await openSheet(screen.getByRole("button", { name: "Account: ann@example.test" }), "Account");
    expect(within(sheet).queryByRole("link", { name: "Profile" })).toBeNull();
  });

  it("hides the organization switcher with one organization", async () => {
    await shell(fixture());
    expect(screen.queryByRole("button", { name: /^Organization/ })).toBeNull();
  });

  it("switches organization from the title bar, marking the current one", async () => {
    const orgs = [
      { id: "o1", name: "Org One", href: "/organizations/o1" as const },
      { id: "o2", name: "Org Two", href: "/organizations/o2" as const },
    ];
    await shell(fixture({ orgs }));
    const button = within(screen.getByRole("banner")).getByRole("button", { name: "Organization: Org One" });
    const sheet = await openSheet(button, "Organizations");
    expect(hrefs(sheet)).toEqual([
      ["Org One", "/organizations/o1"],
      ["Org Two", "/organizations/o2"],
    ]);
    const items = within(sheet).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("aria-current"))).toEqual(["true", null]);
    // Not on the organization's page, so its link is not the current page.
    expect(current(sheet)).toEqual([]);
  });

  it("marks the current organization's link as the current page on that organization's page", async () => {
    const orgs = [
      { id: "o1", name: "Org One", href: "/organizations/o1" as const },
      { id: "o2", name: "Org Two", href: "/organizations/o2" as const },
    ];
    await shell(fixture({ orgs, pathname: "/organizations/o1" }));
    const sheet = await openSheet(screen.getByRole("button", { name: "Organization: Org One" }), "Organizations");
    expect(current(sheet)).toEqual(["Org One"]);
  });

  it("links each status item to what it opens, its state in words", async () => {
    const status: StatusItem[] = [{ id: "acme.sync", label: "Sync", state: "working", open: "/settings/plugins" }];
    await shell(fixture({ status }));
    const [inBar] = screen.getAllByRole("list", { name: "Status" });
    expect(tokens(inBar)).toEqual(expect.arrayContaining(["gt:hidden", "gt:medium:flex"]));
    expect(hrefs(inBar)).toEqual([["Sync, working", "/settings/plugins"]]);
    // Below 600 px the account menu holds them.
    const sheet = await openSheet(screen.getByRole("button", { name: "Account: Ann" }), "Account");
    const inMenu = within(sheet).getByRole("list", { name: "Status" });
    expect(tokens(inMenu)).toContain("gt:medium:hidden");
    expect(hrefs(inMenu)).toEqual([["Sync, working", "/settings/plugins"]]);
  });

  it("says each status item's state in words", async () => {
    const states: StatusItem["state"][] = ["needs-you", "working", "idle", "off"];
    const status = states.map((state, i): StatusItem => ({ id: `acme.s${i}`, label: `S${i}`, state, open: "/settings/plugins" }));
    await shell(fixture({ status }));
    const [inBar] = screen.getAllByRole("list", { name: "Status" });
    expect(within(inBar).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "S0, needs you",
      "S1, working",
      "S2, idle",
      "S3, off",
    ]);
  });

  it("marks a status item whose page is shown as the current page, in the bar and in the account menu", async () => {
    const status: StatusItem[] = [
      { id: "acme.here", label: "Here", state: "idle", open: "/settings/plugins?ui.tab=sync" },
      { id: "acme.there", label: "There", state: "idle", open: "/settings/users" },
    ];
    await shell(fixture({ status, pathname: "/settings/plugins" }));
    const [inBar] = screen.getAllByRole("list", { name: "Status" });
    expect(current(inBar)).toEqual(["Here, idle"]);
    const sheet = await openSheet(screen.getByRole("button", { name: "Account: Ann" }), "Account");
    expect(current(within(sheet).getByRole("list", { name: "Status" }))).toEqual(["Here, idle"]);
  });

  it("shows nothing for Needs you until the host serves signals, its announcement region already in place", async () => {
    await shell(fixture());
    expect(screen.queryByRole("button", { name: /Needs you/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("announces the count through the region that was there before signals arrived", async () => {
    const spy = vi.spyOn(kit, "useSignals").mockReturnValue(null);
    const { goTo } = await shell(fixture());
    const region = screen.getByRole("status");
    spy.mockReturnValue(signals(1));
    await goTo("/");
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("1 thing needs you");
    expect(screen.getByRole("button", { name: "Needs you: 1" })).toBeTruthy();
  });


  it("shows the Needs-you count, announces it politely, and lists what needs the person", async () => {
    const top: Signals["top"] = [
      { kind: "your-move", id: "s1", source: "billing.periods", severity: "warn", title: "Close October", href: "/microgrids/m1/billing", at: "2026-11-10T09:00:00.000Z" },
    ];
    vi.spyOn(kit, "useSignals").mockReturnValue(signals(3, top));
    await shell(fixture());
    const button = screen.getByRole("button", { name: "Needs you: 3" });
    expect(within(button).getByText("3").className).not.toContain("gt:sr-only");
    expect(screen.getByRole("status").textContent).toBe("3 things need you");
    const sheet = await openSheet(button, "Needs you");
    expect(hrefs(sheet)).toEqual([["Close October", "/microgrids/m1/billing"]]);
  });

  it("shows no badge when nothing needs the person", async () => {
    vi.spyOn(kit, "useSignals").mockReturnValue(signals(0));
    await shell(fixture());
    const button = screen.getByRole("button", { name: "Needs you" });
    expect(button.textContent).toBe("");
    expect(screen.getByRole("status").textContent).toBe("");
    const sheet = await openSheet(button, "Needs you");
    expect(within(sheet).getByText("Nothing needs you right now.")).toBeTruthy();
    expect(within(sheet).queryByText("Some sources did not answer in time.")).toBeNull();
  });

  it("says when some sources did not answer, so nothing is not mistaken for all clear", async () => {
    vi.spyOn(kit, "useSignals").mockReturnValue(signals(0, [], ["billing.periods"]));
    await shell(fixture());
    const sheet = await openSheet(screen.getByRole("button", { name: "Needs you" }), "Needs you");
    expect(within(sheet).getByText("Some sources did not answer in time.")).toBeTruthy();
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

  it("opens every group from More in a sheet, and Escape closes it and returns focus to More", async () => {
    const { bottom } = await shell(fixture({ sites: 1 }));
    const more = within(bottom).getByRole("button", { name: "More" });
    const sheet = await openSheet(more, "All apps");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(sheet).getByRole("link", { name: "Invoice branding" }).getAttribute("href")).toBe("/communities/c1/invoice");
    expect(sheet.contains(document.activeElement)).toBe(true);
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    // Radix returns focus after a zero-delay timer.
    await settle();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("opens the place picker from inside More", async () => {
    const { bottom } = await shell(fixture());
    const more = await openSheet(within(bottom).getByRole("button", { name: "More" }), "All apps");
    const picker = await openSheet(within(more).getByRole("button", { name: "Rate Schedule, choose a microgrid" }), "Rate Schedule: choose a microgrid");
    expect(hrefs(picker)).toEqual([
      ["East", "/microgrids/m1/setup/rates"],
      ["West", "/microgrids/m2/setup/rates"],
    ]);
  });

  it("closes the More sheet when the page changes", async () => {
    const { bottom, goTo } = await shell(fixture({ sites: 1 }));
    const more = within(bottom).getByRole("button", { name: "More" });
    await openSheet(more, "All apps");
    await goTo("/communities/c1/invoice");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives every link and button a 44 px target on touch screens", async () => {
    const trail = [
      { label: "Org One", href: "/organizations/o1" as const },
      { label: "East", href: "/microgrids/m1" as const },
    ];
    const status: StatusItem[] = [{ id: "acme.sync", label: "Sync", state: "idle", open: "/settings/plugins" }];
    vi.spyOn(kit, "useSignals").mockReturnValue(signals(2));
    const orgs = [
      { id: "o1", name: "Org One", href: "/organizations/o1" as const },
      { id: "o2", name: "Org Two", href: "/organizations/o2" as const },
    ];
    const { bottom } = await shell(fixture({ initial: { trail }, status, orgs }));
    const more = await openSheet(within(bottom).getByRole("button", { name: "More" }), "All apps");
    await openSheet(within(more).getByRole("button", { name: "Rate Schedule, choose a microgrid" }), /Rate Schedule/);
    // The skip link shows only on focus, over the page.
    const controls = [...document.querySelectorAll("a, button")].filter((el) => !tokens(el).includes("gt:sr-only"));
    expect(controls.length).toBeGreaterThan(20);
    expect(controls.filter((el) => !tall(el)).map((el) => el.textContent)).toEqual([]);
    // Height and min-height size a link only as a box.
    const links = controls.filter((el) => el.tagName === "A");
    expect(links.filter((el) => !tokens(el).some((t) => BOX.has(t))).map((el) => el.textContent)).toEqual([]);
  });

  it("gives the tray's buttons and the rows of its sheets a 44 px target on touch screens", async () => {
    const status: StatusItem[] = [{ id: "acme.sync", label: "Sync", state: "idle", open: "/settings/plugins" }];
    const top: Signals["top"] = [
      { kind: "your-move", id: "s1", source: "billing.periods", severity: "warn", title: "Close October", href: "/microgrids/m1/billing", at: "2026-11-10T09:00:00.000Z" },
    ];
    vi.spyOn(kit, "useSignals").mockReturnValue(signals(0, top));
    const orgs = [
      { id: "o1", name: "Org One", href: "/organizations/o1" as const },
      { id: "o2", name: "Org Two", href: "/organizations/o2" as const },
    ];
    await shell(fixture({ status, orgs }));
    const banner = screen.getByRole("banner");
    const buttons = [/^Organization/, /^Needs you/, /^Account/].map((name) => within(banner).getByRole("button", { name }));
    // Icon buttons: as wide as they are tall.
    expect(buttons.filter((el) => !tall(el) || !wide(el)).map((el) => el.getAttribute("aria-label"))).toEqual([]);
    for (const [button, title, rows] of [
      [buttons[0], "Organizations", ["Org One", "Org Two"]],
      [buttons[1], "Needs you", ["Close October"]],
      [buttons[2], "Account", ["Profile", "Sync, idle", "Sign out"]],
    ] as const) {
      const sheet = await openSheet(button, title);
      const controls = within(sheet).getAllByRole("link").concat(within(sheet).getAllByRole("button"));
      expect(rows.every((row) => controls.some((el) => el.textContent === row))).toBe(true);
      expect(controls.filter((el) => !tall(el)).map((el) => el.textContent)).toEqual([]);
      await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
      await settle();
    }
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

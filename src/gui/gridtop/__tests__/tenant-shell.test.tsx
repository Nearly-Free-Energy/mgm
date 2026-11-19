/**
 * Gridtop's shell on a tenant manifest (RFC mgm#197 § 4): the manifest of a
 * person whose rows are all tenant rows, whose `org` is their current unit,
 * whose places are their units and who has no organization to switch to.
 * The manifest here is written as the host's tenant manifest builds it.
 * The context path, the account menu's Sign out and the phone dock are
 * checked here, for a tenant and for a person with staff and tenant rows,
 * who gets a staff manifest. jsdom applies no media queries, so which dock or
 * account trigger shows at a width is checked by class; the 360 px browser
 * smoke is in e2e/.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderShell, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import type { Manifest, NavEntry } from "@/lib/gui/contract";
import { GridtopGui } from "..";

const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
const UNIT_B = "e7400000-0000-4000-8000-00000000000b";
const HOME: NavEntry = { id: "tenant.home", title: "My home", icon: "tenants", group: "operate", order: 80, href: "/my", needs: [] };
const USAGE: NavEntry = { id: "tenant.usage", title: "My usage", icon: "readings", group: "operate", order: 81, href: "/my/usage", needs: [] };

function tenantFixture(
  units: { id: string; label: string }[],
  { nav = [HOME], pathname = "/my" }: { nav?: NavEntry[]; pathname?: string } = {},
): ManifestFixture {
  const several = units.length > 1;
  const href = (id: string) => (several ? (`/my?unit=${id}` as const) : ("/my" as const));
  const [unit] = units;
  const manifest: Manifest = {
    type: "manifest",
    contract: "0.1.0",
    release: null,
    locale: "en",
    now: "2026-11-10T12:00:00.000Z",
    gui: "gridtop",
    user: { name: "Grace Namata", email: "grace@example.test" },
    org: {
      id: unit.id,
      name: unit.label,
      href: href(unit.id),
      timezone: "Africa/Kampala",
      nav,
      status: [],
      places: units.map((u) => ({ kind: "tenant", id: u.id, label: u.label, href: href(u.id) })),
    },
    orgs: [],
  };
  return {
    name: "tenant",
    manifest,
    pathname,
    initial: {
      view: "tenant.home",
      title: "My home",
      trail: [{ label: unit.label, href: href(unit.id) }, ...(several ? [{ label: "My home", href: "/my" as const }] : [])],
      tabs: [],
      scope: { organization: { kind: "organization", id: unit.id, label: unit.label, href: href(unit.id) } },
    },
  };
}

let rendered: Rendered | null = null;
afterEach(() => rendered?.unmount());

const links = (root: HTMLElement) => within(root).queryAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);

describe("Gridtop's shell for a tenant", () => {
  it("shows the unit's name as the context and offers no organization to switch to", async () => {
    rendered = await renderShell(GridtopGui, tenantFixture([{ id: UNIT_A, label: "Grace Namata" }]), <p>The page</p>);
    const here = screen.getByRole("navigation", { name: "You are here" });
    expect(links(here)).toEqual([["Grace Namata", "/my"]]);
    expect(within(here).queryByRole("button", { name: /Switch organization/ })).toBeNull();
    expect(screen.getByText("The page")).toBeTruthy();
  });

  it("names the current unit, then the home, for a person with two units", async () => {
    rendered = await renderShell(
      GridtopGui,
      tenantFixture([
        { id: UNIT_A, label: "Grace Namata" },
        { id: UNIT_B, label: "Shop 9" },
      ]),
    );
    const here = screen.getByRole("navigation", { name: "You are here" });
    expect(links(here)).toEqual([
      ["Grace Namata", `/my?unit=${UNIT_A}`],
      ["My home", "/my"],
    ]);
  });

  it("offers Sign out in the account menu, as for staff", async () => {
    // The shell's account menu is a tenant's way out once their home is
    // released; until then the (gui) layout sends them from any page that
    // is not a tenant page to /no-access, which has its own.
    rendered = await renderShell(GridtopGui, tenantFixture([{ id: UNIT_A, label: "Shop 9" }]), <p>The page</p>);
    await act(async () =>
      fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Account: Grace Namata" })),
    );
    const sheet = screen.getByRole("dialog", { name: "Account" });
    expect(within(sheet).getByText("grace@example.test")).toBeTruthy();
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Sign out" })));
    expect(rendered.log.signOut).toBe(1);
  });
});

/** The phone dock, which holds the second of the two Apps navs. */
const bottomDock = () => screen.getAllByRole("navigation", { name: "Apps" })[1];
const items = (root: HTMLElement) => within(root).getAllByRole("listitem").map((li) => li.textContent);
const classes = (el: Element | null) => [...(el?.classList ?? [])];

describe("Gridtop's phone dock for a tenant", () => {
  const ONE = [{ id: UNIT_A, label: "Shop 9" }];

  it("pins My home and My usage, then Account, and offers no More while every app is pinned", async () => {
    rendered = await renderShell(GridtopGui, tenantFixture(ONE, { nav: [USAGE, HOME] }), <p>The page</p>);
    const dock = bottomDock();
    expect(classes(dock)).toContain("gt:medium:hidden");
    expect(links(dock)).toEqual([
      ["My home", "/my"],
      ["My usage", "/my/usage"],
    ]);
    expect(items(dock)).toEqual(["My home", "My usage", "Account"]);
    expect(within(dock).getByRole("button", { name: "Account: Grace Namata" })).toBeTruthy();
    expect(within(dock).queryByRole("button", { name: "More" })).toBeNull();
    // Account takes the third column whatever is pinned before it.
    expect(classes(within(dock).getByRole("button", { name: "Account: Grace Namata" }).closest("li"))).toContain("gt:col-start-3");
  });

  it("marks My usage as the current app on a day of usage", async () => {
    rendered = await renderShell(GridtopGui, tenantFixture(ONE, { nav: [HOME, USAGE], pathname: "/my/usage/day" }));
    const dock = bottomDock();
    expect(within(dock).getByRole("link", { name: "My usage" }).getAttribute("aria-current")).toBe("page");
    expect(within(dock).getByRole("link", { name: "My home" }).getAttribute("aria-current")).toBeNull();
  });

  it("brings More back when a tenant app is not pinned, and lists it there", async () => {
    const bills: NavEntry = { id: "tenant.bills", title: "My bills", icon: "billing", group: "money", order: 82, href: "/my/bills", needs: [] };
    rendered = await renderShell(GridtopGui, tenantFixture(ONE, { nav: [HOME, USAGE, bills] }));
    const dock = bottomDock();
    expect(items(dock)).toEqual(["My home", "My usage", "Account", "More"]);
    await act(async () => fireEvent.click(within(dock).getByRole("button", { name: "More" })));
    const sheet = screen.getByRole("dialog", { name: "All apps" });
    expect(within(sheet).getByRole("link", { name: "My bills" }).getAttribute("href")).toBe("/my/bills");
  });

  it("holds only Account while the tenant has no app", async () => {
    // Before the tenant pages are released (RFC mgm#197 PR 5) the host offers a tenant no nav entry.
    rendered = await renderShell(GridtopGui, tenantFixture(ONE, { nav: [] }));
    const dock = bottomDock();
    expect(items(dock)).toEqual(["Account"]);
    expect(within(dock).queryAllByRole("link")).toEqual([]);
  });

  it("opens the account menu from the dock, with Sign out", async () => {
    rendered = await renderShell(GridtopGui, tenantFixture(ONE, { nav: [HOME, USAGE] }), <p>The page</p>);
    const trigger = within(bottomDock()).getByRole("button", { name: "Account: Grace Namata" });
    // The visible word is part of the name, so speech input can say it.
    expect(trigger.textContent).toBe("Account");
    await act(async () => fireEvent.click(trigger));
    const sheet = screen.getByRole("dialog", { name: "Account" });
    expect(within(sheet).getByText("grace@example.test")).toBeTruthy();
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Sign out" })));
    expect(rendered.log.signOut).toBe(1);
  });

  it("hides the title bar's account menu below 600 px, where the dock holds it", async () => {
    rendered = await renderShell(GridtopGui, tenantFixture(ONE, { nav: [HOME, USAGE] }), <p>The page</p>);
    const tray = within(screen.getByRole("banner")).getByRole("button", { name: "Account: Grace Namata" });
    expect(classes(tray.parentElement)).toContain("gt:max-medium:hidden");
    // The dock itself is hidden from 600 px, so one Account trigger shows at any width.
    expect(screen.getAllByRole("button", { name: "Account: Grace Namata" })).toHaveLength(2);
  });
});

describe("Gridtop's phone dock for a person with staff and tenant rows", () => {
  const ORG = { id: "o1", name: "Org One", href: "/organizations/o1" as const };
  const staffNav = (id: NavEntry["id"], title: string, group: NavEntry["group"], order: number, href: NavEntry["href"]): NavEntry => ({
    id,
    title,
    icon: "sites",
    group,
    order,
    href,
    needs: [],
    legacy: true,
  });

  /** A staff manifest (an organization to switch to) whose nav also holds the tenant's apps, as the host builds it. */
  function staffAndTenant(): ManifestFixture {
    const base = tenantFixture([{ id: UNIT_A, label: "Shop 9" }]);
    return {
      name: "staff and tenant",
      pathname: "/",
      manifest: {
        ...base.manifest,
        org: {
          id: ORG.id,
          name: ORG.name,
          href: ORG.href,
          timezone: "Africa/Kampala",
          nav: [
            staffNav("org.today", "Dashboard", "operate", 10, "/"),
            staffNav("metering.operations", "Operations", "operate", 40, "/operations"),
            staffNav("billing.periods", "Billing", "money", 10, "/billing"),
            HOME,
            USAGE,
          ],
          status: [],
          places: [],
        },
        orgs: [ORG],
      },
      initial: {
        view: null,
        title: "Dashboard",
        trail: [],
        tabs: [],
        scope: { organization: { kind: "organization", id: ORG.id, label: ORG.name, href: ORG.href } },
      },
    };
  }

  it("keeps the staff dock, with the tenant's apps under More and Account in the title bar", async () => {
    rendered = await renderShell(GridtopGui, staffAndTenant(), <p>The page</p>);
    const dock = bottomDock();
    expect(items(dock)).toEqual(["Dashboard", "Operations", "Billing", "More"]);
    expect(within(dock).queryByRole("button", { name: /^Account/ })).toBeNull();
    const tray = within(screen.getByRole("banner")).getByRole("button", { name: "Account: Grace Namata" });
    expect(classes(tray.parentElement)).not.toContain("gt:max-medium:hidden");
    await act(async () => fireEvent.click(within(dock).getByRole("button", { name: "More" })));
    const sheet = screen.getByRole("dialog", { name: "All apps" });
    expect(within(sheet).getByRole("link", { name: "My home" }).getAttribute("href")).toBe("/my");
    expect(within(sheet).getByRole("link", { name: "My usage" }).getAttribute("href")).toBe("/my/usage");
  });
});

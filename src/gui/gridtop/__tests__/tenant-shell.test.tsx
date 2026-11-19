/**
 * Gridtop's shell on a tenant manifest (RFC mgm#197 § 4): the manifest of a
 * person whose rows are all tenant rows, whose `org` is their current unit,
 * whose places are their units and who has no organization to switch to.
 * The manifest here is written as the host's tenant manifest builds it.
 * The context path and the account menu's Sign out are checked here; the
 * tenant dock and the 360 px smoke come with the tenant renderers (RFC § 8,
 * PR 4).
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderShell, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import type { Manifest, NavEntry } from "@/lib/gui/contract";
import { GridtopGui } from "..";

const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
const UNIT_B = "e7400000-0000-4000-8000-00000000000b";
const HOME: NavEntry = { id: "tenant.home", title: "My home", icon: "tenants", group: "operate", order: 80, href: "/my", needs: [] };

function tenantFixture(units: { id: string; label: string }[]): ManifestFixture {
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
      nav: [HOME],
      status: [],
      places: units.map((u) => ({ kind: "tenant", id: u.id, label: u.label, href: href(u.id) })),
    },
    orgs: [],
  };
  return {
    name: "tenant",
    manifest,
    pathname: "/my",
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
    // released; until then the (gui) layout sends them from / to
    // /no-access, which has its own.
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

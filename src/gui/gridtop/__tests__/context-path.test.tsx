import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderShell, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import { GridtopGui } from "..";
import { EAST, EAST_TRAIL, HIDDEN, KASANA, LONE, NAV, NORTH, ORG, ORGS, OTHER, WEST, displayConflicts, nav, placesFixture, type Over } from "./places-fixture";

let rendered: Rendered | null = null;
afterEach(() => rendered?.unmount());

async function shell(f: ManifestFixture) {
  rendered = await renderShell(GridtopGui, f, <p>The page</p>);
  return screen.getByRole("navigation", { name: "You are here" });
}

/** A page inside East, as legacyView resolves it. */
const inEast = (pathname: string, over: Over = {}) =>
  placesFixture({
    pathname,
    ...over,
    initial: {
      trail: [...EAST_TRAIL, ...(pathname.includes("/billing") ? [{ label: "Billing", href: "/microgrids/m1/billing" as const }] : [])],
      scope: { organization: ORG, community: KASANA, microgrid: EAST },
      ...over.initial,
    },
  });

async function openSheet(button: HTMLElement, name: string | RegExp) {
  await act(async () => fireEvent.click(button));
  return screen.getByRole("dialog", { name });
}
const rows = (root: HTMLElement) => within(root).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
const listed = (sheet: HTMLElement, name: string) => rows(within(sheet).getByRole("list", { name }));
const classes = (el: Element) => [...el.classList];

describe("Gridtop's context path", () => {
  it("shows organization, community, microgrid and app, the app as the current page", async () => {
    const here = await shell(inEast("/microgrids/m1/billing/p4/history"));
    expect(rows(here)).toEqual([
      ["Org One", "/organizations/o1"],
      ["Kasana", "/communities/c1"],
      ["East", "/microgrids/m1/operations"],
      ["Billing", "/microgrids/m1/billing"],
    ]);
    expect(within(here).getAllByRole("link", { current: "page" }).map((a) => a.textContent)).toEqual(["Billing"]);
  });

  it("switches microgrid with this community's microgrids first, keeping the current app", async () => {
    const here = await shell(inEast("/microgrids/m1/billing/p4/history"));
    const sheet = await openSheet(within(here).getByRole("button", { name: "Switch microgrid" }), "Microgrids");
    expect(listed(sheet, "2 microgrids in Kasana")).toEqual([
      ["East", "/microgrids/m1/billing"],
      ["West", "/microgrids/m2/billing"],
    ]);
    expect(listed(sheet, "1 microgrid in other communities")).toEqual([["North", "/microgrids/m3/billing"]]);
    expect(within(sheet).getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "true").map((li) => li.textContent)).toEqual(["East"]);
  });

  it("goes to the microgrid's own page when the current app needs no microgrid", async () => {
    // No app's pattern fits past /microgrids, so the current app is the list.
    const here = await shell(inEast("/microgrids/m1/elsewhere"));
    const sheet = await openSheet(within(here).getByRole("button", { name: "Switch microgrid" }), "Microgrids");
    expect(rows(sheet)).toEqual([
      ["East", "/microgrids/m1/operations"],
      ["West", "/microgrids/m2/operations"],
      ["North", "/microgrids/m3/operations"],
    ]);
  });

  it("shows a place with no page as text, never with another place's page", async () => {
    const here = await shell(inEast("/microgrids/m1/elsewhere", { places: [KASANA, OTHER, EAST, WEST, NORTH, HIDDEN] }));
    const sheet = await openSheet(within(here).getByRole("button", { name: "Switch microgrid" }), "Microgrids");
    const row = within(sheet).getAllByRole("listitem").find((li) => li.textContent === "Hidden")!;
    expect(within(row).queryByRole("link")).toBeNull();
    expect(rows(sheet)).toEqual([
      ["East", "/microgrids/m1/operations"],
      ["West", "/microgrids/m2/operations"],
      ["North", "/microgrids/m3/operations"],
    ]);
  });

  it("lists every microgrid in one group when they share a community", async () => {
    const here = await shell(inEast("/microgrids/m1/operations", { places: [KASANA, OTHER, EAST, WEST] }));
    const sheet = await openSheet(within(here).getByRole("button", { name: "Switch microgrid" }), "Microgrids");
    expect(listed(sheet, "2 microgrids")).toEqual([
      ["East", "/microgrids/m1/operations"],
      ["West", "/microgrids/m2/operations"],
    ]);
  });

  it("switches community with each one's microgrid count, keeping an app that needs only a community", async () => {
    const at = placesFixture({
      pathname: "/communities/c1/invoice",
      initial: {
        trail: [EAST_TRAIL[0], EAST_TRAIL[1], { label: "Invoice", href: "/communities/c1/invoice" }],
        scope: { organization: ORG, community: KASANA },
      },
    });
    const here = await shell(at);
    const sheet = await openSheet(within(here).getByRole("button", { name: "Switch community" }), "Communities");
    expect(within(sheet).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Kasana2 microgrids", "Other1 microgrid"]);
    expect(rows(sheet)).toEqual([
      ["Kasana2 microgrids", "/communities/c1/invoice"],
      ["Other1 microgrid", "/communities/c2/invoice"],
    ]);
  });

  it("goes to the community's page from an app that needs a microgrid", async () => {
    const here = await shell(inEast("/microgrids/m1/billing"));
    const sheet = await openSheet(within(here).getByRole("button", { name: "Switch community" }), "Communities");
    expect(rows(sheet).map(([, href]) => href)).toEqual(["/communities/c1", "/communities/c2"]);
  });

  describe("an app that needs a community and a microgrid", () => {
    const xsite = nav("acme.site", "Site page", "operate", 90, "/communities/[community]/microgrids/[microgrid]/x");
    const at = (places = [KASANA, OTHER, EAST, WEST, NORTH, LONE]) =>
      inEast("/communities/c1/microgrids/m1/x", {
        nav: [...NAV, xsite],
        places,
        initial: { trail: [...EAST_TRAIL, { label: "Site page", href: "/communities/c1/microgrids/m1/x" }] },
      });

    it("fills the new microgrid's own community, never the one in scope", async () => {
      const here = await shell(at());
      const sheet = await openSheet(within(here).getByRole("button", { name: "Switch microgrid" }), "Microgrids");
      expect(rows(sheet)).toEqual([
        ["East", "/communities/c1/microgrids/m1/x"],
        ["West", "/communities/c1/microgrids/m2/x"],
        ["North", "/communities/c2/microgrids/m3/x"],
        // No community: its own page, rather than a pair with Kasana.
        ["Lone", "/microgrids/m9/operations"],
      ]);
    });

    it("goes to the community's page, since the microgrid in scope belongs to another", async () => {
      const here = await shell(at());
      const sheet = await openSheet(within(here).getByRole("button", { name: "Switch community" }), "Communities");
      expect(rows(sheet).map(([, href]) => href)).toEqual(["/communities/c1", "/communities/c2"]);
    });
  });

  it("offers no switcher for a place that is the only one of its kind", async () => {
    const here = await shell(inEast("/microgrids/m1/operations", { places: [KASANA, EAST] }));
    expect(within(here).queryByRole("button", { name: /^Switch/ })).toBeNull();
  });

  it("shows no organization switcher with one organization", async () => {
    const here = await shell(inEast("/microgrids/m1/operations"));
    expect(within(here).queryByRole("button", { name: "Switch organization" })).toBeNull();
  });

  it("switches organization from the first crumb, each to its own page", async () => {
    const here = await shell(inEast("/microgrids/m1/operations", { orgs: ORGS }));
    const sheet = await openSheet(within(here).getByRole("button", { name: "Switch organization" }), "Organizations");
    expect(listed(sheet, "2 organizations")).toEqual([
      ["Org One", "/organizations/o1"],
      ["Org Two", "/organizations/o2"],
    ]);
  });

  it("puts the organization first when the trail leaves it out and there are several", async () => {
    const here = await shell(placesFixture({ pathname: "/x", orgs: ORGS, initial: { title: "Somewhere", trail: [{ label: "Kasana", href: "/communities/c1" }] } }));
    expect(rows(here)).toEqual([
      ["Org One", "/organizations/o1"],
      ["Kasana", "/communities/c1"],
    ]);
    expect(within(here).getByRole("button", { name: "Switch organization" })).toBeTruthy();
  });

  it("shows only the last crumb below 600 px, with the switchers from 600 px", async () => {
    const here = await shell(inEast("/microgrids/m1/billing", { orgs: ORGS }));
    const items = within(here).getAllByRole("listitem");
    for (const item of items.slice(0, -1)) expect(classes(item)).toEqual(expect.arrayContaining(["gt:hidden", "gt:medium:flex"]));
    for (const kind of ["organization", "community", "microgrid"]) {
      expect(classes(within(here).getByRole("button", { name: `Switch ${kind}` }))).toEqual(expect.arrayContaining(["gt:hidden", "gt:medium:inline-flex"]));
    }
    const whole = within(items[items.length - 1]).getByRole("button", { name: "Show the whole path" });
    expect(classes(whole)).toEqual(expect.arrayContaining(["gt:inline-flex", "gt:medium:hidden"]));
  });

  it("gives no element two display utilities that would fight, wherever the last crumb is a place", async () => {
    // The microgrid crumb is last on its Operations page, so its switcher and the whole-path ▾ sit side by side.
    await shell(inEast("/microgrids/m1/operations", { orgs: ORGS }));
    expect(displayConflicts(document.body)).toEqual([]);
  });

  it("opens the whole path and every switcher in one sheet below 600 px", async () => {
    const here = await shell(inEast("/microgrids/m1/billing", { orgs: ORGS }));
    const sheet = await openSheet(within(here).getByRole("button", { name: "Show the whole path" }), "Where you are");
    const path = within(sheet).getAllByRole("list")[0];
    expect(rows(path)).toEqual([
      ["Org One", "/organizations/o1"],
      ["Kasana", "/communities/c1"],
      ["East", "/microgrids/m1/operations"],
      ["Billing", "/microgrids/m1/billing"],
    ]);
    expect(within(path).getAllByRole("link", { current: "page" }).map((a) => a.textContent)).toEqual(["Billing"]);
    expect(within(sheet).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Organizations", "Communities", "Microgrids"]);
    expect(rows(within(sheet).getByRole("region", { name: "Microgrids" })).map(([label]) => label)).toEqual(["East", "West", "North"]);
  });

  it("shows the title after the organization when the page has no trail", async () => {
    const here = await shell(placesFixture({ pathname: "/x", orgs: ORGS, initial: { title: "Somewhere" } }));
    expect(here.textContent).toContain("Somewhere");
    expect(within(here).queryAllByRole("link", { current: "page" })).toEqual([]);
    const sheet = await openSheet(within(here).getByRole("button", { name: "Show the whole path" }), "Where you are");
    expect(within(sheet).getAllByRole("listitem").map((li) => li.textContent)).toEqual(expect.arrayContaining(["Org One", "Somewhere"]));
  });

  it("shows the title alone with no trail and one organization", async () => {
    const here = await shell(placesFixture({ pathname: "/x", initial: { title: "Somewhere" } }));
    expect(here.textContent).toBe("Somewhere");
    expect(within(here).queryAllByRole("button")).toEqual([]);
  });

  it("keeps a microgrid's place in the trail unswitched when the manifest lists no other", async () => {
    const here = await shell(inEast("/microgrids/m1/operations", { places: [KASANA, OTHER, EAST], initial: { scope: { organization: ORG, community: KASANA, microgrid: EAST } } }));
    expect(within(here).getByRole("button", { name: "Switch community" })).toBeTruthy();
    expect(within(here).queryByRole("button", { name: "Switch microgrid" })).toBeNull();
  });
});

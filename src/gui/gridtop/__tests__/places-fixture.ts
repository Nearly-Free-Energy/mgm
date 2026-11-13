/**
 * A manifest with two communities and three microgrids, for the context
 * path and window bar tests. Hrefs are what the manifest builder writes: a
 * community's page, and a microgrid's Operations page.
 */
import type { ManifestFixture } from "@/lib/gui/conformance";
import type { EntityRef, Icon, InitialView, Manifest, NavEntry, NavGroup } from "@/lib/gui/contract";

export const nav = (id: NavEntry["id"], title: string, group: NavGroup, order: number, href: NavEntry["href"], icon = "sites"): NavEntry => ({
  id,
  title,
  icon: icon as Icon,
  group,
  order,
  href,
  needs: [...href.matchAll(/\[(\w+)\]/g)].map((m) => m[1] as NavEntry["needs"][number]),
  legacy: true,
});

export const NAV: NavEntry[] = [
  nav("org.today", "Dashboard", "operate", 10, "/", "today"),
  nav("community.microgrids", "Microgrids", "operate", 20, "/microgrids"),
  nav("community.communities", "Communities", "operate", 30, "/communities", "communities"),
  nav("metering.operations", "Operations", "operate", 40, "/microgrids/[microgrid]/operations", "live"),
  nav("billing.periods", "Billing", "money", 10, "/microgrids/[microgrid]/billing", "billing"),
  nav("billing.invoice-branding", "Invoice", "configure", 30, "/communities/[community]/invoice", "branding"),
];

type Place = Manifest["org"]["places"][number];
const community = (id: string, label: string): Place => ({ kind: "community", id, label, href: `/communities/${id}` });
const microgrid = (id: string, label: string, parent?: string): Place => ({
  kind: "microgrid",
  id,
  label,
  href: `/microgrids/${id}/operations`,
  ...(parent ? { parent } : {}),
});

export const ORG: EntityRef = { kind: "organization", id: "o1", label: "Org One", href: "/organizations/o1" };
export const [KASANA, OTHER] = [community("c1", "Kasana"), community("c2", "Other")];
export const [EAST, WEST, NORTH] = [microgrid("m1", "East", "c1"), microgrid("m2", "West", "c1"), microgrid("m3", "North", "c2")];
export const LONE = microgrid("m9", "Lone");
/** A microgrid with no page of its own. */
export const HIDDEN: Place = { kind: "microgrid", id: "m4", label: "Hidden", parent: "c1" };

const DISPLAY = /^gt:(?:hidden|block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|table)$/;

/**
 * Elements carrying two display utilities with no variant, such as gt:hidden
 * and gt:inline-flex. Which one applies depends on their order in the
 * compiled stylesheet, not in the class list.
 */
export const displayConflicts = (root: Element) =>
  [root, ...root.querySelectorAll("*")].filter((el) => [...el.classList].filter((c) => DISPLAY.test(c)).length > 1).map((el) => el.outerHTML.slice(0, 120));

export const ORGS: Manifest["orgs"] = [
  { id: "o1", name: "Org One", href: "/organizations/o1" },
  { id: "o2", name: "Org Two", href: "/organizations/o2" },
];

/** The trail legacyView gives a page inside East: organization, community, microgrid. */
export const EAST_TRAIL: InitialView["trail"] = [
  { label: "Org One", href: "/organizations/o1" },
  { label: "Kasana", href: "/communities/c1" },
  { label: "East", href: "/microgrids/m1/operations" },
];

export interface Over {
  pathname?: string;
  nav?: NavEntry[];
  places?: Place[];
  orgs?: Manifest["orgs"];
  initial?: Partial<InitialView>;
  manifest?: Partial<Manifest>;
  timezone?: string | null;
}

export function placesFixture(over: Over = {}): ManifestFixture {
  return {
    name: "places",
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
        timezone: over.timezone === undefined ? "Africa/Kampala" : over.timezone,
        nav: over.nav ?? NAV,
        status: [],
        places: over.places ?? [KASANA, OTHER, EAST, WEST, NORTH],
      },
      orgs: over.orgs ?? [ORGS[0]],
      ...over.manifest,
    },
    initial: { view: null, title: "Dashboard", trail: [], tabs: [], scope: { organization: ORG }, ...over.initial },
  };
}

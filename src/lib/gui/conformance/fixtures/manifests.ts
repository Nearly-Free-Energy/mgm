/**
 * The manifests a GUI's Shell is rendered with (check 2), and the page each
 * one shows. Nav hrefs are kind-named, as the host's manifest builder writes
 * them (kindNamedHref in ../../host/shared/manifest-model.ts).
 */
import type { Icon, InitialView, Manifest, NavEntry, OrgManifest, Signals, ViewModel } from "../../contract";

export interface ManifestFixture {
  name: string;
  manifest: Manifest;
  initial: InitialView;
  /** The page the Shell is rendered on. */
  pathname: string;
  /** Text the Shell must show, such as the title of an entry whose icon is unknown. */
  text?: string[];
  /** What kit.useSignals() returns; null when left out. */
  signals?: Signals;
}

const ORG = "00000000-0000-4000-8000-0000000000c1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000c2";
const COMMUNITY = "00000000-0000-4000-8000-0000000000d1";
const SITE = "00000000-0000-4000-8000-0000000000e1";
const SECOND_SITE = "00000000-0000-4000-8000-0000000000e2";

/** The ids the manifests use, for fixtures that point at the same places. */
export const FIXTURE_IDS = { org: ORG, community: COMMUNITY, site: SITE } as const;

const entry = (id: NavEntry["id"], title: string, href: NavEntry["href"], over: Partial<NavEntry> = {}): NavEntry => ({
  id,
  title,
  icon: "sites",
  group: "operate",
  order: 10,
  href,
  needs: href.includes("[microgrid]") ? ["microgrid"] : [],
  ...over,
});

/** The dashboard's legacy entry, as src/lib/organization-directory/surface.ts declares it, so a GUI's link to it is checked. */
const DASHBOARD = entry("org.today", "Dashboard", "/", { icon: "today", order: 5, legacy: true });
const COMMUNITIES = entry("community.communities", "Communities", "/communities", { icon: "communities", legacy: true });
const OPERATIONS = entry("metering.operations", "Operations", "/microgrids/[microgrid]/operations", { icon: "live", order: 20 });
const BILLING = entry("billing.periods", "Billing", "/microgrids/[microgrid]/billing", { icon: "billing", group: "money", order: 30 });
const TICKETS = entry("acme.tickets", "Tickets", "/organizations/[organization]/tickets", {
  icon: "ticket" as Icon, // outside the vocabulary on purpose
  needs: ["organization"],
  order: 40,
});

const place = (id: string, label: string) => ({
  kind: "microgrid" as const,
  id,
  label,
  href: `/microgrids/${id}/operations` as const,
  parent: COMMUNITY,
});

function org(over: Partial<OrgManifest> = {}): OrgManifest {
  return {
    id: ORG,
    name: "First organization",
    href: `/organizations/${ORG}`,
    timezone: "Africa/Kampala",
    nav: [DASHBOARD, COMMUNITIES, OPERATIONS, BILLING],
    status: [{ id: "community.setup", label: "Setup", state: "needs-you", open: `/communities/${COMMUNITY}` }],
    places: [{ kind: "community", id: COMMUNITY, label: "Community" }, place(SITE, "First site")],
    ...over,
  };
}

function fixture(name: string, orgOver: Partial<OrgManifest> = {}, over: Partial<ManifestFixture> = {}): ManifestFixture {
  const own = org(orgOver);
  return {
    name,
    manifest: {
      type: "manifest",
      contract: "0.1.0",
      release: null,
      locale: "en",
      now: "2026-11-10T12:00:00.000Z",
      gui: "conformance",
      user: { name: "Ann", email: "ann@example.test" },
      org: own,
      orgs: [{ id: own.id, name: own.name, href: own.href }],
    },
    initial: { view: null, title: "Communities", trail: [], tabs: [], scope: {} },
    pathname: "/communities",
    ...over,
  };
}

const twoOrgs = fixture("two-orgs");
twoOrgs.manifest.orgs.push({ id: OTHER_ORG, name: "Second organization", href: `/organizations/${OTHER_ORG}` });

export const MANIFEST_FIXTURES: readonly ManifestFixture[] = [
  fixture("one-org", {}, { pathname: `/microgrids/${SITE}/operations` }),
  twoOrgs,
  fixture("billing-off", { nav: [COMMUNITIES, OPERATIONS] }),
  fixture("empty-org", { places: [], status: [] }),
  fixture("unknown-plugin", { nav: [COMMUNITIES, OPERATIONS, TICKETS] }, { text: ["Tickets"] }),
  fixture("legacy-nav", { nav: [COMMUNITIES, { ...OPERATIONS, legacy: true }, { ...BILLING, legacy: true }] }),
  fixture("missing-context", {
    places: [{ kind: "community", id: COMMUNITY, label: "Community" }, place(SITE, "First site"), place(SECOND_SITE, "Second site")],
  }),
];

/** The page inside each Shell: a record with one action, drawn by the GUI's renderer. */
export const PAGE_MODEL: ViewModel = {
  type: "view",
  view: "community.community",
  kind: "record",
  title: "Community",
  org: ORG,
  trail: [],
  body: { sections: [{ title: "About", fields: [{ key: "name", label: "Name", value: { t: "text", text: "Community" } }] }] },
  actions: [{ action: "community.rename", params: { id: COMMUNITY }, label: "Rename", enabled: true }],
  links: [],
  attached: [],
};

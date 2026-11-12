import { describe, expect, it } from "vitest";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { COMMUNITY_MANAGEMENT_SURFACE } from "@/lib/community-management/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { ORGANIZATION_DIRECTORY_SURFACE } from "@/lib/organization-directory/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import { MGM_BUNDLED_PLUGINS, type BundledPlugin, type CoreEntityKind } from "@/lib/plugins/bundled";
import type { Id, Manifest } from "../../../contract";
import { buildManifestModel, type ManifestInput } from "../manifest-model";
import { entityFromPath, legacyView, resolveLegacyView } from "../legacy-view";

const ORG = "e7300000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7300000-0000-4000-8000-000000000002";
const COMMUNITY = "e7300000-0000-4000-8001-000000000001";
const MICROGRID = "e7300000-0000-4000-8002-000000000001";
const ORPHAN = "e7300000-0000-4000-8002-000000000002";
const STRANGER = "e7300000-0000-4000-8002-000000000099";
const DEEPER = "e7300000-0000-4000-8009-000000000001";

const SURFACES = [
  ORGANIZATION_DIRECTORY_SURFACE,
  COMMUNITY_MANAGEMENT_SURFACE,
  METERING_SURFACE,
  BILLING_SURFACE,
  PAYMENTS_SURFACE,
];

function manifest(superAdmin = true): Manifest {
  return buildManifestModel({
    release: null,
    locale: "en",
    now: new Date(0),
    gui: "gridtop",
    user: { name: null },
    superAdmin,
    org: { id: ORG, name: "Org One" },
    orgs: [],
    gate: Object.fromEntries(MGM_BUNDLED_PLUGINS.map((p) => [p.name, true])),
    nav: SURFACES.flatMap((s) => (s.nav ?? []).map((def) => ({ plugin: s.plugin, def }))) as ManifestInput["nav"],
    views: [],
    status: [],
    communities: [{ id: COMMUNITY, name: "Kasana" }],
    microgrids: [
      { id: MICROGRID, name: "Kasana East", communityId: COMMUNITY, timezone: null },
      { id: ORPHAN, name: "Loose", communityId: null, timezone: null },
    ],
  });
}

const MANIFEST = manifest();
const ID_OF: Partial<Record<CoreEntityKind, string>> = { organization: ORG, community: COMMUNITY, microgrid: MICROGRID };
const PAGES = MGM_BUNDLED_PLUGINS.flatMap((p) => p.pages);

/** A catalog page's path with each segment filled by the fixture id of its kind. */
const filled = (page: (typeof PAGES)[number]) =>
  page.path.replace(/\[(.+?)\]/g, (_, name: string) => ID_OF[page.params[name]] ?? DEEPER);

/** The current app of every catalog page, for a super admin with every plugin on. */
const CURRENT_APP: Record<string, Id | null> = {
  "/": "org.today",
  "/organizations": "org.organizations",
  "/organizations/[id]": "org.organizations",
  "/settings/profile": "org.profile",
  "/settings/users": "org.users",
  "/settings/plugins": "org.plugins",
  "/settings/api-tokens": null,
  "/communities": "community.communities",
  "/communities/[id]": "community.communities",
  "/microgrids": "community.microgrids",
  "/microgrids/[id]/setup": "community.microgrids",
  "/microgrids/[id]/setup/households": "community.households",
  "/microgrids/[id]/setup/households/[householdId]": "community.households",
  "/microgrids/[id]/operations": "metering.operations",
  "/microgrids/[id]/setup/edges": "metering.devices",
  "/microgrids/[id]/setup/edges/[edgeId]": "metering.devices",
  "/microgrids/[id]/setup/edges/shared": "metering.devices",
  "/microgrids/[id]/setup/openems-backend": "metering.data-source",
  "/microgrids/[id]/billing": "billing.periods",
  "/microgrids/[id]/billing/[periodId]": "billing.periods",
  "/microgrids/[id]/billing/[periodId]/history": "billing.periods",
  "/microgrids/[id]/setup/rates": "billing.tariff",
  "/communities/[id]/invoice": "billing.invoice-branding",
  "/organizations/[id]/payments": "payments.org-accounts",
  "/communities/[id]/payment": "community.communities",
};

/** Every href the manifest holds, or a nav pattern filled with an id it holds. */
function heldHrefs(m: Manifest): Set<string> {
  const ids = { organization: m.org.id, community: COMMUNITY, microgrid: MICROGRID } as Record<string, string>;
  return new Set([
    m.org.href,
    ...m.org.places.flatMap((p) => (p.href ? [p.href] : [])),
    ...m.org.nav.map((n) => n.href.replace(/\[(\w+)\]/g, (_, kind: string) => ids[kind] ?? "?")),
  ]);
}

describe("legacyView on every catalog page", () => {
  it("names a current app for every page, and a new page fails until it is placed here", () => {
    expect(Object.keys(CURRENT_APP).sort()).toEqual(PAGES.map((p) => p.path).sort());
  });

  for (const page of PAGES) {
    const path = filled(page);
    const kinds = Object.values(page.params);
    it(`${page.path}`, () => {
      for (const variant of [path, path === "/" ? path : `${path}/`,`${path}?tab=x&y=1`, `${path}#top`]) {
        const view = legacyView(variant, MANIFEST)!;
        expect(view, variant).not.toBeNull();
        expect(view.nav, variant).toBe(CURRENT_APP[page.path]);
        expect(view.unplaced).toBe(false);
        expect(view.view).toBeNull();
        expect(view.tabs).toEqual([]);
        expect(view.trail[0]).toEqual({ label: "Org One", href: `/organizations/${ORG}` });
        expect(view.scope.organization?.id).toBe(ORG);
        expect(view.scope.microgrid?.label).toBe(kinds.includes("microgrid") ? "Kasana East" : undefined);
        const hasCommunity = kinds.includes("microgrid") || kinds.includes("community");
        expect(view.scope.community?.label).toBe(hasCommunity ? "Kasana" : undefined);
        // Deeper records are not labelled in the shell, and each ref has only EntityRef's keys.
        expect(Object.keys(view.scope).every((k) => ["organization", "community", "microgrid"].includes(k))).toBe(true);
        for (const ref of Object.values(view.scope)) {
          expect(Object.keys(ref!).every((k) => ["kind", "id", "label", "href"].includes(k))).toBe(true);
        }
        const navTitle = MANIFEST.org.nav.find((n) => n.id === view.nav)?.title;
        expect(view.title).toBe(navTitle ?? "Org One");
        const held = heldHrefs(MANIFEST);
        for (const crumb of view.trail) expect(held.has(crumb.href), crumb.href).toBe(true);
      }
    });
  }

  it("entityFromPath gives the deepest organization, community or microgrid of each page", () => {
    for (const page of PAGES) {
      const kind = Object.values(page.params).filter((k) => k in ID_OF).at(-1);
      expect(entityFromPath(filled(page)), page.path).toEqual(kind ? { kind, id: ID_OF[kind] } : null);
    }
  });
});

describe("legacyView trails", () => {
  const crumbs = (path: string) => legacyView(path, MANIFEST)!.trail.map((c) => c.label);

  it("follows organization, community, microgrid, then the app unless it is the last crumb", () => {
    expect(crumbs("/")).toEqual(["Org One", "Dashboard"]);
    expect(crumbs(`/microgrids/${MICROGRID}/billing/${DEEPER}/history`)).toEqual(["Org One", "Kasana", "Kasana East", "Billing"]);
    expect(legacyView(`/microgrids/${MICROGRID}/billing/${DEEPER}`, MANIFEST)!.trail.at(-1)?.href).toBe(
      `/microgrids/${MICROGRID}/billing`,
    );
    // The microgrid's own href is its Operations page, so the app is not repeated.
    expect(crumbs(`/microgrids/${MICROGRID}/operations`)).toEqual(["Org One", "Kasana", "Kasana East"]);
    expect(crumbs(`/communities/${COMMUNITY}/payment`)).toEqual(["Org One", "Kasana", "Communities"]);
    expect(crumbs(`/microgrids/${ORPHAN}/setup/rates`)).toEqual(["Org One", "Loose", "Rate Schedule"]);
  });

  it("names no app when the caller's nav has no entry for the page", () => {
    const view = legacyView(`/organizations/${ORG}`, manifest(false))!;
    expect(view.nav).toBeNull();
    expect(view.title).toBe("Org One");
    expect(view.trail).toEqual([{ label: "Org One", href: `/organizations/${ORG}` }]);
  });

  it("gives no crumb to a place without an href, and keeps it in scope", () => {
    const places = MANIFEST.org.places.map((p) => (p.kind === "community" ? { kind: p.kind, id: p.id, label: p.label } : p));
    const view = legacyView(`/microgrids/${MICROGRID}/setup/rates`, { org: { ...MANIFEST.org, places } })!;
    expect(view.scope.community?.label).toBe("Kasana");
    expect(view.trail.map((c) => c.label)).toEqual(["Org One", "Kasana East", "Rate Schedule"]);
  });

  it("titles a page with no current app by its last crumb", () => {
    const view = legacyView(`/microgrids/${MICROGRID}/billing`, { org: { ...MANIFEST.org, nav: [] } })!;
    expect(view.nav).toBeNull();
    expect(view.title).toBe("Kasana East");
  });

  it("fits a nav segment of a kind only where the page has a segment of that kind", () => {
    const plugins: BundledPlugin[] = [
      { ...MGM_BUNDLED_PLUGINS[0], pages: [{ path: "/organizations/archive/payments", params: {} }] },
    ];
    expect(legacyView("/organizations/archive/payments", MANIFEST, plugins)!.nav).toBe("org.organizations");
  });

  it("entityFromPath gives the deepest place when a page names two", () => {
    const plugins: BundledPlugin[] = [
      {
        ...MGM_BUNDLED_PLUGINS[0],
        pages: [{ path: "/organizations/[o]/microgrids/[m]", params: { o: "organization", m: "microgrid" } }],
      },
    ];
    expect(entityFromPath(`/organizations/${ORG}/microgrids/${MICROGRID}`, plugins)).toEqual({
      kind: "microgrid",
      id: MICROGRID,
    });
  });

  it("decodes percent-encoded segments", () => {
    const encoded = `/microgrids/%${MICROGRID.charCodeAt(0).toString(16)}${MICROGRID.slice(1)}/billing`;
    expect(legacyView(encoded, MANIFEST)!.scope.microgrid?.id).toBe(MICROGRID);
    expect(entityFromPath(encoded)).toEqual({ kind: "microgrid", id: MICROGRID });
    expect(legacyView("/microgrids/%E0%A4%A/billing", MANIFEST)).toBeNull();
    expect(entityFromPath("/microgrids/%E0%A4%A/billing")).toBeNull();
  });
});

describe("legacyView on an untrusted path", () => {
  it("returns nothing for a path that is no catalog page", () => {
    for (const path of [
      "",
      "microgrids",
      "https://example.test/microgrids",
      "/icons/nope.png",
      "/api/organizations",
      `/microgrids/${MICROGRID}`,
      `/microgrids/${MICROGRID}/admin`,
      `/microgrids/${MICROGRID}/billing/${DEEPER}/history/more`,
      "/settings",
    ]) {
      expect(legacyView(path, MANIFEST), path).toBeNull();
      expect(entityFromPath(path), path).toBeNull();
    }
  });

  it("labels nothing the manifest does not hold, and says the path is unplaced", () => {
    const view = legacyView(`/microgrids/${STRANGER}/billing`, MANIFEST)!;
    expect(view.unplaced).toBe(true);
    expect(view.nav).toBe("billing.periods");
    expect(view.scope).toEqual({ organization: expect.objectContaining({ id: ORG }) });
    expect(view.trail).toEqual([{ label: "Org One", href: `/organizations/${ORG}` }]);
    expect(JSON.stringify(view)).not.toContain(STRANGER);
  });

  it("matches a path id only against places of the kind its segment names", () => {
    const view = legacyView(`/microgrids/${COMMUNITY}/billing`, MANIFEST)!;
    expect(view.unplaced).toBe(true);
    expect(view.scope.microgrid).toBeUndefined();
    expect(view.trail).toEqual([{ label: "Org One", href: `/organizations/${ORG}` }]);
  });

  it("does not fill an app link with another organization's id", () => {
    const view = legacyView(`/organizations/${OTHER_ORG}/payments`, MANIFEST)!;
    expect(view.unplaced).toBe(true);
    expect(view.trail.map((c) => c.href)).toEqual([`/organizations/${ORG}`]);
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
  });

  it("keeps an encoded slash inside one id, which matches no place", () => {
    const view = legacyView("/microgrids/..%2F..%2Fapi%2Fx/billing", MANIFEST)!;
    expect(view.unplaced).toBe(true);
    expect(JSON.stringify(view)).not.toContain("api");
  });

  it("returns nothing for a page outside the given catalog, or one a view serves", () => {
    const forged: BundledPlugin = { ...MGM_BUNDLED_PLUGINS[0], pages: [{ path: "/forged/[id]", params: { id: "microgrid" } }] };
    expect(legacyView(`/forged/${MICROGRID}`, MANIFEST)).toBeNull();
    expect(legacyView(`/forged/${MICROGRID}`, MANIFEST, [forged])).not.toBeNull();
    const served: BundledPlugin = { ...forged, pages: [{ path: "/forged/[id]", params: { id: "microgrid" }, servedBy: "view" }] };
    expect(legacyView(`/forged/${MICROGRID}`, MANIFEST, [served])).toBeNull();
  });
});

describe("resolveLegacyView", () => {
  it("is legacyView on a catalog page served outside the contract", () => {
    const path = `/microgrids/${MICROGRID}/billing`;
    expect(resolveLegacyView(path, MANIFEST)).toEqual(legacyView(path, MANIFEST));
  });

  it("shows the organization alone on any other path", () => {
    for (const path of ["/no-such-page", `/microgrids/${MICROGRID}`, "", "https://example.test/"]) {
      expect(resolveLegacyView(path, MANIFEST), path).toEqual({
        view: null,
        title: "Org One",
        trail: [{ label: "Org One", href: `/organizations/${ORG}` }],
        tabs: [],
        scope: { organization: { kind: "organization", id: ORG, label: "Org One", href: `/organizations/${ORG}` } },
        unplaced: false,
      });
    }
  });
});

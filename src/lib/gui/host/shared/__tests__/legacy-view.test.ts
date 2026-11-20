import { describe, expect, it } from "vitest";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { COMMUNITY_MANAGEMENT_SURFACE } from "@/lib/community-management/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { ORGANIZATION_DIRECTORY_SURFACE } from "@/lib/organization-directory/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import { MGM_BUNDLED_PLUGINS, type BundledPlugin, type CoreEntityKind } from "@/lib/plugins/bundled";
import type { Id, Manifest } from "../../../contract";
import { buildManifestModel, buildTenantManifestModel, type ManifestInput } from "../manifest-model";
import { contributedView, entityFromPath, legacyView, resolveLegacyView, unloadedView } from "../legacy-view";

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
    staff: true,
    tenant: false,
    org: { id: ORG, name: "Org One" },
    orgs: [],
    gate: Object.fromEntries(MGM_BUNDLED_PLUGINS.map((p) => [p.name, true])),
    nav: SURFACES.flatMap((s) => (s.nav ?? []).map((def) => ({ plugin: s.plugin, def }))) as ManifestInput["nav"],
    // A nav entry that names a view takes its href from the view's path.
    views: SURFACES.flatMap((s) => (s.views ?? []).map((def) => ({ plugin: s.plugin, def }))) as ManifestInput["views"],
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
const ALL_PAGES = MGM_BUNDLED_PLUGINS.flatMap((p) => p.pages);
/** The pages served outside the contract, the only ones legacyView describes. */
const PAGES = ALL_PAGES.filter((p) => p.servedBy === undefined);
/** The catalog with no page served by a view, so legacyView describes every page. */
const UNSERVED: BundledPlugin[] = MGM_BUNDLED_PLUGINS.map((p) => ({
  ...p,
  pages: p.pages.map((page) => ({ path: page.path, params: page.params })),
}));

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
  "/microgrids/[id]/setup/tenants": "community.tenants",
  "/microgrids/[id]/setup/tenants/[tenantId]": "community.tenants",
  "/microgrids/[id]/setup/edges": "metering.devices",
  "/microgrids/[id]/setup/edges/[edgeId]": "metering.devices",
  "/microgrids/[id]/setup/edges/shared": "metering.devices",
  "/microgrids/[id]/setup/openems-backend": "metering.data-source",
  "/microgrids/[id]/billing/[periodId]": "billing.periods",
  "/microgrids/[id]/setup/rates": "billing.tariff",
  "/communities/[id]/invoice": "billing.invoice-branding",
  "/organizations/[id]/payments": "payments.org-accounts",
  "/organizations/[id]/email": "org.organizations",
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

  it("leaves each page a view serves to contributedView", () => {
    /** The view that serves each page, and its current app in this staff manifest. */
    const SERVED: Record<string, [view: Id, nav: Id | null]> = {
      "/microgrids/[id]/operations": ["metering.site-day", "metering.operations"],
      "/microgrids/[id]/operations/savings": ["billing.savings", "metering.operations"],
      "/microgrids/[id]/billing": ["billing.periods", "billing.periods"],
      "/microgrids/[id]/billing/[periodId]/history": ["billing.period-history", "billing.periods"],
      "/microgrids/[id]/billing/[periodId]/close": ["billing.close-checklist", "billing.periods"],
      "/microgrids/[id]/billing/[periodId]/send": ["billing.send-queue", "billing.periods"],
      "/microgrids/[id]/billing/[periodId]/payments": ["payments.bill-attempts", "billing.periods"],
      "/microgrids/[id]/billing/[periodId]/payment-setup": ["payments.payment-setup", "billing.periods"],
      // Tenant pages: a staff manifest has no tenant entry, and /my names no place.
      "/my": ["tenant.home", null],
      "/my/usage": ["tenant.usage-month", null],
      "/my/usage/day": ["tenant.usage-day", null],
    };
    const served = ALL_PAGES.filter((p) => p.servedBy === "view");
    expect(served.map((p) => p.path).sort()).toEqual(Object.keys(SERVED).sort());
    for (const page of served) {
      const [id, nav] = SERVED[page.path];
      expect(legacyView(filled(page), MANIFEST), page.path).toBeNull();
      const view = contributedView(filled(page), { view: id, title: "Title", trail: [] }, MANIFEST);
      expect(view, page.path).toMatchObject({ view: id, title: "Title", nav, unplaced: false });
      expect(view.scope.microgrid?.label).toBe(Object.values(page.params).includes("microgrid") ? "Kasana East" : undefined);
    }
  });

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
    // History is served by a view; UNSERVED asks what its place would be outside the contract.
    expect(legacyView(`/microgrids/${MICROGRID}/billing/${DEEPER}/history`, MANIFEST, UNSERVED)!.trail.map((c) => c.label)).toEqual([
      "Org One",
      "Kasana",
      "Kasana East",
      "Billing",
    ]);
    expect(legacyView(`/microgrids/${MICROGRID}/billing/${DEEPER}`, MANIFEST)!.trail.at(-1)?.href).toBe(
      `/microgrids/${MICROGRID}/billing`,
    );
    // The microgrid's own href is its Operations page, so the app is not repeated.
    expect(legacyView(`/microgrids/${MICROGRID}/operations`, MANIFEST, UNSERVED)!.trail.map((c) => c.label)).toEqual([
      "Org One",
      "Kasana",
      "Kasana East",
    ]);
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
    const view = legacyView(`/microgrids/${MICROGRID}/setup/rates`, { org: { ...MANIFEST.org, nav: [] } })!;
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
    const encoded = `/microgrids/%${MICROGRID.charCodeAt(0).toString(16)}${MICROGRID.slice(1)}/setup/rates`;
    expect(legacyView(encoded, MANIFEST)!.scope.microgrid?.id).toBe(MICROGRID);
    expect(entityFromPath(encoded)).toEqual({ kind: "microgrid", id: MICROGRID });
    expect(legacyView("/microgrids/%E0%A4%A/setup/rates", MANIFEST)).toBeNull();
    expect(entityFromPath("/microgrids/%E0%A4%A/setup/rates")).toBeNull();
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
    const view = legacyView(`/microgrids/${STRANGER}/setup/rates`, MANIFEST)!;
    expect(view.unplaced).toBe(true);
    expect(view.nav).toBe("billing.tariff");
    expect(view.scope).toEqual({ organization: expect.objectContaining({ id: ORG }) });
    expect(view.trail).toEqual([{ label: "Org One", href: `/organizations/${ORG}` }]);
    expect(JSON.stringify(view)).not.toContain(STRANGER);
  });

  it("matches a path id only against places of the kind its segment names", () => {
    const view = legacyView(`/microgrids/${COMMUNITY}/setup/rates`, MANIFEST)!;
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
    const view = legacyView("/microgrids/..%2F..%2Fapi%2Fx/setup/rates", MANIFEST)!;
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
    const path = `/microgrids/${MICROGRID}/setup/rates`;
    expect(resolveLegacyView(path, MANIFEST)).toEqual(legacyView(path, MANIFEST));
  });

  it("gives a page a view serves its place with no view, as the first paint does, until the view is published", () => {
    for (const path of [`/microgrids/${MICROGRID}/operations?date=2026-11-10`, `/microgrids/${MICROGRID}/operations/savings`]) {
      const resolved = resolveLegacyView(path, MANIFEST);
      expect(resolved.view, path).toBeNull();
      expect(resolved.scope.microgrid?.id, path).toBe(MICROGRID);
      expect(resolved.trail.map((crumb) => crumb.label), path).toEqual(["Org One", "Kasana", "Kasana East"]);
      expect(resolved, path).toEqual({ ...unloadedView(path, "metering.site-day", MANIFEST)!, view: null });
    }
    expect(resolveLegacyView(`/microgrids/${STRANGER}/operations`, MANIFEST).unplaced).toBe(true);
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

describe("contributedView", () => {
  const model = { view: "metering.site-day" as const, title: "Tuesday", trail: [] };

  it("takes the view's id and title, and the scope, trail and current app from the path", () => {
    const path = `/microgrids/${MICROGRID}/operations?date=2026-11-10`;
    // What legacyView would say if the page were served outside the contract.
    const legacy = legacyView(path, MANIFEST, UNSERVED)!;
    expect(legacy.nav).toBe("metering.operations");
    expect(contributedView(path, model, MANIFEST)).toEqual({ ...legacy, view: "metering.site-day", title: "Tuesday" });
  });

  it("derives the same answer for a page the catalog marks as served by a view", () => {
    const forged: BundledPlugin = { ...MGM_BUNDLED_PLUGINS[0], pages: [{ path: "/forged/[id]", params: { id: "microgrid" }, servedBy: "view" }] };
    const view = contributedView(`/forged/${MICROGRID}`, model, MANIFEST, [forged]);
    expect(view).toMatchObject({ view: "metering.site-day", title: "Tuesday", unplaced: false });
    expect(view.scope.microgrid?.id).toBe(MICROGRID);
    expect(view.trail.map((crumb) => crumb.label)).toEqual(["Org One", "Kasana", "Kasana East"]);
  });

  it("marks a place the manifest does not list", () => {
    expect(contributedView(`/microgrids/${STRANGER}/operations`, model, MANIFEST).unplaced).toBe(true);
  });

  it("off the catalog, shows the organization and then the model's trail", () => {
    const trail = [{ label: "Somewhere", href: "/somewhere" as const }];
    expect(contributedView("/no-such-page", { ...model, trail }, MANIFEST)).toEqual({
      view: "metering.site-day",
      title: "Tuesday",
      trail: [{ label: "Org One", href: `/organizations/${ORG}` }, ...trail],
      tabs: [],
      scope: { organization: { kind: "organization", id: ORG, label: "Org One", href: `/organizations/${ORG}` } },
      nav: null,
      unplaced: false,
    });
  });
});

describe("a tenant manifest (RFC mgm#197 § 4)", () => {
  const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
  const UNIT_B = "e7400000-0000-4000-8000-00000000000b";
  const home = { id: "tenant.home" as const, title: "My home", icon: "tenants" as const, group: "operate" as const, order: 80, href: "/my" as const, needs: [] };

  /** A tenant manifest whose nav holds the tenant home. */
  function tenantManifest(units: { id: string; label: string }[], current: string | null = null): Manifest {
    const m = buildTenantManifestModel({
      release: null,
      locale: "en",
      now: new Date(0),
      gui: "gridtop",
      user: { name: null },
      units: units.map((u) => ({ ...u, timezone: "Africa/Kampala" })),
      current,
      tenantGate: {},
      nav: [],
      views: [],
    });
    return { ...m, org: { ...m.org, nav: [home] } };
  }

  it("puts the unit's name where the organization, community and microgrid go", () => {
    const m = tenantManifest([{ id: UNIT_A, label: "Grace Namata" }]);
    const view = unloadedView("/my", "tenant.home", m);
    expect(view).toEqual({
      view: "tenant.home",
      title: "My home",
      trail: [{ label: "Grace Namata", href: "/my" }],
      tabs: [],
      scope: { organization: { kind: "organization", id: UNIT_A, label: "Grace Namata", href: "/my" } },
      nav: "tenant.home",
      unplaced: false,
    });
    expect(contributedView("/my", { view: "tenant.home", title: "Grace Namata", trail: [] }, m)).toMatchObject({
      title: "Grace Namata",
      trail: [{ label: "Grace Namata", href: "/my" }],
    });
  });

  it("names the current unit, then the home that lets a person with two choose", () => {
    const m = tenantManifest(
      [
        { id: UNIT_A, label: "Grace Namata" },
        { id: UNIT_B, label: "Shop 9" },
      ],
      UNIT_B,
    );
    expect(unloadedView(`/my?unit=${UNIT_B}`, "tenant.home", m)?.trail).toEqual([
      { label: "Shop 9", href: `/my?unit=${UNIT_B}` },
      { label: "My home", href: "/my" },
    ]);
  });

  it("shows the unit alone on any other path, and labels no staff place", () => {
    const m = tenantManifest([{ id: UNIT_A, label: "Grace Namata" }]);
    expect(resolveLegacyView("/no-such-page", m)).toMatchObject({ title: "Grace Namata", trail: [{ label: "Grace Namata", href: "/my" }] });
    const staffPage = legacyView(`/microgrids/${MICROGRID}/setup/rates`, m)!;
    expect(staffPage).toMatchObject({ nav: null, unplaced: true });
    expect(staffPage.scope.microgrid).toBeUndefined();
  });
});

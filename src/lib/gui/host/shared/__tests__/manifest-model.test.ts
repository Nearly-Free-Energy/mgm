import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { GUI_CONTRACT, type Id, type StatusItem } from "../../../contract";
import type { NavDef } from "../../../surface";
import { manifestSchema } from "../../server/model-schema";
import {
  MAX_ORGS,
  MAX_PLACES_PER_KIND,
  buildManifestModel,
  kindNamedHref,
  livePlugins,
  type ManifestInput,
} from "../manifest-model";

const ORG = "e7100000-0000-4000-8000-000000000001";
const OTHER = "e7100000-0000-4000-8000-000000000002";
const uuid = (n: number) => `e7100000-0000-4000-8002-${String(n).padStart(12, "0")}`;
const ALL_ON: ManifestInput["gate"] = {
  "organization-directory": true,
  "community-management": true,
  metering: true,
  billing: true,
  payments: true,
  pesapal: true,
};

/** Today's pages as legacy entries, one per row of the shell's navigation table. */
const LEGACY: [MgmPluginName, Id, string, NavDef["icon"], NavDef["group"], string, ("microgrid" | "community" | "organization")?][] = [
  ["organization-directory", "org.today", "Dashboard", "today", "operate", "/"],
  ["community-management", "community.microgrids", "Microgrids", "sites", "operate", "/microgrids"],
  ["community-management", "community.communities", "Communities", "communities", "operate", "/communities"],
  ["metering", "metering.operations", "Operations", "live", "operate", "/microgrids/[id]/operations", "microgrid"],
  ["community-management", "community.households", "Households", "households", "operate", "/microgrids/[id]/setup/households", "microgrid"],
  ["metering", "metering.devices", "Edges & devices", "devices", "operate", "/microgrids/[id]/setup/edges", "microgrid"],
  ["billing", "billing.periods", "Billing", "billing", "money", "/microgrids/[id]/billing", "microgrid"],
  ["billing", "billing.tariff", "Rate schedule", "tariff", "configure", "/microgrids/[id]/setup/rates", "microgrid"],
  ["metering", "metering.data-source", "OpenEMS backend", "data-source", "configure", "/microgrids/[id]/setup/openems-backend", "microgrid"],
  ["billing", "billing.invoice-branding", "Invoice", "branding", "configure", "/communities/[id]/invoice", "community"],
  ["payments", "payments.org-accounts", "Payment accounts", "accounts", "configure", "/organizations/[id]/payments", "organization"],
  ["organization-directory", "org.plugins", "Plugins", "plugins", "system", "/settings/plugins"],
  ["organization-directory", "org.users", "Users", "users", "system", "/settings/users"],
  ["organization-directory", "org.profile", "Profile", "profile", "system", "/settings/profile"],
];

const legacyNav: ManifestInput["nav"] = [
  ...LEGACY.map(([plugin, id, title, icon, group, href, need], order) => ({
    plugin,
    def: { id, title, icon, group, order, href: href as `/${string}`, needs: need ? [need] : [], legacy: true as const },
  })),
  {
    plugin: "organization-directory",
    def: {
      id: "org.organizations",
      title: "Organizations",
      icon: "organizations",
      group: "system",
      order: 99,
      href: "/organizations",
      needs: [],
      legacy: true,
      audience: "super-admin",
    },
  },
];

function input(over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    release: null,
    locale: "en-UG",
    now: new Date("2026-11-09T08:00:00Z"),
    gui: "gridtop",
    user: { name: "Ada Okello", email: "ada@test.local" },
    superAdmin: false,
    org: { id: ORG, name: "Org A" },
    orgs: [
      { id: ORG, name: "Org A" },
      { id: OTHER, name: "Org B" },
    ],
    gate: ALL_ON,
    nav: legacyNav,
    views: [],
    status: [],
    communities: [{ id: uuid(1), name: "Community 1" }],
    microgrids: [{ id: uuid(2), name: "Microgrid 1", communityId: uuid(1), timezone: "Africa/Kampala" }],
    ...over,
  };
}

const navIds = (i: ManifestInput) => buildManifestModel(i).org.nav.map((n) => n.id);

describe("buildManifestModel", () => {
  it("builds a manifest the strict schema accepts", () => {
    const m = buildManifestModel(input({ release: "v0.0.5" }));
    expect(manifestSchema.parse(m)).toEqual(m);
    expect(m).toMatchObject({
      type: "manifest",
      contract: GUI_CONTRACT,
      release: "v0.0.5",
      now: "2026-11-09T08:00:00.000Z",
      gui: "gridtop",
      org: { id: ORG, href: `/organizations/${ORG}`, timezone: "Africa/Kampala" },
      orgs: [
        { id: ORG, href: `/organizations/${ORG}` },
        { id: OTHER, href: `/organizations/${OTHER}` },
      ],
    });
    expect(manifestSchema.safeParse(buildManifestModel(input())).success).toBe(true);
  });

  it("keeps only the person's name and email", () => {
    const user = { name: null, email: "ada@test.local", phone: "+256700000000", app_metadata: { a: 1 }, identities: [] };
    expect(buildManifestModel(input({ user })).user).toStrictEqual({ name: null, email: "ada@test.local" });
  });

  it("shows super-admin entries to super admins only", () => {
    expect(navIds(input())).not.toContain("org.organizations");
    expect(navIds(input({ superAdmin: true }))).toContain("org.organizations");
  });

  it("drops the nav and status of a plugin that is off, or whose dependency is off", () => {
    const status: ManifestInput["status"] = [
      { plugin: "billing", item: { id: "billing.due", label: "Due", state: "idle", open: "/microgrids" } },
    ];
    const off = buildManifestModel(input({ gate: { ...ALL_ON, metering: false }, status }));
    const ids = off.org.nav.map((n) => n.id);
    expect(ids.filter((id) => id.startsWith("metering.") || id.startsWith("billing."))).toEqual([]);
    expect(ids).toContain("community.households");
    expect(off.org.status).toEqual([]);
    expect(buildManifestModel(input({ status })).org.status).toEqual([status[0].item]);
    // A plugin the gate did not answer for counts as off.
    expect(livePlugins({ "organization-directory": true })).toEqual(new Set(["organization-directory"]));
  });

  it("lists only the path's own places while community management is off", () => {
    const gate = { ...ALL_ON, "community-management": false };
    const m = buildManifestModel(input({ gate }));
    expect(m.org.places).toEqual([]);
    expect(m.org.nav.map((n) => n.id)).toEqual(["org.today", "org.plugins", "org.users", "org.profile"]);
    const here = { kind: "microgrid" as const, id: uuid(2), label: "Microgrid 1", parent: uuid(1) };
    expect(buildManifestModel(input({ gate, scope: { microgrid: here } })).org.places).toEqual([
      { kind: "microgrid", id: uuid(2), label: "Microgrid 1", href: `/microgrids/${uuid(2)}/operations`, parent: uuid(1) },
    ]);
  });

  it("writes kind-named placeholders and marks legacy entries", () => {
    const nav = buildManifestModel(input()).org.nav;
    expect(nav.find((n) => n.id === "billing.periods")).toEqual({
      id: "billing.periods",
      title: "Billing",
      icon: "billing",
      group: "money",
      order: 6,
      href: "/microgrids/[microgrid]/billing",
      needs: ["microgrid"],
      legacy: true,
    });
    expect(nav.find((n) => n.id === "payments.org-accounts")?.href).toBe("/organizations/[organization]/payments");
    expect(nav.find((n) => n.id === "org.today")).toMatchObject({ href: "/", needs: [] });
  });

  it("points a view's entry at its path with kind-named placeholders, and drops what cannot be named", () => {
    const view = (id: Id, path: string, params: Record<string, string>) => ({
      plugin: "metering" as const,
      def: { id, path, params: params as Record<string, "microgrid"> },
    });
    const viewNav = (id: Id, v: Id): ManifestInput["nav"][number] => ({
      plugin: "metering",
      def: { id, title: id, icon: "live", group: "operate", order: 1, view: v },
    });
    const m = buildManifestModel(
      input({
        nav: [viewNav("metering.day", "metering.day"), viewNav("metering.own", "metering.own"), viewNav("metering.gone", "metering.none")],
        views: [
          view("metering.day", "/microgrids/[id]/operations", { id: "microgrid" }),
          view("metering.own", "/microgrids/[id]/operations/[sendId]", { id: "microgrid", sendId: "metering.send" }),
        ],
      }),
    );
    expect(m.org.nav).toEqual([
      expect.objectContaining({ id: "metering.day", href: "/microgrids/[microgrid]/operations", needs: ["microgrid"] }),
    ]);
    expect(m.org.nav[0]).not.toHaveProperty("legacy");
  });

  it("drops an entry whose route is not released", () => {
    const nav: ManifestInput["nav"] = [
      ...legacyNav,
      {
        plugin: "billing",
        def: { id: "billing.later", title: "Later", icon: "billing", group: "money", order: 1, href: "/microgrids/[id]/later", needs: ["microgrid"], legacy: true },
      },
    ];
    expect(navIds(input({ nav }))).not.toContain("billing.later");
    const status: ManifestInput["status"] = [
      { plugin: "billing", item: { id: "billing.due", label: "Due", state: "idle", open: "/unreleased" } },
    ];
    expect(buildManifestModel(input({ status })).org.status).toEqual([]);
  });

  it("drops an entry that is not a same-origin path, even where its route pattern matches", () => {
    const nav: ManifestInput["nav"] = [
      { plugin: "community-management", def: { ...legacyNav[2].def, id: "community.evil", href: "/communities/%2fevil", needs: [] } as NavDef },
    ];
    const status: ManifestInput["status"] = [
      { plugin: "billing", item: { id: "billing.due", label: "Due", state: "idle", open: "/communities/%2fevil" as `/${string}` } },
    ];
    const m = buildManifestModel(input({ nav, status }));
    expect([m.org.nav, m.org.status]).toEqual([[], []]);
    expect(manifestSchema.safeParse(m).success).toBe(true);
  });

  it("orders entries by group, then order, then id", () => {
    const tie = { plugin: "organization-directory" as const, def: { ...legacyNav[12].def, id: "org.aaa" as Id } };
    const ids = navIds(input({ nav: [tie, ...legacyNav].reverse(), superAdmin: true }));
    expect(ids).toEqual([
      "org.today",
      "community.microgrids",
      "community.communities",
      "metering.operations",
      "community.households",
      "metering.devices",
      "billing.periods",
      "billing.tariff",
      "metering.data-source",
      "billing.invoice-branding",
      "payments.org-accounts",
      "org.plugins",
      "org.aaa",
      "org.users",
      "org.profile",
      "org.organizations",
    ]);
  });

  it("keeps each microgrid's community as its parent, caps places, and keeps the path's own", () => {
    const many = Array.from({ length: MAX_PLACES_PER_KIND + 5 }, (_, i) => ({
      id: uuid(100 + i),
      name: `Microgrid ${i}`,
      communityId: uuid(1),
      timezone: null,
    }));
    const beyond = { kind: "microgrid" as const, id: uuid(999), label: "Far away", href: `/microgrids/${uuid(999)}/operations` as const, parent: uuid(1) };
    const places = buildManifestModel(input({ microgrids: many, scope: { microgrid: beyond } })).org.places;
    expect(places[0]).toEqual({ kind: "community", id: uuid(1), label: "Community 1", href: `/communities/${uuid(1)}` });
    expect(places[1]).toEqual({
      kind: "microgrid",
      id: uuid(100),
      label: "Microgrid 0",
      href: `/microgrids/${uuid(100)}/operations`,
      parent: uuid(1),
    });
    expect(places.filter((p) => p.kind === "microgrid")).toHaveLength(MAX_PLACES_PER_KIND + 1);
    expect(places.at(-1)).toEqual(beyond);
  });

  it("caps communities, and gives a path microgrid past the cap the path's community as its parent", () => {
    const communities = Array.from({ length: MAX_PLACES_PER_KIND + 5 }, (_, i) => ({ id: uuid(100 + i), name: `Community ${i}` }));
    const community = { kind: "community" as const, id: uuid(998), label: "Far community" };
    const microgrid = { kind: "microgrid" as const, id: uuid(999), label: "Far microgrid" };
    const places = buildManifestModel(input({ communities, scope: { community, microgrid } })).org.places;
    expect(places.filter((p) => p.kind === "community")).toHaveLength(MAX_PLACES_PER_KIND + 1);
    expect(places.slice(-2)).toEqual([
      { ...community, href: `/communities/${uuid(998)}` },
      { ...microgrid, href: `/microgrids/${uuid(999)}/operations`, parent: uuid(998) },
    ]);
  });

  it("lists a path place that is already listed once", () => {
    const microgrid = { kind: "microgrid" as const, id: uuid(2), label: "Microgrid 1" };
    const places = buildManifestModel(input({ scope: { microgrid } })).org.places;
    expect(places.filter((p) => p.id === uuid(2))).toHaveLength(1);
  });

  it("gives a time zone only when every microgrid shares one", () => {
    const microgrids = [
      { id: uuid(2), name: "A", communityId: null, timezone: "Africa/Kampala" },
      { id: uuid(3), name: "B", communityId: null, timezone: "Africa/Nairobi" },
    ];
    expect(buildManifestModel(input({ microgrids })).org.timezone).toBeNull();
    expect(buildManifestModel(input({ microgrids: [] })).org.timezone).toBeNull();
  });

  it("caps the switcher and keeps the current organization in it", () => {
    const orgs = buildManifestModel(input({ orgs: [{ id: OTHER, name: "Org B" }] })).orgs;
    expect(orgs.map((o) => o.id)).toEqual([OTHER, ORG]);
    const many = Array.from({ length: MAX_ORGS + 5 }, (_, i) => ({ id: uuid(300 + i), name: `Org ${i}` }));
    const capped = buildManifestModel(input({ orgs: [...many, { id: ORG, name: "Org A" }] })).orgs;
    expect(capped).toHaveLength(MAX_ORGS + 1);
    expect(capped.at(-1)?.id).toBe(ORG);
  });

  // JSON is a proxy for the payload the layout renders; the browser smoke measures the page itself.
  it("stays within 8 KB gzipped for an organization with ten microgrids", () => {
    const status: ManifestInput["status"] = (["community-management", "metering", "billing", "payments"] as const).map(
      (plugin): { plugin: MgmPluginName; item: StatusItem } => ({
        plugin,
        item: { id: `${plugin === "community-management" ? "community" : plugin}.status` as Id, label: "Needs you", state: "needs-you", open: "/microgrids" },
      }),
    );
    const m = buildManifestModel(
      input({
        superAdmin: true,
        status,
        communities: [
          { id: uuid(1), name: "Community one" },
          { id: uuid(2), name: "Community two" },
        ],
        microgrids: Array.from({ length: 10 }, (_, i) => ({
          id: uuid(10 + i),
          name: `Microgrid number ${i}`,
          communityId: uuid(1 + (i % 2)),
          timezone: "Africa/Kampala",
        })),
      }),
    );
    expect(m.org.places).toHaveLength(12);
    expect(m.org.nav).toHaveLength(15);
    expect(gzipSync(JSON.stringify(m)).length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("kindNamedHref", () => {
  it("renames each segment after its kind", () => {
    expect(kindNamedHref("/microgrids/[id]/billing/[periodId]", (n) => (n === "id" ? "microgrid" : "billingPeriod"))).toEqual({
      href: "/microgrids/[microgrid]/billing/[billingPeriod]",
      needs: ["microgrid", "billingPeriod"],
    });
  });

  it("refuses a plugin's own kind, a repeated kind and an unreleased route", () => {
    expect(kindNamedHref("/microgrids/[id]", () => "metering.send")).toBeNull();
    expect(kindNamedHref("/microgrids/[a]/billing/[b]", () => "microgrid")).toBeNull();
    expect(kindNamedHref("/nowhere/[id]", () => "microgrid")).toBeNull();
  });
});

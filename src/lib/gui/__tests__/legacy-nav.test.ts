/**
 * The navigation capabilities contribute for pages served outside the GUI
 * contract (`legacy: true`, src/lib/<capability>/surface.ts), which the
 * interface shell shows in place of the old sidebar and the home page's quick
 * links. These checks keep it complete and stable: every link the old chrome
 * offered has an entry with its label, every released page is reached from
 * an entry or a page link that exists, each entry's `needs` matches its
 * page's segments, and ids and groups do not change, since /go/<id> links
 * will name them.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Icon, NavGroup } from "@/lib/gui/contract";
import type { NavDef } from "@/lib/gui/surface";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { MGM_BUNDLED_PLUGINS, matchCatalogPage, type MgmPluginName } from "@/lib/plugins/bundled";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";

type Legacy = Extract<NavDef, { legacy: true }>;
type Entry = { plugin: MgmPluginName; def: Legacy };

/**
 * Every entry by id, as spec-shell §6.2 lays out the dock: [title, group,
 * icon, order]. The ids are what /go/<id> links will name; change one only
 * with a redirect from the old id. A group also decides which views an
 * assistant may not read (contribution-schema.ts refuses `agent: "read"` on a
 * view whose entry is in configure or system), so a page that later moves to
 * a view takes its group along.
 */
const ROWS: Record<string, [title: string, group: NavGroup, icon: Icon, order: number]> = {
  "org.today": ["Dashboard", "operate", "today", 10],
  "community.microgrids": ["Microgrids", "operate", "sites", 20],
  "community.communities": ["Communities", "operate", "communities", 30],
  "metering.operations": ["Operations", "operate", "live", 40],
  "community.households": ["Households", "operate", "households", 50],
  "metering.devices": ["Edges & Devices", "operate", "devices", 60],
  "billing.periods": ["Billing", "money", "billing", 10],
  "billing.tariff": ["Rate Schedule", "configure", "tariff", 10],
  "metering.data-source": ["OpenEMS Backend", "configure", "data-source", 20],
  "billing.invoice-branding": ["Invoice branding", "configure", "branding", 30],
  "payments.org-accounts": ["Payment accounts", "configure", "accounts", 40],
  "org.plugins": ["Plugins", "system", "plugins", 10],
  "org.users": ["Users", "system", "users", 20],
  "org.profile": ["Profile", "system", "profile", 30],
  "org.organizations": ["Organizations", "system", "organizations", 40],
};

/**
 * The sidebar the shell replaced, as it was: its links, with Organizations
 * shown to super admins only.
 */
const OLD_SIDEBAR: { label: string; href: string; superAdminOnly?: true }[] = [
  { label: "Dashboard", href: "/" },
  { label: "Organizations", href: "/organizations", superAdminOnly: true },
  { label: "Communities", href: "/communities" },
  { label: "Microgrids", href: "/microgrids" },
  { label: "Settings", href: "/settings/profile" },
];

/** Sidebar labels the dock replaces with its own entries: Settings opened Profile, beside Users and Plugins. */
const SIDEBAR_RENAMED: Record<string, string> = { Settings: "org.profile" };

/** The hrefs of the home page's quick-link row the shell replaced. */
const OLD_QUICK_LINKS = ["/organizations", "/communities", "/microgrids", "/settings/plugins"];

const GUI = "src/app/(gui)";
const pageFile = (pattern: string) => `${GUI}${pattern === "/" ? "" : pattern}/page.tsx`;

/**
 * Released pages without a nav entry of their own, with the page that reaches
 * each one. `from` is a page that links to it; `redirectsTo` is where it sends
 * old bookmarks, since nothing links to it any more. `link` is the source
 * text that makes the claim true: it is in the last file of `via`, and each
 * file from the page's own page.tsx (the `from` page's, or for a redirect the
 * redirecting page's) imports the next.
 */
type Reach = ({ from: string } | { redirectsTo: string }) & { via?: string[]; link: string };
const REACHED_IN_PAGE: Record<string, Reach> = {
  "/organizations/[id]": { from: "/organizations", link: "href={`/organizations/${org.id}`}" },
  "/communities/[id]": { from: "/communities", link: "href={`/communities/${community.id}`}" },
  "/microgrids/[id]/setup": {
    redirectsTo: "/microgrids/[id]/setup/edges",
    via: ["src/lib/microgrid-links.ts"],
    link: "return `/microgrids/${microgridId}/setup/edges`;",
  },
  "/microgrids/[id]/setup/households/[householdId]": {
    from: "/microgrids/[id]/setup/households",
    via: [`${GUI}/microgrids/[id]/setup/households/households-section.tsx`, "src/components/HouseholdTable.tsx"],
    link: "href={`/microgrids/${microgridId}/setup/households/${household.id}`}",
  },
  "/microgrids/[id]/setup/edges/[edgeId]": {
    from: "/microgrids/[id]/setup/edges",
    link: "href={`/microgrids/${id}/setup/edges/${edge.id}`}",
  },
  "/microgrids/[id]/setup/edges/shared": {
    from: "/microgrids/[id]/setup/edges",
    link: "href={`/microgrids/${id}/setup/edges/shared`}",
  },
  "/microgrids/[id]/billing/[periodId]": {
    from: "/microgrids/[id]/billing",
    via: ["src/components/BillingPeriodList.tsx"],
    link: "href={`/microgrids/${microgridId}/billing/${period.id}`}",
  },
  "/microgrids/[id]/billing/[periodId]/history": {
    from: "/microgrids/[id]/billing/[periodId]",
    via: ["src/components/BillingTable.tsx"],
    link: "href={`/microgrids/${microgridId}/billing/${period.id}/history`}",
  },
  "/communities/[id]/payment": {
    from: "/microgrids/[id]/billing/[periodId]",
    via: ["src/components/BillingTable.tsx"],
    link: "href={`/communities/${communityId}/payment`}",
  },
};

const ROOT = path.resolve(__dirname, "../../../..");
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** The repository files `file` imports through `@/` or relative specifiers, without extensions. */
function imports(file: string): Set<string> {
  const out = new Set<string>();
  for (const [, spec] of source(file).matchAll(/from\s+"([^"]+)"/g)) {
    if (spec.startsWith("@/")) out.add(path.posix.join("src", spec.slice(2)));
    else if (spec.startsWith(".")) out.add(path.posix.join(path.posix.dirname(file), spec));
  }
  return out;
}
const withoutExt = (file: string) => file.replace(/\.tsx?$/, "");

/** `{ label: "…", segment: "…" }` tabs in a sub-nav's source, as hrefs under `base`. */
function tabs(file: string, base: string): { href: string; label: string }[] {
  return [...source(file).matchAll(/\{\s*label:\s*"([^"]+)",\s*segment:\s*"([^"]+)"/g)].map(([, label, segment]) => ({
    href: `${base}/${segment}`,
    label,
  }));
}

/** The text of the link whose opening tag holds `href`, in `file`. */
function linkText(file: string, href: string): string | undefined {
  const at = source(file).indexOf(href);
  if (at < 0) return undefined;
  return /^[^>]*>\s*([^<{]+?)\s*</.exec(source(file).slice(at))?.[1];
}

async function legacyNav(): Promise<Entry[]> {
  const { nav } = (await getMgmRuntime()).mgmSurface.snapshot();
  return nav.map(({ plugin, def }) => {
    if (!("legacy" in def)) throw new Error(`${def.id} names a view; this test covers legacy entries only`);
    return { plugin, def };
  });
}

const fill = (pattern: string) => pattern.replace(/\[[^\]]+\]/g, "x");

afterAll(() => resetMgmRuntimeForTests());

describe("legacy navigation", () => {
  it("keeps every link the old sidebar offered, with its label", async () => {
    const nav = await legacyNav();
    for (const link of OLD_SIDEBAR) {
      const entry = nav.find((e) => e.def.href === link.href);
      expect(entry, `no nav entry for the sidebar's ${link.label}`).toBeDefined();
      const renamed = SIDEBAR_RENAMED[link.label];
      if (renamed) expect(entry!.def.id).toBe(renamed);
      else expect(entry!.def.title).toBe(link.label);
    }
  });

  it("shows super admins only what the old sidebar showed only to them", async () => {
    const onlyAdmins = OLD_SIDEBAR.filter((link) => link.superAdminOnly).map((link) => link.href);
    const nav = await legacyNav();
    expect(nav.filter((e) => e.def.audience === "super-admin").map((e) => e.def.href)).toEqual(onlyAdmins);
  });

  it("keeps every link the home page's old quick-link row offered", async () => {
    const hrefs = new Set<string>((await legacyNav()).map((e) => e.def.href));
    expect(OLD_QUICK_LINKS.filter((href) => !hrefs.has(href))).toEqual([]);
  });

  it("reaches every released catalog page from a nav entry or a page link", async () => {
    const hrefs = new Set<string>((await legacyNav()).map((e) => e.def.href));
    const released = MGM_BUNDLED_PLUGINS.flatMap((p) => p.pages.map((page) => page.path)).filter((p) =>
      isReleasedRoute(fill(p)),
    );
    expect(released.filter((p) => !hrefs.has(p) && !Object.hasOwn(REACHED_IN_PAGE, p))).toEqual([]);
    // Each listed page is a released page without an entry, and leads back to one.
    expect(Object.keys(REACHED_IN_PAGE).filter((p) => !released.includes(p) || hrefs.has(p))).toEqual([]);
    for (const start of Object.keys(REACHED_IN_PAGE)) {
      let at = start;
      for (let hops = 0; !hrefs.has(at); hops++) {
        expect(hops, `${start} does not lead back to a nav entry`).toBeLessThan(5);
        const via = REACHED_IN_PAGE[at];
        expect(via, `${at} is neither a nav entry nor reached in a page`).toBeDefined();
        at = "from" in via ? via.from : via.redirectsTo;
      }
    }
  });

  it("finds each in-page link REACHED_IN_PAGE names, on the page it names", () => {
    for (const [target, reach] of Object.entries(REACHED_IN_PAGE)) {
      const chain = [pageFile("from" in reach ? reach.from : target), ...(reach.via ?? [])];
      for (let i = 1; i < chain.length; i++) {
        const [file, next] = [chain[i - 1], chain[i]];
        expect(imports(file).has(withoutExt(next)), `${target}: ${file} does not import ${next}`).toBe(true);
      }
      const last = chain[chain.length - 1];
      expect(source(last).includes(reach.link), `${target}: no ${reach.link} in ${last}`).toBe(true);
    }
  });

  it("keeps each entry's title, group, icon and order", async () => {
    const nav = await legacyNav();
    const rows = nav.map(({ def }) => [def.id, [def.title, def.group, def.icon, def.order]]);
    expect(Object.fromEntries(rows)).toEqual(ROWS);
  });

  it("keeps the labels the sub-navs and in-page links show today", async () => {
    const titles = new Map<string, string>((await legacyNav()).map((e) => [e.def.href, e.def.title]));
    const subNavs = [
      tabs(`${GUI}/microgrids/[id]/tab-nav.tsx`, "/microgrids/[id]"),
      tabs(`${GUI}/microgrids/[id]/setup/setup-subnav.tsx`, "/microgrids/[id]/setup"),
      tabs(`${GUI}/settings/settings-subnav.tsx`, "/settings"),
    ];
    for (const found of subNavs) expect(found.length, "a sub-nav's tabs could not be read").toBeGreaterThan(0);
    const shown = [
      ...subNavs.flat(),
      {
        href: "/communities/[id]/invoice",
        label: linkText(pageFile("/communities/[id]"), "href={`/communities/${community.id}/invoice`}"),
      },
      {
        href: "/organizations/[id]/payments",
        label: linkText(pageFile("/organizations/[id]"), "href={`/organizations/${id}/payments`}"),
      },
    ];
    for (const { href, label } of shown) {
      // The Setup tab opens its first sub-tab, which has its own entry.
      if (href === "/microgrids/[id]/setup") continue;
      expect(titles.get(href), href).toBe(label);
    }
  });

  it("gives each entry the needs its page's segments name, in path order", async () => {
    for (const { plugin, def } of await legacyNav()) {
      const match = matchCatalogPage(def.href);
      expect(match?.page.path, `${def.id}: ${def.href} is not a catalog page`).toBe(def.href);
      expect(match!.plugin.name).toBe(plugin);
      expect(def.needs, def.id).toEqual(Object.values(match!.page.params));
      expect(isReleasedRoute(fill(def.href)), `${def.href} is not released`).toBe(true);
    }
  });

  it("keeps ids unique, URL-safe and stable", async () => {
    const ids = (await legacyNav()).map((e) => e.def.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
    expect([...ids].sort()).toEqual(Object.keys(ROWS).sort());
  });

  it("names the Operations day metering.operations and leaves metering.live reserved", async () => {
    const nav = await legacyNav();
    expect(nav.find((e) => e.def.href === "/microgrids/[id]/operations")?.def.id).toBe("metering.operations");
    expect(nav.some((e) => e.def.id === "metering.live")).toBe(false);
  });
});

/**
 * The catalog's pages against src/app (docs/cordis-runtime.md § "Catalog
 * pages"): every signed-in page.tsx is listed by exactly one plugin with the
 * entity kind of each bracketed segment, every listed page is served, and
 * the catalog agrees with src/lib/mgm/released-routes.ts and getRouteOwner.
 */
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import {
  CORE_ENTITY_KINDS,
  MGM_BUNDLED_PLUGINS,
  getRouteOwner,
  matchCatalogPage,
  type CoreEntityKind,
  type MgmPluginName,
} from "../bundled";

const APP_ROOT = path.resolve(__dirname, "..", "..", "..", "app");
const PAGE_FILE = /^page\.(?:tsx|ts|jsx|js)$/;

/**
 * Pages the host serves outside any plugin. There is no check that each is
 * still a page: a host page that becomes a route handler, or goes away,
 * should not have to edit this code-owned file.
 */
const HOST_PAGES: Record<string, string> = {
  "/login": "Sign-in, before any organization is known.",
  "/forgot-password": "Password reset request, signed out.",
  "/reset-password": "Password reset from the emailed link.",
  "/accept-invite": "Invitation acceptance, before the user has a role.",
  "/no-access": "Shown to a signed-in user with no role.",
  "/setup": "First-run setup, before any organization exists.",
  "/review": "Redirects old bookmarks to the dashboard; owns no content.",
  "/go/[nav]": "Opens any plugin's navigation entry by its id; owns no content.",
};

/**
 * Catalog pages that src/lib/mgm/released-routes.ts does not release yet.
 * Each entry must stay a catalog page and stay unreleased, so releasing it
 * fails this test until the entry is removed.
 */
const UNRELEASED_PAGES: Record<string, string> = {
  "/settings/api-tokens": "Organization API tokens are not released yet.",
};

/**
 * The entity kind of each bracketed segment, by its name, or by the segment
 * before it and its name. A page with a bracket name missing here fails until
 * the name is added.
 */
const SEGMENT_KINDS: Record<string, CoreEntityKind> = {
  "organizations/[id]": "organization",
  "communities/[id]": "community",
  "microgrids/[id]": "microgrid",
  "[edgeId]": "edge",
  "[householdId]": "household",
  "[periodId]": "billingPeriod",
};

/** The plugin that owns each page. Moving a page changes this table too. */
const PAGE_OWNERS: Record<string, MgmPluginName> = {
  "/": "organization-directory",
  "/organizations": "organization-directory",
  "/organizations/[id]": "organization-directory",
  "/settings/profile": "organization-directory",
  "/settings/users": "organization-directory",
  "/settings/plugins": "organization-directory",
  "/settings/api-tokens": "organization-directory",
  "/communities": "community-management",
  "/communities/[id]": "community-management",
  "/microgrids": "community-management",
  "/microgrids/[id]/setup": "community-management",
  "/microgrids/[id]/setup/households": "community-management",
  "/microgrids/[id]/setup/households/[householdId]": "community-management",
  "/microgrids/[id]/operations": "metering",
  "/microgrids/[id]/setup/edges": "metering",
  "/microgrids/[id]/setup/edges/[edgeId]": "metering",
  "/microgrids/[id]/setup/edges/shared": "metering",
  "/microgrids/[id]/setup/openems-backend": "metering",
  "/microgrids/[id]/billing": "billing",
  "/microgrids/[id]/billing/[periodId]": "billing",
  "/microgrids/[id]/billing/[periodId]/history": "billing",
  "/microgrids/[id]/setup/rates": "billing",
  "/communities/[id]/invoice": "billing",
  "/organizations/[id]/payments": "payments",
  "/communities/[id]/payment": "payments",
};

/** URL paths of every page file under src/app, outside api and tests. */
function appPages(dir = APP_ROOT, segments: string[] = []): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && PAGE_FILE.test(entry.name)) {
      found.push(`/${segments.join("/")}`);
    }
    if (!entry.isDirectory()) continue;
    if (segments.length === 0 && entry.name === "api") continue;
    if (entry.name === "__tests__") continue;
    // Next.js does not route private folders.
    if (entry.name.startsWith("_")) continue;
    // A route group, "(name)", and a parallel-route slot, "@name", are left
    // out of the URL.
    const next = /^(?:\(.+\)|@.+)$/.test(entry.name) ? segments : [...segments, entry.name];
    found.push(...appPages(path.join(dir, entry.name), next));
  }
  return found;
}

function bracketNames(pagePath: string): string[] {
  return pagePath
    .split("/")
    .map((segment) => /^\[(.+)\]$/.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** A concrete URL for a page: each bracketed segment becomes "s1". */
function sample(pagePath: string): string {
  return pagePath.replace(/\[[^\]]+\]/g, "s1");
}

const catalog = MGM_BUNDLED_PLUGINS.flatMap((plugin) =>
  plugin.pages.map((page) => ({ plugin, page }))
);
const pagesOnDisk = appPages();

describe("catalog pages", () => {
  it("finds the app's pages", () => {
    expect(pagesOnDisk.length).toBeGreaterThan(0);
  });

  it("lists every page path once", () => {
    const paths = catalog.map(({ page }) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists exactly the plugin pages that have a page file", () => {
    const pluginPages = pagesOnDisk.filter(
      (pagePath) =>
        !Object.hasOwn(HOST_PAGES, pagePath) &&
        // A catch-all segment ([...x] or [[...x]]) belongs to the host.
        !/\[\[?\.\.\./.test(pagePath)
    );
    const listed = catalog
      .filter(({ page }) => page.servedBy === undefined)
      .map(({ page }) => page.path);
    expect([...new Set(pluginPages)].sort()).toEqual([...listed].sort());
    expect(new Set(pluginPages).size).toBe(pluginPages.length);
  });

  it("has no page file for a page a view serves", () => {
    for (const { page } of catalog.filter(({ page }) => page.servedBy === "view")) {
      expect(pagesOnDisk, page.path).not.toContain(page.path);
    }
  });

  it("lists no API path, so pages never decide API ownership", () => {
    for (const { page } of catalog) {
      expect(page.path === "/api" || page.path.startsWith("/api/"), page.path).toBe(false);
    }
  });

  it("lists no host page", () => {
    for (const { page } of catalog) {
      expect(Object.hasOwn(HOST_PAGES, page.path), page.path).toBe(false);
    }
  });

  it("gives every bracketed segment one entity kind, in path order", () => {
    for (const { page } of catalog) {
      expect(Object.keys(page.params), page.path).toEqual(bracketNames(page.path));
      for (const kind of Object.values(page.params)) {
        expect(CORE_ENTITY_KINDS, page.path).toContain(kind);
      }
    }
  });

  it("gives each bracketed segment the kind its name stands for", () => {
    for (const { page } of catalog) {
      const segments = page.path.split("/").filter(Boolean);
      segments.forEach((segment, index) => {
        const name = /^\[(.+)\]$/.exec(segment)?.[1];
        if (name === undefined) return;
        const kind =
          SEGMENT_KINDS[`${segments[index - 1]}/${segment}`] ?? SEGMENT_KINDS[segment];
        expect(kind, `${page.path}: add ${segment} to SEGMENT_KINDS`).toBeDefined();
        expect(page.params[name], `${page.path} ${segment}`).toBe(kind);
      });
    }
  });

  it("gives each page to its owner", () => {
    expect(
      Object.fromEntries(catalog.map(({ plugin, page }) => [page.path, plugin.name]))
    ).toEqual(PAGE_OWNERS);
  });

  it("matches each page's own URL to that page", () => {
    for (const { plugin, page } of catalog) {
      const match = matchCatalogPage(sample(page.path));
      expect(match?.page, page.path).toBe(page);
      expect(match?.plugin, page.path).toBe(plugin);
    }
  });

  it("agrees with the released routes", () => {
    for (const { page } of catalog) {
      expect(isReleasedRoute(sample(page.path)), page.path).toBe(
        !Object.hasOwn(UNRELEASED_PAGES, page.path)
      );
    }
    const paths = new Set(catalog.map(({ page }) => page.path));
    for (const unreleased of Object.keys(UNRELEASED_PAGES)) {
      expect(paths.has(unreleased), unreleased).toBe(true);
    }
  });

  it("gives each page to the plugin that lists it", () => {
    for (const { plugin, page } of catalog) {
      expect(getRouteOwner(page.path)?.name, page.path).toBe(plugin.name);
    }
  });
});

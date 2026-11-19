/**
 * The (gui) layout: the redirects for signed-out, first-run and revoked
 * users, in their order; a person whose rows are all tenant rows sent from
 * every page but a tenant view's (the staff start page and every other staff
 * page included) to their home while it is a released route and to
 * /no-access until then, never to /setup, and otherwise to /no-access only
 * when the manifest refuses (RFC mgm#197 § 4); the manifest read started alongside them; and every page
 * rendered inside the shell of the GUI MGM_GUI selects, with the manifest
 * and the view the path names. A render the middleware did not see answers
 * 404 before any of that.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { COMMUNITY_MANAGEMENT_SURFACE } from "@/lib/community-management/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { ORGANIZATION_DIRECTORY_SURFACE } from "@/lib/organization-directory/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import type { Manifest } from "@/lib/gui/contract";
import { buildManifestModel, type ManifestInput } from "@/lib/gui/host/shared/manifest-model";
import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { resetMgmRuntimeForTests } from "@/lib/runtime/root";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  getRequestUserAccess: vi.fn(),
  organizationExists: vi.fn(),
  getManifest: vi.fn(),
  preloadManifest: vi.fn(),
  resolveInitialView: vi.fn(),
  isReleasedRoute: vi.fn<(path: string) => boolean>(() => true),
  headers: new Headers(),
  cookies: new Map<string, string>(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    get: (name: string) => (mocks.cookies.has(name) ? { name, value: mocks.cookies.get(name) } : undefined),
  }),
}));
vi.mock("@/lib/auth/request-access", () => ({
  getRequestUserAccess: mocks.getRequestUserAccess,
}));
vi.mock("@/lib/mgm/organization-exists", () => ({
  organizationExists: mocks.organizationExists,
}));
// The middleware answers an unreleased page before the layout runs, so the
// layout reads the list only for where to send a tenant from "/".
vi.mock("@/lib/mgm/released-routes", () => ({
  isReleasedRoute: mocks.isReleasedRoute,
}));
vi.mock("@/lib/gui/host/server/manifest", () => ({
  getManifest: mocks.getManifest,
  preloadManifest: mocks.preloadManifest,
}));
vi.mock("@/lib/gui/host/server/render-view", () => ({
  resolveInitialView: mocks.resolveInitialView,
}));
vi.mock("@/components/ui/navigation-progress", () => ({
  NavigationProgress: () => null,
}));

import { INSTALLED_GUIS } from "@/gui/installed";
import { HostKitProvider } from "@/lib/gui/host/client/host-kit-provider";
import { resolveLegacyView } from "@/lib/gui/host/shared/legacy-view";
import { TENANT_START_PAGE } from "@/lib/gui/host/shared/tenant-units";
import { NavigationProgress } from "@/components/ui/navigation-progress";
import GuiLayout from "../layout";

const ORG = "e7300000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7300000-0000-4000-8000-000000000002";
const COMMUNITY = "e7300000-0000-4000-8001-000000000001";
const MICROGRID = "e7300000-0000-4000-8002-000000000001";

const SURFACES = [
  ORGANIZATION_DIRECTORY_SURFACE,
  COMMUNITY_MANAGEMENT_SURFACE,
  METERING_SURFACE,
  BILLING_SURFACE,
  PAYMENTS_SURFACE,
];

const MANIFEST: Manifest = buildManifestModel({
  release: null,
  locale: "en",
  now: new Date(0),
  gui: "gridtop",
  user: { name: null, email: "manager@example.test" },
  superAdmin: false,
  staff: true,
  tenant: false,
  org: { id: ORG, name: "Org One" },
  orgs: [{ id: ORG, name: "Org One" }],
  gate: Object.fromEntries(MGM_BUNDLED_PLUGINS.map((p) => [p.name, true])),
  nav: SURFACES.flatMap((s) => (s.nav ?? []).map((def) => ({ plugin: s.plugin, def }))) as ManifestInput["nav"],
  views: [],
  status: [],
  communities: [{ id: COMMUNITY, name: "Kasana" }],
  microgrids: [{ id: MICROGRID, name: "Kasana East", communityId: COMMUNITY, timezone: null }],
});

function wire({ user, orgCount, roleCount }: {
  user: { id: string } | null;
  orgCount: number;
  roleCount: number;
}) {
  mocks.getRequestUserAccess.mockResolvedValue({
    user,
    roles: user
      ? Array.from({ length: roleCount }, () => ({
          user_id: user.id,
          role: "org_manager",
          scope_type: "org",
          scope_id: ORG,
        }))
      : [],
  });
  mocks.organizationExists.mockResolvedValue(orgCount > 0);
}

const SIGNED_IN = { user: { id: "user-1" }, orgCount: 1, roleCount: 1 };

/** What getManifest answers for a person who can see no organization. */
const NO_ORGANIZATION = {
  ok: false,
  status: 403,
  code: "gui_no_access",
  message: "Your account has no organization yet.",
} as const;

/** What the middleware forwards for "/" (src/middleware.ts). */
const MIDDLEWARE_SAW = () => new Headers({ "x-mgm-path": "/" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headers = MIDDLEWARE_SAW();
  mocks.cookies.clear();
  mocks.getManifest.mockResolvedValue({ ok: true, manifest: MANIFEST });
  mocks.resolveInitialView.mockResolvedValue(null);
  mocks.isReleasedRoute.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GuiLayout first-run routing", () => {
  it("redirects unauthenticated users to /login", async () => {
    wire({ user: null, orgCount: 0, roleCount: 0 });
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/login");
  });

  it("redirects unauthenticated users to /login even when the organization check fails", async () => {
    wire({ user: null, orgCount: 0, roleCount: 0 });
    mocks.organizationExists.mockRejectedValue(new Error("unavailable"));
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/login");
  });

  it("surfaces a failed organization check for a signed-in user", async () => {
    wire({ user: { id: "user-1" }, orgCount: 0, roleCount: 1 });
    mocks.organizationExists.mockRejectedValue(new Error("unavailable"));
    await expect(GuiLayout({ children: null })).rejects.toThrow("unavailable");
  });

  // These users can see no organization, so getManifest would refuse them
  // too; the layout's own redirects decide first and the manifest is not read.
  it("redirects the eligible first user to /setup before the role gate", async () => {
    // No organization and no roles: /setup wins over /no-access.
    wire({ user: { id: "user-1" }, orgCount: 0, roleCount: 0 });
    mocks.getManifest.mockResolvedValue(NO_ORGANIZATION);
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/setup");
    expect(mocks.organizationExists).toHaveBeenCalledOnce();
    expect(mocks.getManifest).not.toHaveBeenCalled();
  });

  it("retains /no-access when RLS hides an existing org from an unassigned user", async () => {
    wire({ user: { id: "user-1" }, orgCount: 1, roleCount: 0 });
    mocks.getManifest.mockResolvedValue(NO_ORGANIZATION);
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/no-access");
    expect(mocks.getManifest).not.toHaveBeenCalled();
  });

  it("sends a user whose roles reach no organization they can see to /no-access", async () => {
    wire(SIGNED_IN);
    mocks.getManifest.mockResolvedValue(NO_ORGANIZATION);
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/no-access");
  });

  it("sends a user whose session the manifest's own check refuses to /login", async () => {
    // getManifest reads the session again with getUser(), which can end
    // between the two reads (a sign-out elsewhere).
    wire(SIGNED_IN);
    mocks.getManifest.mockResolvedValue({
      ok: false,
      status: 401,
      code: "gui_unauthenticated",
      message: "Sign in to continue.",
    });
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/login");
  });

  it("reads the manifest only for a user who passed every redirect", async () => {
    wire({ user: null, orgCount: 1, roleCount: 0 });
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/login");
    expect(mocks.getManifest).not.toHaveBeenCalled();
  });

  it("starts the organization check and the manifest's reads before the user read resolves", async () => {
    // Both organization hints set, so the preload and the render must agree
    // on every argument for the render to reuse the preloaded read.
    mocks.headers = new Headers({ "x-mgm-path": `/microgrids?org=${OTHER_ORG}` });
    mocks.cookies.set("mgm-org", ORG);
    let resolveAccess: (value: unknown) => void = () => {};
    mocks.getRequestUserAccess.mockReturnValue(
      new Promise((resolve) => {
        resolveAccess = resolve;
      })
    );
    mocks.organizationExists.mockResolvedValue(true);

    const rendering = GuiLayout({ children: null });
    await vi.waitFor(() => expect(mocks.preloadManifest).toHaveBeenCalledOnce());
    expect(mocks.organizationExists).toHaveBeenCalledOnce();
    expect(mocks.getManifest).not.toHaveBeenCalled();

    resolveAccess({
      user: { id: "user-1" },
      roles: [{ user_id: "user-1", role: "super_admin", scope_type: "org", scope_id: null }],
    });
    expect(await rendering).toBeTruthy();
    // The same arguments, so the render reuses the preloaded read.
    expect(mocks.preloadManifest.mock.calls[0]).toEqual(["gridtop", `/microgrids?org=${OTHER_ORG}`, OTHER_ORG, ORG]);
    expect(mocks.getManifest.mock.calls).toEqual([mocks.preloadManifest.mock.calls[0]]);
  });
});

describe("GuiLayout for a person who holds units (RFC mgm#197 § 4)", () => {
  const UNIT_A = "e7300000-0000-4000-8003-000000000001";
  const UNIT_B = "e7300000-0000-4000-8003-000000000002";
  const tenantRow = (unit: string) => ({ user_id: "user-1", role: "tenant", scope_type: "tenant", scope_id: unit });
  const managerRow = { user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: ORG };
  function signIn(roles: unknown[], organizations = true) {
    mocks.getRequestUserAccess.mockResolvedValue({ user: { id: "user-1" }, roles });
    mocks.organizationExists.mockResolvedValue(organizations);
  }

  it.each(["/", "/?org=" + ORG, "/#top"])("sends a tenant-only person from the start page (%s) to their home once it is released, before the manifest", async (path) => {
    signIn([tenantRow(UNIT_A), tenantRow(UNIT_B)]);
    mocks.headers = new Headers({ "x-mgm-path": path });
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/my");
    expect(mocks.isReleasedRoute).toHaveBeenCalledWith("/my");
    expect(mocks.getManifest).not.toHaveBeenCalled();
  });

  it("sends a tenant-only person from the start page to /no-access, which can sign them out, while their home is not released", async () => {
    // The static "not in this release" page links back to "/", so sending
    // them to /my now would bring them straight back.
    mocks.isReleasedRoute.mockImplementation((path: string) => path !== "/my");
    signIn([tenantRow(UNIT_A)]);
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/no-access");
    expect(mocks.getManifest).not.toHaveBeenCalled();
  });

  it("never sends a tenant-only person to /setup, and renders their pages in the shell", async () => {
    // No organization is reported, as if the check had gone wrong: a tenant
    // is never the first operator.
    signIn([tenantRow(UNIT_A)], false);
    mocks.headers = new Headers({ "x-mgm-path": "/my?unit=" + UNIT_A });
    const tree = await GuiLayout({ children: "page" });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getManifest).toHaveBeenCalledWith("gridtop", "/my?unit=" + UNIT_A, null, null);
    expect(byType(tree, HostKitProvider)).toHaveLength(1);
  });

  it("sends a tenant-only person the manifest refuses to /no-access, as anyone", async () => {
    signIn([tenantRow(UNIT_A)]);
    mocks.headers = new Headers({ "x-mgm-path": "/my" });
    mocks.getManifest.mockResolvedValue(NO_ORGANIZATION);
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/no-access");
  });

  it("keeps a person with staff and tenant rows on the start page, like any staff", async () => {
    signIn([tenantRow(UNIT_A), managerRow]);
    expect(await GuiLayout({ children: null })).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getManifest).toHaveBeenCalledWith("gridtop", "/", null, null);
  });

  it("sends a person from the start page as a tenant once their staff row is gone, deciding from the rows held now", async () => {
    // A manager who rents, before and after DELETE /api/users/[id] removes
    // their org manager row: nothing remembers that they were staff.
    signIn([tenantRow(UNIT_A), managerRow]);
    expect(await GuiLayout({ children: null })).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();

    signIn([tenantRow(UNIT_A)]);
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/my");
  });

  it("still sends a person with staff rows and no organization to /setup", async () => {
    signIn([tenantRow(UNIT_A), managerRow], false);
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/setup");
  });
});

/**
 * The pages under this layout that the host owns: every page.tsx under
 * src/app/(gui) as its URL path, route groups dropped, but the catch-all,
 * which serves contributed views and is walked through the catalog's pages.
 */
function hostPages(): string[] {
  const root = join(process.cwd(), "src/app/(gui)");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && !entry.name.startsWith("[...")) walk(join(dir, entry.name));
      } else if (entry.name === "page.tsx") {
        const segments = relative(root, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
        found.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("GuiLayout keeps a person whose rows are all tenant rows to tenant pages (RFC mgm#197 § 4)", () => {
  // The surface is the real one, from the root runtime (only the shell's
  // first-paint view is mocked above), so which pages are a tenant view's is
  // decided by the contributed views, as in production.
  const UNIT = "e7300000-0000-4000-8003-000000000001";
  const ID = "e7300000-0000-4000-8004-000000000001";
  const tenantRows = [{ user_id: "user-1", role: "tenant", scope_type: "tenant", scope_id: UNIT }];
  const staffAndTenantRows = [...tenantRows, { user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: ORG }];
  const sample = (page: string) => page.replace(/\[[^\]]+\]/g, (name) => (name === "[nav]" ? "billing.periods" : ID));
  const CATALOG_PAGES = MGM_BUNDLED_PLUGINS.flatMap((plugin) => plugin.pages.map((page) => page.path));
  const HOST_PAGES = hostPages();
  const ALL_PAGES = [...new Set([...CATALOG_PAGES, ...HOST_PAGES])].sort();
  const STAFF_PAGES = ALL_PAGES.filter((page) => page !== TENANT_START_PAGE);

  /** Where the layout sends `roles` from `path`, or null when it renders the page. */
  async function opens(path: string, roles: unknown[]): Promise<string | null> {
    mocks.getRequestUserAccess.mockResolvedValue({ user: { id: "user-1" }, roles });
    mocks.organizationExists.mockResolvedValue(true);
    mocks.headers = new Headers({ "x-mgm-path": path });
    mocks.redirect.mockClear();
    mocks.getManifest.mockClear();
    try {
      await GuiLayout({ children: "page" });
      return null;
    } catch (error) {
      const message = (error as Error).message;
      if (!message.startsWith("redirect:")) throw error;
      return message.slice("redirect:".length);
    }
  }

  afterAll(async () => {
    await resetMgmRuntimeForTests();
  });

  it("finds the catalog's pages and the host's", () => {
    expect(CATALOG_PAGES.length).toBeGreaterThan(10);
    expect(HOST_PAGES).toEqual(expect.arrayContaining(["/", "/go/[nav]", "/settings/users", "/microgrids/[id]/billing"]));
  });

  it("opens the tenant home and nothing else among them", async () => {
    const open: string[] = [];
    for (const page of ALL_PAGES) {
      if ((await opens(sample(page), tenantRows)) === null) open.push(page);
    }
    expect(open).toEqual([TENANT_START_PAGE]);
  });

  it.each(STAFF_PAGES)("sends them from %s to their home before the manifest is read", async (page) => {
    expect(await opens(sample(page), tenantRows)).toBe(TENANT_START_PAGE);
    expect(mocks.getManifest).not.toHaveBeenCalled();
    // Naming one of their units changes nothing on a staff page.
    expect(await opens(`${sample(page)}?unit=${UNIT}`, tenantRows)).toBe(TENANT_START_PAGE);
  });

  it.each(["/no-such-page", "/api/users", `/my/${UNIT}`, "/My"])("sends them from %s, which no tenant view serves, to their home", async (path) => {
    expect(await opens(path, tenantRows)).toBe(TENANT_START_PAGE);
  });

  it.each(["/my", `/my?unit=${UNIT}`, `/my?unit=${ID}`])("renders %s, a tenant view's page, in the shell", async (path) => {
    // A unit that is not theirs is the view's to refuse (renderView), not the layout's.
    expect(await opens(path, tenantRows)).toBeNull();
    expect(mocks.getManifest).toHaveBeenCalledWith("gridtop", path, null, null);
  });

  it.each(STAFF_PAGES)("sends them from %s to /no-access, which can sign them out, while their home is not released", async (page) => {
    mocks.isReleasedRoute.mockImplementation((path: string) => path !== TENANT_START_PAGE);
    expect(await opens(sample(page), tenantRows)).toBe("/no-access");
  });

  it.each(ALL_PAGES)("leaves %s to the page for a person with staff and tenant rows", async (page) => {
    expect(await opens(sample(page), staffAndTenantRows)).toBeNull();
  });
});

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function all(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (typeof node !== "object" || node === null) return [];
  const el = node as Node;
  return [el, ...all(el.props?.children)];
}

const byType = (tree: unknown, type: unknown) => all(tree).filter((el) => el.type === type);

describe("GuiLayout for a render the middleware did not see", () => {
  // The middleware sets x-mgm-path on every page request it passes on, and
  // a browser never sends it, so a request without it reached this layout
  // without the middleware: no content security policy, no release
  // allowlist, no session check. Such a request answers 404 before the
  // layout reads anything.
  it.each([
    { who: "signed in", session: SIGNED_IN },
    { who: "signed out", session: { user: null, orgCount: 1, roleCount: 0 } },
  ])("answers 404 with no reads for a request without x-mgm-path ($who)", async ({ session }) => {
    wire(session);
    mocks.headers = new Headers();
    mocks.cookies.set("mgm-org", ORG);
    await expect(GuiLayout({ children: "page" })).rejects.toThrow("not-found");
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.organizationExists).not.toHaveBeenCalled();
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
    expect(mocks.preloadManifest).not.toHaveBeenCalled();
    expect(mocks.getManifest).not.toHaveBeenCalled();
    expect(mocks.resolveInitialView).not.toHaveBeenCalled();
  });

  it("answers 404 for an empty x-mgm-path, which the middleware never sends", async () => {
    wire(SIGNED_IN);
    mocks.headers = new Headers({ "x-mgm-path": "" });
    await expect(GuiLayout({ children: null })).rejects.toThrow("not-found");
    expect(mocks.organizationExists).not.toHaveBeenCalled();
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
    expect(mocks.preloadManifest).not.toHaveBeenCalled();
  });

  it("renders as usual once the middleware has set it", async () => {
    wire(SIGNED_IN);
    expect(await GuiLayout({ children: null })).toBeTruthy();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});

describe("GuiLayout shell", () => {
  it("renders every page inside the selected GUI's shell, inside the kit", async () => {
    wire(SIGNED_IN);
    const path = `/microgrids/${MICROGRID}/billing`;
    mocks.headers = new Headers({ "x-mgm-path": path });
    const tree = await GuiLayout({ children: "page" });

    const [provider] = byType(tree, HostKitProvider);
    const [shell] = byType(provider?.props?.children, INSTALLED_GUIS.gridtop.Shell);
    expect(shell, "the Shell sits inside the kit's provider").toBeDefined();
    expect(shell.props?.children).toBe("page");

    const initial = resolveLegacyView(path, MANIFEST);
    expect(provider.props).toMatchObject({ manifest: MANIFEST, initial });
    expect(shell.props).toMatchObject({ manifest: MANIFEST, initial });
    expect(initial).toMatchObject({ nav: "billing.periods", unplaced: false });
    expect(initial.scope.microgrid?.id).toBe(MICROGRID);
  });

  it("takes a contributed view's initial view from resolveInitialView, which loads no view", async () => {
    wire(SIGNED_IN);
    const path = `/microgrids/${MICROGRID}/operations/savings?date=2026-11-10`;
    mocks.headers = new Headers({ "x-mgm-path": path });
    const initial = { view: "billing.savings", title: "Operations", trail: [], tabs: [], scope: {} };
    mocks.resolveInitialView.mockResolvedValue(initial);
    const tree = await GuiLayout({ children: "page" });

    // Only the path and the manifest: with no access read, it cannot load the view, which the page alone does.
    expect(mocks.resolveInitialView).toHaveBeenCalledWith(path, MANIFEST);
    const [provider] = byType(tree, HostKitProvider);
    const [shell] = byType(provider?.props?.children, INSTALLED_GUIS.gridtop.Shell);
    expect(provider.props?.initial).toBe(initial);
    expect(shell.props?.initial).toBe(initial);
  });

  it("hands the GUI's own overlay and forms to the action host", async () => {
    wire(SIGNED_IN);
    const tree = await GuiLayout({ children: null });
    const [provider] = byType(tree, HostKitProvider);
    const { Overlay, forms } = INSTALLED_GUIS.gridtop;
    expect(provider.props?.actions).toEqual({ Overlay, forms });
  });

  it("keeps the navigation progress bar", async () => {
    wire(SIGNED_IN);
    expect(byType(await GuiLayout({ children: null }), NavigationProgress)).toHaveLength(1);
  });

  it("passes the path, its ?org= and the last-used organization to the manifest", async () => {
    wire(SIGNED_IN);
    mocks.headers = new Headers({ "x-mgm-path": `/microgrids?org=${OTHER_ORG}#top` });
    mocks.cookies.set("mgm-org", ORG);
    await GuiLayout({ children: null });
    expect(mocks.getManifest).toHaveBeenCalledWith("gridtop", `/microgrids?org=${OTHER_ORG}#top`, OTHER_ORG, ORG);
  });

  it("shows the organization alone for the start page or a path with no catalog page", async () => {
    wire(SIGNED_IN);
    const tree = await GuiLayout({ children: null });
    expect(mocks.getManifest).toHaveBeenCalledWith("gridtop", "/", null, null);
    const [provider] = byType(tree, HostKitProvider);
    expect(provider.props?.initial).toEqual(resolveLegacyView("/", MANIFEST));

    mocks.headers = new Headers({ "x-mgm-path": "/no-such-page" });
    const missing = byType(await GuiLayout({ children: null }), HostKitProvider)[0];
    expect(missing.props?.initial).toMatchObject({
      view: null,
      title: "Org One",
      trail: [{ label: "Org One", href: `/organizations/${ORG}` }],
      unplaced: false,
    });
  });
});

describe("GuiLayout stylesheet", () => {
  function links(tree: unknown): Node[] {
    return byType(tree, "link");
  }

  it("links exactly one stylesheet, the selected GUI's", async () => {
    wire(SIGNED_IN);
    const tree = await GuiLayout({ children: "child" });
    expect(links(tree).map((l) => l.props)).toEqual([
      { rel: "stylesheet", href: "/gui-styles/gridtop.css", precedence: "gui" },
    ]);
  });

  it("answers an MGM_GUI naming no compiled-in GUI with an error, after the redirects", async () => {
    vi.stubEnv("MGM_GUI", "nextgrid");
    wire({ user: null, orgCount: 1, roleCount: 0 });
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/login");
    wire({ user: { id: "user-1" }, orgCount: 0, roleCount: 0 });
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/setup");
    wire({ user: { id: "user-1" }, orgCount: 1, roleCount: 0 });
    await expect(GuiLayout({ children: null })).rejects.toThrow("redirect:/no-access");
    wire(SIGNED_IN);
    await expect(GuiLayout({ children: null })).rejects.toThrow(/MGM_GUI "nextgrid" names no installed GUI/);
    await expect(GuiLayout({ children: null })).rejects.toMatchObject({ name: "GuiSettingError" });
    expect(mocks.preloadManifest).not.toHaveBeenCalled();
    expect(mocks.getManifest).not.toHaveBeenCalled();
  });
});

/**
 * The (gui) layout: the redirects for signed-out, first-run and revoked
 * users, in their order; the manifest read started alongside them; and every
 * page rendered inside the shell of the GUI MGM_GUI selects, with the
 * manifest and the view the path names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { COMMUNITY_MANAGEMENT_SURFACE } from "@/lib/community-management/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { ORGANIZATION_DIRECTORY_SURFACE } from "@/lib/organization-directory/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import type { Manifest } from "@/lib/gui/contract";
import { buildManifestModel, type ManifestInput } from "@/lib/gui/host/shared/manifest-model";
import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  getRequestUserAccess: vi.fn(),
  organizationExists: vi.fn(),
  getManifest: vi.fn(),
  preloadManifest: vi.fn(),
  resolveInitialView: vi.fn(),
  headers: new Headers(),
  cookies: new Map<string, string>(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headers = new Headers();
  mocks.cookies.clear();
  mocks.getManifest.mockResolvedValue({ ok: true, manifest: MANIFEST });
  mocks.resolveInitialView.mockResolvedValue(null);
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
    expect(mocks.organizationExists).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.preloadManifest).toHaveBeenCalledOnce());
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

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function all(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (typeof node !== "object" || node === null) return [];
  const el = node as Node;
  return [el, ...all(el.props?.children)];
}

const byType = (tree: unknown, type: unknown) => all(tree).filter((el) => el.type === type);

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

  it("takes a contributed view's initial view from resolveInitialView, with the render's access read", async () => {
    wire(SIGNED_IN);
    const path = `/microgrids/${MICROGRID}/operations?date=2026-11-10`;
    mocks.headers = new Headers({ "x-mgm-path": path });
    const initial = { view: "metering.site-day", title: "Tuesday", trail: [], tabs: [], scope: {} };
    mocks.resolveInitialView.mockResolvedValue(initial);
    const tree = await GuiLayout({ children: "page" });

    const access = await mocks.getRequestUserAccess.mock.results[0].value;
    expect(mocks.resolveInitialView).toHaveBeenCalledWith(access, path, MANIFEST);
    // The same object, not a copy: the page's renderView shares the load only through React cache(), which keys on identity.
    expect(mocks.resolveInitialView.mock.calls[0][0]).toBe(access);
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

  it("shows the organization alone for a path without a header or a catalog page", async () => {
    wire(SIGNED_IN);
    const tree = await GuiLayout({ children: null });
    expect(mocks.getManifest).toHaveBeenCalledWith("gridtop", null, null, null);
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

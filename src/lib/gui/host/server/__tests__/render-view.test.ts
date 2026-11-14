import type { User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUserAccess } from "@/lib/auth/access";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { COMMUNITY_MANAGEMENT_SURFACE } from "@/lib/community-management/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { ORGANIZATION_DIRECTORY_SURFACE } from "@/lib/organization-directory/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import { Banner } from "@/components/ui/banner";
import type { GuiPlugin, Manifest, ViewModel, ViewProps } from "../../../contract";
import { KitView } from "../../../kit/kit-view";
import { RawView } from "../../../kit/raw-view";
import { ViewBoundary } from "../../client/view-boundary";
import { buildManifestModel, type ManifestInput } from "../../shared/manifest-model";
import type { HostContext } from "../access";

const mocks = vi.hoisted(() => ({
  dispatchView: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  cached: [] as unknown[][],
}));
vi.mock("../view", () => ({ dispatchView: mocks.dispatchView }));
// cache() memoizes nothing outside a server render; this records what the shared load is keyed on.
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => {
      mocks.cached.push(args);
      return fn(...args);
    },
  };
});
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": "en" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// The Operations page as a view would serve it, once its page.tsx is gone.
vi.mock("@/lib/plugins/bundled", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/plugins/bundled")>();
  const plugins = real.MGM_BUNDLED_PLUGINS.map((plugin) => ({
    ...plugin,
    pages: plugin.pages.map((page) =>
      page.path === "/microgrids/[id]/operations" ? { ...page, servedBy: "view" as const } : page,
    ),
  }));
  return {
    ...real,
    MGM_BUNDLED_PLUGINS: plugins,
    matchCatalogPage: (path: string, list = plugins) => real.matchCatalogPage(path, list),
  };
});

import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { pageHref, renderView, resolveInitialView } from "../render-view";

const ORG = "e7300000-0000-4000-8000-000000000001";
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

const ACCESS: CurrentUserAccess = {
  user: { id: "user-1", email: "manager@example.test" } as User,
  roles: [{ user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: ORG }] as CurrentUserAccess["roles"],
};

const MODEL = {
  type: "view",
  view: "metering.site-day",
  kind: "record",
  body: { sections: [] },
  title: "Tuesday 10 November",
  org: ORG,
  trail: [],
  actions: [],
  links: [],
  attached: [],
} as unknown as ViewModel;

const Bespoke = (props: ViewProps) => props.model.title;
const GUI: Pick<GuiPlugin, "contract" | "View" | "renderers"> = { contract: "^0.1", View: KitView };

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cached.length = 0;
  mocks.dispatchView.mockResolvedValue({ ok: true, value: MODEL });
});

describe("renderView", () => {
  it("loads the decoded path for the caller, the way GET /api/gui/view does", async () => {
    await renderView({ path: ["microgrids", MICROGRID, "operations"], search: { date: "2026-11-10", ui: undefined }, access: ACCESS, gui: GUI });
    const [ctx, href] = mocks.dispatchView.mock.calls[0] as [HostContext, string];
    expect(href).toBe(`/microgrids/${MICROGRID}/operations?date=2026-11-10`);
    expect(ctx.access.user).toBe(ACCESS.user);
    expect(ctx.access.roles).toEqual(ACCESS.roles);
    expect(ctx.locale).toBe("en");
    // React cache() keys on identity, so the layout and the page share the load only with the caller's own object.
    expect(mocks.cached[0][0]).toBe(ACCESS);
  });

  it("encodes each segment again, so a decoded slash stays inside its segment", async () => {
    await renderView({ path: ["microgrids", "a/b c"], search: { b: ["2", "3"], a: "1" }, access: ACCESS, gui: GUI });
    expect(mocks.dispatchView.mock.calls[0][1]).toBe("/microgrids/a%2Fb%20c?a=1&b=2&b=3");
  });

  it("draws the model with the active GUI's View inside a ViewBoundary", async () => {
    const tree = (await renderView({ path: ["x"], search: {}, access: ACCESS, gui: GUI })) as Node;
    expect(tree.type).toBe(ViewBoundary);
    expect(tree.props?.model).toBe(MODEL);
    expect(tree.props?.initial).toBeUndefined();
    const child = tree.props?.children as Node;
    expect(child.type).toBe(KitView);
    expect(child.props?.model).toBe(MODEL);
  });

  it("draws with the GUI's bespoke renderer when it reads the model's ext version, and RawView for a kind it cannot know", async () => {
    mocks.dispatchView.mockResolvedValue({ ok: true, value: { ...MODEL, ext: { schema: "metering.site-day@1", data: {} } } });
    const bespoke = { ...GUI, renderers: { "metering.site-day": { reads: [1], Component: Bespoke } } };
    const drawn = (await renderView({ path: ["x"], search: {}, access: ACCESS, gui: bespoke })) as Node;
    expect((drawn.props?.children as Node).type).toBe(Bespoke);

    const old = { ...GUI, contract: "^0.0" };
    const raw = (await renderView({ path: ["x"], search: {}, access: ACCESS, gui: old })) as Node;
    expect((raw.props?.children as Node).type).toBe(RawView);
  });

  it("answers not found for a path no view serves, or a bad one", async () => {
    mocks.dispatchView.mockResolvedValue({ ok: false, status: 404, code: "gui_not_found", message: "This page could not be found." });
    await expect(renderView({ path: ["no", "such"], search: {}, access: ACCESS, gui: GUI })).rejects.toThrow("not-found");
    mocks.dispatchView.mockResolvedValue({ ok: false, status: 400, code: "gui_bad_request", message: "The link is not valid." });
    await expect(renderView({ path: ["x"], search: {}, access: ACCESS, gui: GUI })).rejects.toThrow("not-found");
  });

  it("sends a refused session to /login and a person with no organization to /no-access", async () => {
    await expect(
      renderView({ path: ["x"], search: {}, access: { user: null, roles: [] }, gui: GUI }),
    ).rejects.toThrow("redirect:/login");
    expect(mocks.dispatchView).not.toHaveBeenCalled();
    await expect(
      renderView({ path: ["x"], search: {}, access: { user: ACCESS.user, roles: [] }, gui: GUI }),
    ).rejects.toThrow("redirect:/no-access");
    mocks.dispatchView.mockResolvedValue({ ok: false, status: 403, code: "gui_no_access", message: "Your account has no organization yet." });
    await expect(renderView({ path: ["x"], search: {}, access: ACCESS, gui: GUI })).rejects.toThrow("redirect:/no-access");
  });

  it("shows a refusal with its own copy as a banner", async () => {
    mocks.dispatchView.mockResolvedValue({ ok: false, status: 409, code: "metering_disabled", message: "Metering is turned off." });
    const off = (await renderView({ path: ["x"], search: {}, access: ACCESS, gui: GUI })) as Node;
    const [heading, banner] = off.props?.children as Node[];
    // The page keeps a level-one heading, which neither the banner nor the shell gives it.
    expect(heading).toMatchObject({ type: "h1", props: { className: "sr-only", children: "This view could not be shown" } });
    expect(banner.type).toBe(Banner);
    expect(banner.props).toMatchObject({ tone: "warn", title: "Metering is turned off." });

    mocks.dispatchView.mockResolvedValue({ ok: false, status: 500, code: "gui_view_failed", message: "This view could not be loaded." });
    const failed = (await renderView({ path: ["x"], search: {}, access: ACCESS, gui: GUI })) as Node;
    expect((failed.props?.children as Node[])[1].props).toMatchObject({ tone: "destructive", title: "This view could not be loaded." });
  });
});

describe("resolveInitialView", () => {
  const OPERATIONS = `/microgrids/${MICROGRID}/operations`;

  it("gives the shell the view's title and the trail its path names, for a page a view serves", async () => {
    const view = await resolveInitialView(ACCESS, `${OPERATIONS}?date=2026-11-10`, MANIFEST);
    expect(mocks.dispatchView.mock.calls[0][1]).toBe(`${OPERATIONS}?date=2026-11-10`);
    expect(view).toMatchObject({ view: "metering.site-day", title: "Tuesday 10 November" });
    expect(view?.scope.microgrid?.id).toBe(MICROGRID);
    // A microgrid's own page is its Operations page, so the microgrid is the last crumb.
    expect(view?.trail.map((crumb) => crumb.label)).toEqual(["Org One", "Kasana", "Kasana East"]);
    expect(view?.trail.at(-1)?.href).toBe(OPERATIONS);
  });

  it("names the same load as the page for the same request", async () => {
    await resolveInitialView(ACCESS, `${OPERATIONS}?b=2&a=1`, MANIFEST);
    await renderView({ path: ["microgrids", MICROGRID, "operations"], search: { b: "2", a: "1" }, access: ACCESS, gui: GUI });
    const [fromLayout, fromPage] = mocks.dispatchView.mock.calls.map((call) => call[1]);
    expect(fromLayout).toBe(fromPage);
    expect(pageHref(["microgrids", MICROGRID, "operations"], new URLSearchParams("b=2&a=1"))).toBe(fromPage);
    expect(mocks.cached.every((args) => args[0] === ACCESS)).toBe(true);
  });

  it("names the same load as the page for a segment with escapes, decoding the header's path before encoding it again", async () => {
    await resolveInitialView(ACCESS, "/microgrids/a%20b%2Fc/operations", MANIFEST);
    await renderView({ path: ["microgrids", "a b/c", "operations"], search: {}, access: ACCESS, gui: GUI });
    const [fromLayout, fromPage] = mocks.dispatchView.mock.calls.map((call) => call[1]);
    expect(fromLayout).toBe("/microgrids/a%20b%2Fc/operations");
    expect(fromLayout).toBe(fromPage);
  });

  it("loads nothing for a page served outside the contract, a path off the catalog, or no path", async () => {
    expect(await resolveInitialView(ACCESS, `/microgrids/${MICROGRID}/billing`, MANIFEST)).toBeNull();
    expect(await resolveInitialView(ACCESS, "/no-such-page", MANIFEST)).toBeNull();
    expect(await resolveInitialView(ACCESS, "/microgrids/%E0%A4%A/operations", MANIFEST)).toBeNull();
    expect(await resolveInitialView(ACCESS, null, MANIFEST)).toBeNull();
    expect(mocks.dispatchView).not.toHaveBeenCalled();
  });

  it("leaves the shell to resolveLegacyView when the view does not load", async () => {
    mocks.dispatchView.mockResolvedValue({ ok: false, status: 404, code: "gui_not_found", message: "This page could not be found." });
    expect(await resolveInitialView(ACCESS, OPERATIONS, MANIFEST)).toBeNull();
  });
});

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
import { ViewBoundary, ViewUnavailable } from "../../client/view-boundary";
import { buildManifestModel, type ManifestInput } from "../../shared/manifest-model";
import type { HostContext } from "../access";
import type { SurfaceSnapshot } from "../surface-registry";

const mocks = vi.hoisted(() => ({
  dispatchView: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  snapshot: vi.fn(),
}));
// The real matchView, so the first paint names the view dispatchView would load.
vi.mock("../view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../view")>()),
  dispatchView: mocks.dispatchView,
}));
vi.mock("../snapshot", () => ({ surfaceSnapshot: mocks.snapshot }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": "en" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

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

const REGISTERED = {
  views: SURFACES.flatMap((s) => (s.views ?? []).map((def) => ({ plugin: s.plugin, def }))),
  nav: SURFACES.flatMap((s) => (s.nav ?? []).map((def) => ({ plugin: s.plugin, def }))),
} as unknown as SurfaceSnapshot;

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
  views: SURFACES.flatMap((s) => (s.views ?? []).map((def) => ({ plugin: s.plugin, def }))) as ManifestInput["views"],
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
  mocks.dispatchView.mockResolvedValue({ ok: true, value: MODEL });
  mocks.snapshot.mockResolvedValue(REGISTERED);
});

describe("renderView", () => {
  it("loads the decoded path for the caller, the way GET /api/gui/view does", async () => {
    await renderView({ path: ["microgrids", MICROGRID, "operations"], search: { date: "2026-11-10", ui: undefined }, access: ACCESS, gui: GUI });
    const [ctx, href] = mocks.dispatchView.mock.calls[0] as [HostContext, string];
    expect(href).toBe(`/microgrids/${MICROGRID}/operations?date=2026-11-10`);
    expect(ctx.access.user).toBe(ACCESS.user);
    expect(ctx.access.roles).toEqual(ACCESS.roles);
    expect(ctx.locale).toBe("en");
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
    const refused = (await renderView({ path: ["x"], search: {}, access: ACCESS, gui: GUI })) as Node;
    // Inside a ViewUnavailable, so the shell stops waiting for a model that will not come.
    expect(refused.type).toBe(ViewUnavailable);
    const off = refused.props?.children as Node;
    const [heading, banner] = off.props?.children as Node[];
    // The page keeps a level-one heading, which neither the banner nor the shell gives it.
    expect(heading).toMatchObject({ type: "h1", props: { className: "sr-only", children: "This view could not be shown" } });
    expect(banner.type).toBe(Banner);
    expect(banner.props).toMatchObject({ tone: "warn", title: "Metering is turned off." });

    mocks.dispatchView.mockResolvedValue({ ok: false, status: 500, code: "gui_view_failed", message: "This view could not be loaded." });
    const failed = (await renderView({ path: ["x"], search: {}, access: ACCESS, gui: GUI })) as Node;
    expect(failed.type).toBe(ViewUnavailable);
    expect(((failed.props?.children as Node).props?.children as Node[])[1].props).toMatchObject({ tone: "destructive", title: "This view could not be loaded." });
  });
});

describe("resolveInitialView", () => {
  const OPERATIONS = `/microgrids/${MICROGRID}/operations`;
  const SAVINGS = `/microgrids/${MICROGRID}/operations/savings`;

  it("gives the shell the view's id and the trail its path names without loading the view", async () => {
    const view = await resolveInitialView(`${OPERATIONS}?date=2026-11-10`, MANIFEST);
    expect(mocks.dispatchView).not.toHaveBeenCalled();
    expect(view).toMatchObject({ view: "metering.site-day", title: "Operations" });
    expect(view?.scope.microgrid?.id).toBe(MICROGRID);
    // A microgrid's own page is its Operations page, so the microgrid is the last crumb.
    expect(view?.trail.map((crumb) => crumb.label)).toEqual(["Org One", "Kasana", "Kasana East"]);
    expect(view?.trail.at(-1)?.href).toBe(OPERATIONS);
  });

  it("titles a view with no nav entry of its own after the nav entry its path falls under", async () => {
    const view = await resolveInitialView(SAVINGS, MANIFEST);
    expect(mocks.dispatchView).not.toHaveBeenCalled();
    expect(view).toMatchObject({ view: "billing.savings", title: "Operations", unplaced: false });
    expect(view?.trail.map((crumb) => crumb.label)).toEqual(["Org One", "Kasana", "Kasana East"]);
  });

  it("takes the title of the manifest's nav entry that names the view", async () => {
    const nav = { id: "billing.savings-page", title: "Savings", icon: "money", group: "money", order: 90, view: "billing.savings" };
    mocks.snapshot.mockResolvedValue({ ...REGISTERED, nav: [...REGISTERED.nav, { plugin: "billing", def: nav }] });
    const entry = { ...nav, href: "/microgrids/[microgrid]/operations/savings", needs: ["microgrid"] };
    const manifest = { ...MANIFEST, org: { ...MANIFEST.org, nav: [...MANIFEST.org.nav, entry] } } as Manifest;
    expect(await resolveInitialView(SAVINGS, manifest)).toMatchObject({ view: "billing.savings", title: "Savings" });
    // A nav entry the manifest leaves out (its plugin off, or not for this person) lends no title.
    expect(await resolveInitialView(SAVINGS, MANIFEST)).toMatchObject({ view: "billing.savings", title: "Operations" });
  });

  it("shows no label for a microgrid the manifest does not list, and marks the path unplaced", async () => {
    const other = "e7300000-0000-4000-8002-000000000099";
    const view = await resolveInitialView(`/microgrids/${other}/operations/savings`, MANIFEST);
    expect(view).toMatchObject({ view: "billing.savings", unplaced: true });
    expect(view?.scope.microgrid).toBeUndefined();
    expect(view?.trail).toEqual([{ label: "Org One", href: `/organizations/${ORG}` }]);
    expect(JSON.stringify(view)).not.toContain(other);
  });

  it("leaves the load to the page, which still refuses as before", async () => {
    await resolveInitialView(OPERATIONS, MANIFEST);
    await renderView({ path: ["microgrids", MICROGRID, "operations"], search: {}, access: ACCESS, gui: GUI });
    expect(mocks.dispatchView).toHaveBeenCalledOnce();
    expect(mocks.dispatchView.mock.calls[0][1]).toBe(OPERATIONS);

    mocks.dispatchView.mockResolvedValue({ ok: false, status: 404, code: "gui_not_found", message: "This page could not be found." });
    expect(await resolveInitialView(OPERATIONS, MANIFEST)).toMatchObject({ view: "metering.site-day" });
    await expect(
      renderView({ path: ["microgrids", MICROGRID, "operations"], search: {}, access: ACCESS, gui: GUI }),
    ).rejects.toThrow("not-found");
  });

  it("spells the header's path as the page spells its params before matching it", async () => {
    const escaped = `/microgrids/${MICROGRID.replaceAll("-", "%2D")}/operations`;
    expect(await resolveInitialView(escaped, MANIFEST)).toMatchObject({ view: "metering.site-day", unplaced: false });
    expect(pageHref(["microgrids", "a b/c", "operations"], new URLSearchParams())).toBe("/microgrids/a%20b%2Fc/operations");
    // An encoded slash is no page href, so dispatchView answers 400 for it and the page is not found.
    expect(await resolveInitialView("/microgrids/a%20b%2Fc/operations", MANIFEST)).toBeNull();
  });

  it("answers null for a page served outside the contract, a path off the catalog, or no path", async () => {
    expect(await resolveInitialView(`/microgrids/${MICROGRID}/billing`, MANIFEST)).toBeNull();
    expect(await resolveInitialView("/no-such-page", MANIFEST)).toBeNull();
    expect(await resolveInitialView("/microgrids/%E0%A4%A/operations", MANIFEST)).toBeNull();
    expect(await resolveInitialView(null, MANIFEST)).toBeNull();
    expect(mocks.dispatchView).not.toHaveBeenCalled();
  });

  it("leaves the shell to resolveLegacyView when no registered view serves the path", async () => {
    mocks.snapshot.mockResolvedValue({ ...REGISTERED, views: [] });
    expect(await resolveInitialView(SAVINGS, MANIFEST)).toBeNull();
    expect(mocks.dispatchView).not.toHaveBeenCalled();
  });
});

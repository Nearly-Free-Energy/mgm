import "server-only";

/**
 * Reads what the interface manifest needs for the signed-in person's
 * organization and builds it with ../shared/manifest-model.ts. Nothing read
 * here is kept beyond the request: React cache() shares one manifest within
 * a server render, and outside a render it memoizes nothing.
 *
 * Every read runs on a client of the caller's own session (row-level
 * security), after the getUser()-backed check in hostContext. Status loaders
 * run through the GUI surface registry (decision 8 on #115), read with
 * surfaceSnapshot (./snapshot.ts), each on its own request and within
 * STATUS_BUDGET_MS (./signals.ts).
 *
 * A person who holds tenant rows (RFC mgm#197 § 4) is shown the tenant
 * entries of plugins live for their own units' organizations. One who sees
 * no organization, since all their rows are tenant rows, gets the tenant
 * manifest (buildTenantManifestModel): their units and those entries, and
 * nothing of an organization.
 *
 * GET /api/gui/manifest serves the same manifest the (gui) layout renders
 * (serveManifest below): the same builder, interface and hints.
 */
import { cache } from "react";
import { headers } from "next/headers";
import { rolesIncludeStaff, rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { readGuiName } from "@/lib/config/gui";
import { MGM_BUNDLED_PLUGINS, matchCatalogPage, type MgmPluginName } from "@/lib/plugins/bundled";
import { createClient } from "@/lib/supabase/server";
import type { Manifest } from "../../contract";
import { createFmt } from "../../fmt";
import { requestedOrganization } from "../shared/manifest-hints";
import { buildManifestModel, buildTenantManifestModel, livePlugins, MAX_PLACES_PER_KIND } from "../shared/manifest-model";
import { chooseTenantUnit, tenantUnitIds, unitsNamedBy } from "../shared/tenant-units";
import { hostContext, requireIssued, type HostContext, type HostRefusal } from "./access";
import { resolveSegments, type Scope } from "./entities";
import { pluginGate, unitOrganizationPlugins } from "./gate-state";
import { isPageHref } from "./hrefs";
import { manifestSchema } from "./model-schema";
import { organizationHint, pickOrganization, visibleOrganizations, type OrganizationHints } from "./organization";
import { parseOrFail } from "./parse";
import { collectStatus } from "./signals";
import { surfaceSnapshot } from "./snapshot";
import type { SurfaceSnapshot } from "./surface-registry";
import { readTenantUnits, type HostUnit } from "./units";
import type { HostFailure, HostOutcome } from "./view";
import { BROWSER } from "@/lib/runtime/caller";

export { STATUS_BUDGET_MS } from "./signals";

/**
 * No build stamps a release yet, so the manifest says null (decision 17 on
 * #115). When the release build (scripts/release) stamps a version, read it here.
 */
const RELEASE: string | null = null;

export type ManifestOutcome = { ok: true; manifest: Manifest } | HostRefusal;

/** The path's entities, when it is a catalog page whose segments resolve for the caller. */
async function resolvePath(ctx: HostContext, snapshot: SurfaceSnapshot, path: string | null | undefined) {
  const match = path ? matchCatalogPage(path) : undefined;
  if (!match || Object.keys(match.page.params).length === 0) return null;
  const segments = Object.entries(match.page.params).map(([name, kind]) => ({ name, kind, id: match.values[name] }));
  const resolved = await resolveSegments(ctx, snapshot, segments);
  return resolved.ok ? resolved : null;
}

async function readName(ctx: HostContext): Promise<string | null> {
  const supabase = await ctx.newClient();
  const { data } = await supabase
    .from("user_profiles")
    .select("first_name, last_name")
    .eq("user_id", ctx.access.user.id)
    .maybeSingle<{ first_name: string | null; last_name: string | null }>();
  return [data?.first_name, data?.last_name].map((s) => s?.trim()).filter(Boolean).join(" ") || null;
}

type ManifestInput = Parameters<typeof buildManifestModel>[0];
type PlaceRows = Pick<ManifestInput, "communities" | "microgrids">;

async function readPlaces(ctx: HostContext, organizationId: string): Promise<PlaceRows> {
  const supabase = await ctx.newClient();
  const [communities, microgrids] = await Promise.all([
    supabase.from("communities").select("id, name").eq("org_id", organizationId).order("name").limit(MAX_PLACES_PER_KIND),
    supabase
      .from("microgrids")
      .select("id, name, community_id, timezone, communities!inner(org_id)")
      .eq("communities.org_id", organizationId)
      .order("name")
      .limit(MAX_PLACES_PER_KIND),
  ]);
  if (communities.error || microgrids.error) {
    console.error("[gui] manifest: places could not be read");
    return { communities: [], microgrids: [] };
  }
  type MicrogridRow = { id: string; name: string; community_id: string | null; timezone: string | null };
  return {
    communities: (communities.data ?? []) as { id: string; name: string }[],
    microgrids: ((microgrids.data ?? []) as MicrogridRow[]).map((m) => ({
      id: m.id,
      name: m.name,
      communityId: m.community_id,
      timezone: m.timezone,
    })),
  };
}

/**
 * The path's community and microgrid. A microgrid's page names only the
 * microgrid, so its community comes from the rows already read, or, past the
 * places cap, from one more read of that microgrid and its community.
 */
async function pathScope(ctx: HostContext, scope: Scope, rows: PlaceRows): Promise<ManifestInput["scope"]> {
  const { community, microgrid } = scope;
  if (!microgrid || community) return { community, microgrid };
  const listed = rows.microgrids.find((m) => m.id === microgrid.id)?.communityId;
  if (listed && rows.communities.some((c) => c.id === listed)) return { microgrid: { ...microgrid, parent: listed } };
  const supabase = await ctx.newClient();
  const { data } = await supabase
    .from("microgrids")
    .select("community_id, communities(name)")
    .eq("id", microgrid.id)
    .maybeSingle<{ community_id: string | null; communities: { name: string } | null }>();
  if (!data?.community_id) return { microgrid };
  return {
    microgrid: { ...microgrid, parent: data.community_id },
    ...(data.communities ? { community: { kind: "community", id: data.community_id, label: data.communities.name } } : {}),
  };
}

type Gate = ManifestInput["gate"];

/**
 * Plugins live for at least one of `units`' organizations
 * (unitOrganizationPlugins: each asked once, through the gate of one unit
 * there, with the person's own session). A plugin is live for an
 * organization with its dependencies, as livePlugins decides, so the union
 * holds each dependency too. A gate that throws fails the manifest.
 */
async function unitsGate(ctx: HostContext, units: readonly HostUnit[]): Promise<Gate> {
  const lives = [...(await unitOrganizationPlugins(ctx, units)).values()].map((entry) => {
    if (entry.status === "rejected") throw entry.reason;
    return entry.value.live;
  });
  return Object.fromEntries(MGM_BUNDLED_PLUGINS.filter((p) => lives.some((live) => live.has(p.name))).map((p) => [p.name, true]));
}

/**
 * The person's units. For a person with a staff row a unit that cannot be
 * read costs only the tenant entries, so their manifest still builds; for
 * anyone else the failure is the page's.
 */
function unitsOf(ctx: HostContext, staff: boolean): Promise<HostUnit[]> {
  return readTenantUnits(ctx).catch((error: unknown) => {
    if (!staff) throw error;
    console.error("[gui] manifest: units could not be read");
    return [];
  });
}

/**
 * The tenant manifest for a person who sees no organization. The current
 * unit is the one the path's `unit` names among theirs, else the last one
 * they used (the interface keeps `org.id`, here a unit's, in the cookie it
 * keeps the last organization in: org-cookie.ts), else the first.
 */
async function buildTenantManifest(
  ctx: HostContext,
  snapshot: SurfaceSnapshot,
  o: { gui: string; path?: string | null; preferred?: string | null },
  name: string | null,
  units: readonly HostUnit[],
): Promise<Manifest> {
  const held = units.map((u) => ({ role: "tenant" as const, scope_type: "tenant" as const, scope_id: u.tenantId }));
  const fromPath = chooseTenantUnit(held, unitsNamedBy(o.path));
  const preferred = chooseTenantUnit(held, o.preferred ? [o.preferred] : []);
  const current = fromPath.ok ? fromPath.tenantId : preferred.ok && o.preferred ? preferred.tenantId : null;
  const model = buildTenantManifestModel({
    release: RELEASE,
    locale: ctx.locale,
    now: ctx.now,
    gui: o.gui,
    user: { name, email: ctx.access.user.email },
    units: units.map((u) => ({ id: u.tenantId, label: u.label, timezone: u.timezone })),
    current,
    several: tenantUnitIds(ctx.access.roles).length > 1,
    tenantGate: await unitsGate(ctx, units),
    nav: snapshot.nav,
    views: snapshot.views,
  });
  const parsed = parseOrFail(manifestSchema, model, "manifest");
  if (!parsed.ok) throw new Error("GUI host: the manifest failed its schema");
  return parsed.value;
}

/**
 * The manifest for `ctx`'s person, in the organization the hints select
 * (organization.ts), with the interface `gui`. A person who sees no
 * organization gets the tenant manifest when they hold a unit, and is
 * refused with gui_no_access otherwise.
 */
export async function buildManifest(
  ctx: HostContext,
  o: { gui: string; path?: string | null } & Omit<OrganizationHints, "fromPath">,
): Promise<ManifestOutcome> {
  requireIssued(ctx);
  const snapshot = await surfaceSnapshot();
  const staff = rolesIncludeStaff(ctx.access.roles);
  const [path, organizations, name, units] = await Promise.all([
    staff ? resolvePath(ctx, snapshot, o.path) : null,
    visibleOrganizations(ctx),
    readName(ctx),
    unitsOf(ctx, staff),
  ]);
  const organizationId = pickOrganization(organizations, { ...o, fromPath: path?.organizationId });
  const org = organizations.find((candidate) => candidate.id === organizationId);
  if (!org) {
    if (units.length === 0) return { ok: false, status: 403, code: "gui_no_access", message: "Your account has no organization yet." };
    return { ok: true, manifest: await buildTenantManifest(ctx, snapshot, o, name, units) };
  }

  const gate = pluginGate(ctx, org.id);
  const [decisions, places, tenantGate] = await Promise.all([
    Promise.all(MGM_BUNDLED_PLUGINS.map(async (p) => [p.name, (await gate(p.name)).ok] as const)),
    readPlaces(ctx, org.id),
    units.length > 0 ? unitsGate(ctx, units) : undefined,
  ]);
  const enabled: Partial<Record<MgmPluginName, boolean>> = Object.fromEntries(decisions);
  const live = livePlugins(enabled);
  const statuses = snapshot.status.filter((s) => live.has(s.plugin));
  // The path's places count only when the path is in the chosen organization.
  const [items, scope] = await Promise.all([
    collectStatus(ctx, org.id, statuses),
    path?.organizationId === org.id ? pathScope(ctx, path.scope, places) : undefined,
  ]);

  const model = buildManifestModel({
    release: RELEASE,
    locale: ctx.locale,
    now: ctx.now,
    gui: o.gui,
    user: { name, email: ctx.access.user.email },
    superAdmin: rolesIncludeSuperAdmin([...ctx.access.roles]),
    // `org` is one the person sees as staff (visibleOrganizations). Tenant
    // entries follow the plugin state of their own units' organizations
    // (tenantGate), not this one's.
    staff: true,
    tenant: units.length > 0,
    org,
    orgs: organizations,
    gate: enabled,
    ...(tenantGate ? { tenantGate } : {}),
    nav: snapshot.nav,
    views: snapshot.views,
    status: statuses.flatMap((s, i) => (items[i] ? [{ plugin: s.plugin, item: items[i] }] : [])),
    ...places,
    scope,
  });
  const parsed = parseOrFail(manifestSchema, model, "manifest");
  if (!parsed.ok) throw new Error("GUI host: the manifest failed its schema");
  return { ok: true, manifest: parsed.value };
}

/**
 * The manifest for this request's signed-in person, built at most once per
 * server render. It reads the session with getRequestUserAccess (getUser)
 * before anything else. Arguments are primitives so that the layout and a
 * page in the same render share one result.
 */
export const getManifest = cache(
  async (gui: string, path: string | null, requested: string | null, preferred: string | null): Promise<ManifestOutcome> => {
    const made = hostContext(await getRequestUserAccess(), await headers(), {
      newClient: createClient,
      makeFmt: (locale) => createFmt({ locale }),
      // A page is cookie-only: middleware refuses a bearer token on it.
      caller: BROWSER,
    });
    if (!made.ok) return made;
    return buildManifest(made.ctx, { gui, path, requested, preferred });
  },
);

/**
 * Starts getManifest's reads ahead of the caller's own awaited checks. A
 * failure surfaces when the caller awaits getManifest with the same arguments.
 */
export function preloadManifest(gui: string, path: string | null, requested: string | null, preferred: string | null): void {
  getManifest(gui, path, requested, preferred).catch(() => {});
}

const MANIFEST_BAD_REQUEST: HostFailure = {
  ok: false,
  status: 400,
  code: "gui_bad_request",
  message: "The manifest takes path, a released page on this site, and org, and nothing else.",
};
const MANIFEST_FAILED: HostFailure = { ok: false, status: 500, code: "gui_manifest_failed", message: "The manifest could not be built." };

/**
 * GET /api/gui/manifest's query: `path`, a released page on this site with
 * its own query, and `org`, a UUID, each at most once. Any other key is a
 * 400, so a mistyped parameter fails rather than answering for something
 * else. The organization asked for is `org`, or, only when `org` is absent,
 * the path's own `?org=`,
 * as the (gui) layout takes it from the page's path (manifestHints in
 * ../shared/manifest-hints.ts); like there, it only chooses among the
 * organizations the person sees.
 *
 * So `org` is a hint, never a refusal, unlike the catalog's (an `org` the
 * person cannot see is a 404 from buildActionCatalog in ./catalog.ts).
 * pickOrganization (./organization.ts) passes over an organization the
 * person cannot see for the next hint (the cookie: an unseen `org` never
 * falls back to the path's `?org=`), else their first organization, and
 * ranks the organization of the records `path` names above `org`; a person
 * who sees none but holds a unit gets the tenant manifest, whose `org` is a
 * unit. Each is a 200, so a client that asks for one organization, such as
 * `mgm places --org`, checks `manifest.org.id` against it. If
 * pickOrganization's order changes, or the manifest comes to refuse an
 * `org` as the catalog does, revisit this and the manifest bullet in
 * docs/cordis-runtime.md.
 */
export function readManifestQuery(search: URLSearchParams): HostOutcome<{ path: string | null; requested: string | null }> {
  for (const key of search.keys()) if (key !== "path" && key !== "org") return MANIFEST_BAD_REQUEST;
  const paths = search.getAll("path");
  const orgs = search.getAll("org");
  if (paths.length > 1 || orgs.length > 1) return MANIFEST_BAD_REQUEST;
  const path = paths[0] ?? null;
  if (path !== null && !isPageHref(path)) return MANIFEST_BAD_REQUEST;
  const org = orgs[0] ?? null;
  if (org !== null && organizationHint(org) !== org.toLowerCase()) return MANIFEST_BAD_REQUEST;
  return { ok: true, value: { path, requested: org?.toLowerCase() ?? requestedOrganization(path) } };
}

/**
 * The manifest for `ctx`'s person, as the (gui) layout builds it: with the
 * interface this installation renders (readGuiName, as the layout reads it)
 * and the same hints. A refusal is buildManifest's. An MGM_GUI that names no
 * usable interface, which the layout (src/app/(gui)/layout.tsx) answers
 * with a 500, is a 500 here too, with the setting's value kept out of the
 * answer and the log. If the layout comes to read the interface or the
 * hints another way, change this with it, so the route keeps serving what
 * the page gets.
 */
export async function serveManifest(
  ctx: HostContext,
  o: { path?: string | null } & Omit<OrganizationHints, "fromPath">,
): Promise<HostOutcome<Manifest>> {
  requireIssued(ctx);
  let gui: string;
  try {
    gui = readGuiName();
  } catch {
    console.error("[gui] manifest: MGM_GUI names no interface this build can serve");
    return MANIFEST_FAILED;
  }
  let out: ManifestOutcome;
  try {
    out = await buildManifest(ctx, { gui, ...o });
  } catch {
    console.error("[gui] manifest could not be built");
    return MANIFEST_FAILED;
  }
  return out.ok ? { ok: true, value: out.manifest } : out;
}

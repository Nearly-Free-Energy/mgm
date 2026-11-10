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
 */
import { cache } from "react";
import { headers } from "next/headers";
import { rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { MGM_BUNDLED_PLUGINS, matchCatalogPage, type MgmPluginName } from "@/lib/plugins/bundled";
import { createClient } from "@/lib/supabase/server";
import type { Manifest } from "../../contract";
import { createFmt } from "../../fmt";
import { buildManifestModel, livePlugins, MAX_PLACES_PER_KIND } from "../shared/manifest-model";
import { hostContext, requireIssued, type HostContext, type HostRefusal } from "./access";
import { resolveSegments, type Scope } from "./entities";
import { pluginGate } from "./gate-state";
import { manifestSchema } from "./model-schema";
import { pickOrganization, visibleOrganizations, type OrganizationHints } from "./organization";
import { parseOrFail } from "./parse";
import { collectStatus } from "./signals";
import { surfaceSnapshot } from "./snapshot";
import type { SurfaceSnapshot } from "./surface-registry";

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

/**
 * The manifest for `ctx`'s person, in the organization the hints select
 * (organization.ts), with the interface `gui`. Refuses with gui_no_access
 * when the person can see no organization.
 */
export async function buildManifest(
  ctx: HostContext,
  o: { gui: string; path?: string | null } & Omit<OrganizationHints, "fromPath">,
): Promise<ManifestOutcome> {
  requireIssued(ctx);
  const snapshot = await surfaceSnapshot();
  const [path, organizations, name] = await Promise.all([
    resolvePath(ctx, snapshot, o.path),
    visibleOrganizations(ctx),
    readName(ctx),
  ]);
  const organizationId = pickOrganization(organizations, { ...o, fromPath: path?.organizationId });
  const org = organizations.find((candidate) => candidate.id === organizationId);
  if (!org) return { ok: false, status: 403, code: "gui_no_access", message: "Your account has no organization yet." };

  const gate = pluginGate(ctx, org.id);
  const [decisions, places] = await Promise.all([
    Promise.all(MGM_BUNDLED_PLUGINS.map(async (p) => [p.name, (await gate(p.name)).ok] as const)),
    readPlaces(ctx, org.id),
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
    org,
    orgs: organizations,
    gate: enabled,
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

import "server-only";

/**
 * Resolves a view's path segments to the one organization they belong to,
 * for the caller, and builds the scope and trail the host sends with it.
 *
 * A request is refused with 404 when any segment is not visible to the
 * caller, when the segments belong to different organizations, when the
 * caller's roles do not reach that organization, or when a segment does not
 * belong to the segment above it in the path (a community under another
 * organization, an edge under another microgrid). The answer is the same
 * 404 in every case, so a refusal does not tell whether a record exists. A
 * lookup that fails is a 503.
 *
 * Every read goes through a client of the caller's own session (row-level
 * security). Core kinds resolve through the plugin gate's resolver; a
 * plugin's own kind through the organizationOf it contributed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { rolesCanAccessOrg } from "@/lib/auth/access";
import { microgridHref } from "@/lib/microgrid-links";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { CORE_ENTITY_KINDS, type CoreEntityKind } from "@/lib/plugins/bundled";
import { UUID_RE } from "@/lib/plugins/state";
import { resolveTargetOrganization } from "@/lib/runtime/gate";
import type { EntityKind, EntityRef, Href, Trail } from "../../contract";
import type { Fmt } from "../../surface";
import { installationRequest, requireIssued, type HostContext } from "./access";
import { hrefSchema } from "./model-schema";
import type { SurfaceSnapshot } from "./surface-registry";

export type Segment = { name: string; kind: EntityKind; id: string };
export type Scope = Partial<Record<CoreEntityKind, EntityRef>>;
export type Resolution =
  | { ok: true; organizationId: string | null; scope: Scope; trail: Trail }
  | { ok: false; status: 404 | 503 };

type Row = Record<string, string | null>;

type RowSpec = {
  table: string;
  /** Enumerated, never "*". For microgrids, a subset of MICROGRID_PUBLIC_COLUMNS (entities.test.ts checks it). */
  columns: string;
  /** The kind directly above this one, and the column naming it. */
  parent?: { kind: CoreEntityKind; column: string };
  /** "" when the kind has no name of its own; such a segment has no trail entry. */
  label(row: Row, fmt: Fmt): string;
  href?(row: Row): string;
};

const name = (row: Row) => row.name ?? "";

/**
 * Where each core kind's row lives. tsc does not check these column strings;
 * entities.db.test.ts reads every kind, so a renamed column fails there.
 */
const ROWS: Record<CoreEntityKind, RowSpec> = {
  organization: { table: "organizations", columns: "id, name", label: name, href: (r) => `/organizations/${r.id}` },
  community: {
    table: "communities",
    columns: "id, name, org_id",
    parent: { kind: "organization", column: "org_id" },
    label: name,
    href: (r) => `/communities/${r.id}`,
  },
  microgrid: {
    table: "microgrids",
    columns: "id, name, community_id",
    parent: { kind: "community", column: "community_id" },
    label: name,
    href: (r) => microgridHref(r.id!),
  },
  edge: {
    table: "edges",
    columns: "id, name, microgrid_id",
    parent: { kind: "microgrid", column: "microgrid_id" },
    label: name,
    href: (r) => `/microgrids/${r.microgrid_id}/setup/edges/${r.id}`,
  },
  device: { table: "devices", columns: "id, name, edge_id", parent: { kind: "edge", column: "edge_id" }, label: name },
  household: {
    table: "households",
    columns: "id, display_name, microgrid_id",
    parent: { kind: "microgrid", column: "microgrid_id" },
    label: (r) => r.display_name ?? "",
    href: (r) => `/microgrids/${r.microgrid_id}/setup/households/${r.id}`,
  },
  billingPeriod: {
    table: "billing_periods",
    columns: "id, start_date, end_date, microgrid_id",
    parent: { kind: "microgrid", column: "microgrid_id" },
    label: (r, fmt) => `${fmt.date(r.start_date!).text} – ${fmt.date(r.end_date!).text}`,
    href: (r) => `/microgrids/${r.microgrid_id}/billing/${r.id}`,
  },
  lineItem: {
    table: "billing_line_items",
    columns: "id, billing_period_id",
    parent: { kind: "billingPeriod", column: "billing_period_id" },
    label: () => "",
  },
  rateSchedule: {
    table: "rate_schedules",
    columns: "id, microgrid_id",
    parent: { kind: "microgrid", column: "microgrid_id" },
    label: () => "",
  },
  paymentAttempt: { table: "payment_attempts", columns: "id, org_id", label: () => "" },
};

const isCore = (kind: EntityKind): kind is CoreEntityKind => (CORE_ENTITY_KINDS as readonly string[]).includes(kind);

async function readRow(supabase: SupabaseClient, kind: CoreEntityKind, id: string): Promise<Row | null> {
  const { data, error } = await supabase.from(ROWS[kind].table).select(ROWS[kind].columns).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Row | null) ?? null;
}

/** Released same-origin page hrefs only. */
function pageHref(path: string | undefined): Href | null {
  if (!path || !isReleasedRoute(path)) return null;
  const parsed = hrefSchema.safeParse(path);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether a core segment sits under the nearest kind above it that the path
 * also names. Walks up one row at a time when the path skips a level (a
 * device under a microgrid, with no edge segment). A row missing on the way
 * up is a mismatch.
 */
async function nested(
  supabase: SupabaseClient,
  kind: CoreEntityKind,
  row: Row,
  idsByKind: Map<EntityKind, Set<string>>,
): Promise<boolean> {
  let ancestor = ROWS[kind].parent;
  while (ancestor && !idsByKind.has(ancestor.kind)) ancestor = ROWS[ancestor.kind].parent;
  if (!ancestor) return true;
  let current: { kind: CoreEntityKind; row: Row } = { kind, row };
  for (;;) {
    const parent = ROWS[current.kind].parent!;
    const parentId = current.row[parent.column];
    if (!parentId) return false;
    if (parent.kind === ancestor.kind) return idsByKind.get(parent.kind)!.has(parentId);
    const parentRow = await readRow(supabase, parent.kind, parentId);
    if (!parentRow) return false;
    current = { kind: parent.kind, row: parentRow };
  }
}

/**
 * Resolves `segments`, in path order, to one organization. No segments
 * resolve to no organization; the caller chooses one for a root view. A core
 * kind's id is lowercased, so ids compare equal to the ones rows carry.
 */
export async function resolveSegments(
  ctx: HostContext,
  snapshot: Pick<SurfaceSnapshot, "entities">,
  pathSegments: readonly Segment[],
): Promise<Resolution> {
  requireIssued(ctx);
  if (pathSegments.length === 0) return { ok: true, organizationId: null, scope: {}, trail: [] };
  for (const s of pathSegments) {
    if (isCore(s.kind) ? !UUID_RE.test(s.id) : !snapshot.entities.has(s.kind)) return { ok: false, status: 404 };
  }
  const segments = pathSegments.map((s) => (isCore(s.kind) ? { ...s, id: s.id.toLowerCase() } : s));

  const params = Object.fromEntries(segments.map((s) => [s.name, s.id]));
  const idsByKind = new Map<EntityKind, Set<string>>();
  for (const s of segments) idsByKind.set(s.kind, (idsByKind.get(s.kind) ?? new Set()).add(s.id));

  try {
    const supabase = await ctx.newClient();
    const resolved = await Promise.all(
      segments.map(async (s) => {
        if (!isCore(s.kind)) {
          const entity = snapshot.entities.get(s.kind)!;
          const req = await installationRequest(ctx, params, new URLSearchParams());
          return { segment: s, organizationId: await entity.organizationOf(req, s.id), row: null };
        }
        const [organizationId, row] = await Promise.all([
          resolveTargetOrganization(supabase, { kind: s.kind, id: s.id }),
          readRow(supabase, s.kind, s.id),
        ]);
        // The resolver returns an organization target's id unchecked (gate.ts), so the
        // visible row is what counts; if it starts checking visibility, this is redundant.
        return { segment: s, organizationId: row ? organizationId : null, row };
      }),
    );

    const organizationId = resolved[0].organizationId;
    if (!organizationId) return { ok: false, status: 404 };
    if (resolved.some((r) => r.organizationId !== organizationId)) return { ok: false, status: 404 };
    if (!rolesCanAccessOrg([...ctx.access.roles], organizationId)) return { ok: false, status: 404 };

    const core = resolved.filter((r): r is typeof r & { segment: { kind: CoreEntityKind }; row: Row } => r.row !== null);
    const fits = await Promise.all(core.map((r) => nested(supabase, r.segment.kind, r.row, idsByKind)));
    if (fits.includes(false)) return { ok: false, status: 404 };

    const scope: Scope = {};
    const trail: Trail = [];
    for (const { segment, row } of core) {
      const spec = ROWS[segment.kind];
      const label = spec.label(row, ctx.fmt);
      const href = pageHref(spec.href?.(row));
      scope[segment.kind] ??= { kind: segment.kind, id: segment.id, label, ...(href ? { href } : {}) };
      if (label && href) trail.push({ label, href });
    }
    return { ok: true, organizationId, scope, trail };
  } catch {
    return { ok: false, status: 503 };
  }
}

import "server-only";

/**
 * Which organization the signed-in person is acting in, among those they can
 * see. Reads run on a client of the caller's own session (row-level
 * security), on a HostContext, which exists only after hostContext's
 * getUser()-backed check. The choice is for display: whichever organization
 * it names, pages and routes still check access themselves.
 */
import { rolesCanAccessOrg } from "@/lib/auth/access";
import { UUID_RE } from "@/lib/plugins/state";
import { requireIssued, type HostContext } from "./access";

export type VisibleOrganization = { id: string; name: string };

export type OrganizationHints = {
  /** The organization the request's path belongs to, already resolved. */
  fromPath?: string | null;
  /** An `?org=` the request asked for. */
  requested?: string | null;
  /** The organization the person last used. */
  preferred?: string | null;
};

/** The organizations row-level security shows the caller and their roles reach, by name. */
export async function visibleOrganizations(ctx: HostContext): Promise<VisibleOrganization[]> {
  requireIssued(ctx);
  const supabase = await ctx.newClient();
  const { data, error } = await supabase.from("organizations").select("id, name").order("name");
  if (error) throw new Error("GUI host: organizations could not be read");
  const roles = [...ctx.access.roles];
  return ((data ?? []) as VisibleOrganization[])
    .filter((org) => rolesCanAccessOrg(roles, org.id))
    .map((org) => ({ id: org.id, name: org.name }));
}

/**
 * The first hint that names one of `organizations`, in the order path,
 * `?org=`, last used; otherwise the first organization. A hint that is not a
 * UUID or names an organization the person cannot see is ignored.
 */
export function pickOrganization(organizations: readonly VisibleOrganization[], hints: OrganizationHints): string | null {
  const ids = new Set(organizations.map((org) => org.id));
  for (const hint of [hints.fromPath, hints.requested, hints.preferred]) {
    const id = hint?.trim().toLowerCase();
    if (id && UUID_RE.test(id) && ids.has(id)) return id;
  }
  return organizations[0]?.id ?? null;
}

export async function selectOrganization(
  ctx: HostContext,
  hints: OrganizationHints,
): Promise<{ organizationId: string | null; organizations: VisibleOrganization[] }> {
  const organizations = await visibleOrganizations(ctx);
  return { organizationId: pickOrganization(organizations, hints), organizations };
}

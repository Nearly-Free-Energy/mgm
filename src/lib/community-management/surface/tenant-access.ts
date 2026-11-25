import "server-only";

/**
 * The confirmation steps of giving and removing a person's access to a
 * unit's tenant pages (community.grant-tenant-access and
 * community.revoke-tenant-access, RFC mgm#197 § 6), and how the host finds
 * the organization of one access, the `community.tenant-access` entity kind
 * that the removal's path names.
 *
 * Every read is through the person's own client. An org manager cannot read
 * another person's role rows (RLS), so the access list comes from
 * fn_tenant_access_list, which checks the caller against the unit's
 * microgrid as the routes do. Both steps name the unit and, for a removal,
 * the address; both actions are human-only, so no assistant is shown either.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { InstallationRequest, Loaded, SurfaceRequest } from "@/lib/gui/surface";
import { TENANT_APP_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { resolveTargetOrganization } from "@/lib/runtime/gate";

type Refusal = Extract<Loaded<never>, { ok: false }>;
type Input = { params: Record<string, string>; body?: unknown };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE: Refusal = { ok: false, status: 503, message: "Could not check this unit's access right now. Try again shortly." };
const NOT_FOUND: Refusal = { ok: false, status: 404, message: "This tenant could not be found." };
/**
 * POST /api/tenants/[id]/access's copy for an organization whose tenant
 * app is off (TENANT_APP_OFF_COPY there), where it answers 409
 * tenant_app_disabled. If the route's copy changes, change this.
 */
const TENANT_APP_OFF: Refusal = {
  ok: false,
  status: 409,
  message: "The tenant app is not on for this organization yet. You can give access once it is on.",
};
/**
 * DELETE /api/tenants/[id]/access/[accessId]'s copy for an access that is
 * gone (access_not_found there); if the route's copy changes, change this.
 */
const ACCESS_GONE: Refusal = { ok: false, status: 404, message: "This address no longer has access to this unit." };

type AccessRow = { access_id: string; email: string | null; created_at: string };

/** The unit's name as its pages show it: the tenant's name, and its unit label when it has one. */
async function unitName(req: SurfaceRequest, tenantId: string): Promise<string | null | "unavailable"> {
  const { data, error } = await req.supabase
    .from("tenants")
    .select("id, display_name, unit_label")
    .eq("id", tenantId)
    .maybeSingle<{ id: string; display_name: string | null; unit_label: string | null }>();
  if (error) return "unavailable";
  if (!data) return null;
  return [data.display_name, data.unit_label].filter((part) => part?.trim()).join(", ") || "This unit";
}

/**
 * community.grant-tenant-access's step, before the person types the
 * address: who the notice goes to and what it says. Refused while the tenant
 * app is off for the unit's organization, as the route refuses it.
 */
export async function prepareGrantTenantAccess(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  const unit = await unitName(req, input.params.id);
  if (unit === "unavailable") return UNAVAILABLE;
  if (unit === null) return NOT_FOUND;
  let on: boolean;
  try {
    on = await isPluginEnabledForOrg(req.supabase, req.organizationId, TENANT_APP_PLUGIN_NAME);
  } catch {
    return UNAVAILABLE;
  }
  if (!on) return TENANT_APP_OFF;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement:
        "MGM emails the address you enter that it can now sign in to this unit's pages. The email carries no sign-in link: they sign in from the sign-in page.",
      facts: [{ label: "Unit", value: req.fmt.text(unit) }],
      warnings: ["An address with no MGM account gets one, with no password."],
      acknowledgements: [],
    },
  };
}

/**
 * community.revoke-tenant-access's step: the address losing access and the
 * unit. Nothing to tick or type, as the tenant page's own Remove asks only
 * to confirm; RevokeTenantAccessBody (../schemas.ts) carries that.
 */
export async function prepareRevokeTenantAccess(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  const { id, accessId } = input.params;
  const [unit, listed] = await Promise.all([
    unitName(req, id),
    req.supabase.rpc("fn_tenant_access_list", { _tenant_id: id }),
  ]);
  if (unit === "unavailable") return UNAVAILABLE;
  if (unit === null) return NOT_FOUND;
  if (listed.error) return UNAVAILABLE;
  const entry = ((listed.data ?? []) as AccessRow[]).find((row) => row.access_id === accessId);
  if (!entry?.email) return ACCESS_GONE;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Remove ${entry.email}'s access to this unit's pages.`,
      facts: [
        { label: "Address", value: req.fmt.text(entry.email) },
        { label: "Unit", value: req.fmt.text(unit) },
      ],
      warnings: ["They can no longer open this unit's pages. You can give access again later."],
      acknowledgements: [],
    },
  };
}

/**
 * The organization of one tenant access (a role row id), for the
 * `community.tenant-access` entity kind, or null when the caller cannot see
 * it. An access is found only beside the unit it belongs to: the host passes
 * every segment of the request in `req.params` (resolveSegments in
 * src/lib/gui/host/server/entities.ts), and the access counts as visible
 * when one of them is a tenant whose access list, read with the caller's
 * own client, holds it. Its organization is then that tenant's. So the
 * removal's path, which names the tenant and the access, resolves, and an
 * access named alone does not. If the host stops passing every segment, or
 * an access comes to be named without its tenant, revisit.
 */
export async function tenantAccessOrganization(req: InstallationRequest, accessId: string): Promise<string | null> {
  const tenants = [...new Set(Object.values(req.params))].filter((id) => id !== accessId && UUID_RE.test(id));
  for (const tenantId of tenants) {
    const { data: tenant, error: read } = await req.supabase.from("tenants").select("id").eq("id", tenantId).maybeSingle();
    if (read) throw new Error(read.message);
    if (!tenant) continue;
    const listed = await req.supabase.rpc("fn_tenant_access_list", { _tenant_id: tenantId });
    // 42501: the caller does not manage this unit; the access is not theirs to see.
    if (listed.error) {
      if ((listed.error as { code?: string }).code === "42501") return null;
      throw new Error(listed.error.message);
    }
    if (((listed.data ?? []) as AccessRow[]).some((row) => row.access_id === accessId)) {
      return resolveTargetOrganization(req.supabase, { kind: "tenant", id: tenantId });
    }
  }
  return null;
}

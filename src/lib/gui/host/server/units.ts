import "server-only";

/**
 * The signed-in person's own units (RFC mgm#197 § 4), as the host shows
 * them: in the tenant manifest's places, in its nav (each unit's
 * organization's plugin gate) and in the picker /my offers a person with
 * several. Read on a HostContext, with the caller's own session.
 *
 * Each unit is a tenant row the person holds (tenantUnitIds), read with
 * `fn_tenant_home` (20261118100100), which answers only a caller holding a
 * tenant row for it and returns the unit's names, its microgrid's name and
 * time zone, and its organization's id. That function is the tenant's only
 * view of a microgrid or an organization (no tenant policy on either), so
 * nothing else is read here. A row the function no longer answers for (the
 * access removed, or the unit deleted, since the role rows were read) is
 * left out. This shows; it authorizes nothing: every tenant view's loader
 * authorizes its unit again through composeTenantApp.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantUnitIds } from "../shared/tenant-units";
import { requireIssued, type HostContext } from "./access";

export type HostUnit = Readonly<{
  tenantId: string;
  /** The tenant's display name, as the tenant.home view titles itself. */
  label: string;
  unitLabel: string | null;
  microgridName: string;
  timezone: string | null;
  organizationId: string;
}>;

type HomeRow = {
  tenant_id: string;
  display_name: string | null;
  unit_label: string | null;
  microgrid_name: string | null;
  timezone: string | null;
  organization_id: string;
};

async function readUnit(supabase: SupabaseClient, tenantId: string): Promise<HostUnit | null> {
  const { data, error } = await supabase.rpc("fn_tenant_home", { _tenant_id: tenantId });
  if (error) throw new Error("GUI host: a unit could not be read");
  const row = (Array.isArray(data) ? data[0] : null) as HomeRow | null | undefined;
  if (!row || row.tenant_id?.toLowerCase() !== tenantId || !row.organization_id) return null;
  const unitLabel = row.unit_label?.trim() || null;
  return {
    tenantId,
    label: row.display_name?.trim() || unitLabel || "Your unit",
    unitLabel,
    microgridName: row.microgrid_name ?? "",
    timezone: row.timezone || null,
    organizationId: row.organization_id.toLowerCase(),
  };
}

/**
 * The person's units, by label and then id. None, with nothing read, for a
 * person with no tenant row. Throws when a unit cannot be read; callers
 * decide whether that fails the page.
 */
export async function readTenantUnits(ctx: HostContext): Promise<HostUnit[]> {
  requireIssued(ctx);
  const ids = tenantUnitIds(ctx.access.roles);
  if (ids.length === 0) return [];
  const supabase = await ctx.newClient();
  const units = await Promise.all(ids.map((id) => readUnit(supabase, id)));
  return units
    .filter((unit): unit is HostUnit => unit !== null)
    .sort((a, b) => a.label.localeCompare(b.label) || a.tenantId.localeCompare(b.tenantId));
}

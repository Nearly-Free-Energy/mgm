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
 *
 * A person may rent several units, in several organizations. Their units
 * usually share `tenants.display_name`, which is the tenant's own name, so
 * a unit is named by its unit label first (unitName), and where two of the
 * person's units would still read the same, by its microgrid too. One unit
 * that cannot be read is left out rather than failing the others.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantUnitIds } from "../shared/tenant-units";
import { requireIssued, type HostContext } from "./access";

export type HostUnit = Readonly<{
  tenantId: string;
  /** unitName: the unit label, else the tenant's display name, else "Your unit". */
  name: string;
  /**
   * What the shell calls the unit (places, context, picker): `name`, with
   * the microgrid added when another of the person's units has the same
   * name, so no two read alike unless they share both.
   */
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

/**
 * What a unit is called: its unit label ("Shop 9"), else the tenant's
 * display name, else "Your unit". The unit label comes first because the
 * display name is the tenant's own name, which one person's units share.
 * The tenant.home view titles itself the same way (tenant-app
 * surface/home-model.ts); change both together.
 */
export function unitName(unit: { unitLabel: string | null; displayName: string | null }): string {
  return unit.unitLabel?.trim() || unit.displayName?.trim() || "Your unit";
}

type ReadUnit = Omit<HostUnit, "label">;

async function readUnit(supabase: SupabaseClient, tenantId: string): Promise<ReadUnit | null> {
  const { data, error } = await supabase.rpc("fn_tenant_home", { _tenant_id: tenantId });
  if (error) throw new Error("GUI host: a unit could not be read");
  const row = (Array.isArray(data) ? data[0] : null) as HomeRow | null | undefined;
  if (!row || row.tenant_id?.toLowerCase() !== tenantId || !row.organization_id) return null;
  const unitLabel = row.unit_label?.trim() || null;
  return {
    tenantId,
    name: unitName({ unitLabel, displayName: row.display_name }),
    unitLabel,
    microgridName: row.microgrid_name ?? "",
    timezone: row.timezone || null,
    organizationId: row.organization_id.toLowerCase(),
  };
}

/** Each unit's label: its name, with its microgrid where another unit has the same name. */
function labelled(units: readonly ReadUnit[]): HostUnit[] {
  const named = new Map<string, number>();
  for (const unit of units) named.set(unit.name.toLowerCase(), (named.get(unit.name.toLowerCase()) ?? 0) + 1);
  return units.map((unit) => ({
    ...unit,
    label:
      (named.get(unit.name.toLowerCase()) ?? 0) > 1 && unit.microgridName
        ? `${unit.name} · ${unit.microgridName}`
        : unit.name,
  }));
}

/**
 * The person's units, by label and then id. None, with nothing read, for a
 * person with no tenant row. A unit whose read fails is left out, so one
 * unit cannot take the others with it; only when reads failed and no unit
 * could be read does it throw, and callers decide whether that fails the
 * page.
 */
export async function readTenantUnits(ctx: HostContext): Promise<HostUnit[]> {
  requireIssued(ctx);
  const ids = tenantUnitIds(ctx.access.roles);
  if (ids.length === 0) return [];
  const supabase = await ctx.newClient();
  const reads = await Promise.allSettled(ids.map((id) => readUnit(supabase, id)));
  const units = reads.flatMap((read) => (read.status === "fulfilled" && read.value ? [read.value] : []));
  const failed = reads.filter((read) => read.status === "rejected").length;
  if (failed > 0) {
    if (units.length === 0) throw new Error("GUI host: a unit could not be read");
    console.error(`[gui] units: ${failed} of ${ids.length} units could not be read`);
  }
  return labelled(units).sort((a, b) => a.label.localeCompare(b.label) || a.tenantId.localeCompare(b.tenantId));
}

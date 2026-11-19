import "server-only";

/**
 * The `tenant.home` view's model, built from what `getHome` returns: the
 * unit, its microgrid, today's date in the microgrid's zone and the meters
 * assigned to the unit on that day. A record of fields, so every GUI draws
 * it with its kit before any bespoke renderer exists (RFC mgm#197 § 4).
 *
 * It shows only what `fn_tenant_home` and the tenant's own meter rows give
 * the tenant, and no organization or microgrid id: the view never links to a
 * staff page.
 */
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import { statusEntry } from "@/lib/gui/status-maps";
import type { TenantHome } from "../types";

/** Each meter's field is keyed by this prefix and its device id. */
export const TENANT_METER_PREFIX = "meter.";
/** Every other key the view emits; `meters` stands for "no meter today". */
export const TENANT_HOME_KEYS = ["unit", "microgrid", "today", "meters"] as const;

/**
 * What the view calls the unit: its unit label, else the tenant's display
 * name, which is the tenant's own name and the same for every unit they
 * rent. The GUI host names units the same way in the shell (unitName in
 * @/lib/gui/host/server/units); change both together.
 */
function unitTitle(tenant: TenantHome["tenant"]): string {
  return tenant.unitLabel?.trim() || tenant.displayName.trim() || "Your unit";
}

export function buildTenantHomeModel(home: TenantHome, fmt: Fmt): LoadedModel<"record"> {
  const meters = home.meters.map((meter) => ({
    key: `${TENANT_METER_PREFIX}${meter.deviceId}`,
    label: meter.name,
    // The role's label from the staff pages' map, without its tone: a
    // tenant's own meter is not a state to draw attention to.
    value: fmt.text(statusEntry("tenantDeviceRole", meter.role)?.label ?? meter.role),
  }));
  return {
    title: unitTitle(home.tenant),
    entity: { kind: "tenant", id: home.tenant.id, label: unitTitle(home.tenant) },
    actions: [],
    body: {
      sections: [
        {
          fields: [
            { key: "unit", label: "Unit", value: home.tenant.unitLabel ? fmt.text(home.tenant.unitLabel) : fmt.empty() },
            { key: "microgrid", label: "Microgrid", value: fmt.text(home.microgrid.name) },
            { key: "today", label: "Today", value: fmt.date(home.date) },
          ],
        },
        {
          title: "Meters",
          fields:
            meters.length > 0
              ? meters
              : [{ key: "meters", label: "Meters", value: fmt.text("No meter is assigned to this unit today") }],
        },
      ],
    },
  };
}

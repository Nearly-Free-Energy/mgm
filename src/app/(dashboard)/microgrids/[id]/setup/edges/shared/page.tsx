import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Device } from "@/lib/types/domain";
import { Banner } from "@/components/ui/banner";
import { StatusChip } from "@/components/ui/status-chip";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";

// Setup > Edges > Shared (D2 / #53).
// Devices on this microgrid's edges that are NOT linked to any household.
// Backed by the `microgrid_shared_devices` VIEW (see 00004_views.sql).
//
// Security note: the view is declared with `security_invoker = true`,
// so Supabase's row-level security policies on the underlying `devices`
// + `edges` tables are enforced as the CALLER, not as the view owner.

type SharedDeviceRow = Pick<
  Device,
  "id" | "name" | "device_type" | "openems_component_id" | "edge_id"
> & { microgrid_id: string };

export default async function SharedDevicesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const levels = await getHierarchyLevels(supabase, {
    kind: "microgrid",
    microgridId: id,
  });

  const { data: sharedDevices, error: devErr } = await supabase
    .from("microgrid_shared_devices")
    .select("id, name, device_type, openems_component_id, edge_id, microgrid_id")
    .eq("microgrid_id", id)
    .order("name")
    .returns<SharedDeviceRow[]>();

  if (devErr) {
    // The raw PostgREST message names database objects; log it for the
    // operator and show the user a plain message instead.
    console.error(
      JSON.stringify({
        event: "shared_devices.query_error",
        microgridId: id,
        code: devErr.code,
        message: devErr.message,
        details: devErr.details,
        hint: devErr.hint,
        at: new Date().toISOString(),
      }),
    );
    return (
      <Banner tone="destructive" title="Could not load shared devices">
        The shared devices for this microgrid could not be loaded. Refresh the
        page to try again.
      </Banner>
    );
  }

  // Fetch edge names for the devices we found, so we can display the edge name.
  const edgeIds = Array.from(new Set((sharedDevices ?? []).map((d) => d.edge_id)));
  const { data: edges } = edgeIds.length
    ? await supabase
        .from("edges")
        .select("id, name")
        .in("id", edgeIds)
    : { data: [] as { id: string; name: string }[] };

  const edgeNameById: Record<string, string> = {};
  for (const e of edges ?? []) edgeNameById[e.id] = e.name;

  return (
    <div className="space-y-4">
      <HierarchyNav levels={levels} className="mb-2" />
      <div>
        <Link
          href={`/microgrids/${id}/setup/edges`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to edges
        </Link>
        <h3 className="mt-2 text-lg font-semibold text-foreground">
          Shared devices
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Devices on this microgrid&apos;s edges that are not linked to any
          household. Typical examples: grid meter, PV inverter, battery.
        </p>
      </div>

      {(!sharedDevices || sharedDevices.length === 0) ? (
        <p className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          All devices on this microgrid are linked to a household. No shared
          devices to show.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Device
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Type
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Edge
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  OpenEMS component
                </th>
              </tr>
            </thead>
            <tbody>
              {sharedDevices.map((device) => (
                <tr key={device.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {device.name}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip
                      kind="deviceType"
                      status={device.device_type}
                    />
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">
                    <Link
                      href={`/microgrids/${id}/setup/edges/${device.edge_id}`}
                      className="hover:underline"
                    >
                      {edgeNameById[device.edge_id] ?? device.edge_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {device.openems_component_id ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

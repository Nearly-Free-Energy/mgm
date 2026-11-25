import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { OPENEMS_ID_FORMAT_HINT, parseOpenEmsId } from "@/lib/openems/ids";
import { SaveDevicesBody } from "@/lib/metering/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * POST /api/devices
 *
 * Transactional upsert of discovered devices (F #57).
 * Browser NEVER writes `devices` directly — this route is the only write path.
 *
 * Request body:
 * {
 *   edgeId: string;          // DB UUID of the edge (NOT the OpenEMS edge ID string)
 *   devices: Array<{
 *     componentId: string;   // OpenEMS component ID (e.g. "meter0"); trimmed,
 *                            // then must fit OPENEMS_ID_PATTERN, else 400
 *                            // `invalid_component_id`
 *     factoryId: string;     // OpenEMS factory ID
 *     openemsChannelAddress: string;
 *     deviceType: string;    // device_type enum value
 *     name: string;          // operator-supplied display name
 *   }>
 * }
 *
 * Parsed with `SaveDevicesBody` (`@/lib/metering/schemas`), the
 * `metering.save-devices` action's input: a body of another shape answers
 * 400 `invalid_body`, with the messages below where the old checks gave
 * them. The component id's format stays this route's own check.
 *
 * Upsert key: (edge_id, openems_component_id)
 * On conflict: updates device_type and name (idempotent re-discovery).
 *
 * RLS: Supabase Row Level Security on the `devices` table enforces that only
 * users with user_can_access_microgrid() for the edge's microgrid can insert.
 * The server client uses the caller's auth session (cookies) so RLS applies.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Presence, the edge's UUID, a non-empty devices array and each row's
  // fields are the schema's; each component id's format is checked here.
  const parsed = await parseJsonBody(request, SaveDevicesBody);
  if (!parsed.ok) return parsed.response;
  const { edgeId, devices } = parsed.data;

  for (const device of devices) {
    if (parseOpenEmsId(device.componentId) === null) {
      return NextResponse.json(
        {
          error: `componentId must be ${OPENEMS_ID_FORMAT_HINT}.`,
          reason: "invalid_component_id",
        },
        { status: 400 }
      );
    }
  }

  const supabase = await createClient();
  // MGM runtime gate: metering writes fail closed while the plugin is disabled.
  const pluginGate = await gateRoute(supabase, {
    plugin: "metering",
    target: { kind: "edge", id: edgeId },
    method: "POST",
  });
  if (pluginGate) return pluginGate;

  // Build upsert rows. openems_component_id is required for OpenEMS-sourced edges.
  const rows = devices.map((d) => {
    // Checked in the loop above, so never null here.
    const componentId = parseOpenEmsId(d.componentId) as string;
    return {
      edge_id: edgeId,
      name: d.name.trim() || componentId,
      device_type: d.deviceType,
      openems_component_id: componentId,
      config: {} as Record<string, never>,
    };
  });

  // Upsert: INSERT ... ON CONFLICT (edge_id, openems_component_id) DO UPDATE
  // The UNIQUE constraint on devices(edge_id, openems_component_id) was added in
  // 00001_schema.sql (AB #50). This upsert is atomic per Postgres transaction semantics.
  const { data, error } = await supabase
    .from("devices")
    .upsert(rows, {
      onConflict: "edge_id,openems_component_id",
      ignoreDuplicates: false, // update device_type + name on conflict
    })
    .select("id, name, device_type, openems_component_id");

  if (error) {
    // RLS violation surfaces as a PostgREST 403 / error code.
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to add devices to this edge" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to save devices: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ saved: data ?? [] }, { status: 200 });
}

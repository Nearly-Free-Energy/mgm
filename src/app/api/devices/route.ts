import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { OPENEMS_ID_FORMAT_HINT, parseOpenEmsId } from "@/lib/openems/ids";
import { SaveDevicesBody } from "@/lib/metering/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

/** The code of the 409 that names devices already saved on the edge. */
const DEVICES_ALREADY_SAVED = "metering_devices_already_saved";

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * POST /api/devices
 *
 * Saves devices newly discovered on an edge (F #57).
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
 * New devices only. A body naming any device already saved on the edge
 * (the same edge and trimmed component id) is refused whole, before any
 * write: 409 { error, code: "metering_devices_already_saved", componentIds }
 * names each one, and nothing is saved. A saved device is changed only by
 * PATCH /api/devices/[id] (`metering.edit-device`), which checks a change of
 * type against the device's tenant links; saving over it here would skip
 * that check and reset its `config`. The rows go in one INSERT, so a device
 * another request saves between the check and the insert fails the whole
 * insert on UNIQUE (edge_id, openems_component_id) (00001_schema.sql), and
 * is answered the same way.
 *
 * 200 { saved: [{ id, name, device_type, openems_component_id }] }.
 *
 * RLS: Supabase Row Level Security on the `devices` table enforces that only
 * users with user_can_access_microgrid() for the edge's microgrid can insert.
 * The server client uses the caller's auth session (cookies) so RLS applies,
 * to the check as well: it reads only devices the caller may read, so a
 * refusal names nothing the caller could not read directly.
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

  // The rows as stored. openems_component_id is required for OpenEMS-sourced edges.
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
  const componentIds = rows.map((r) => r.openems_component_id);

  const saved = await alreadySaved(supabase, edgeId, componentIds);
  if (saved === null) {
    return NextResponse.json(
      { error: "Could not check this edge's saved devices. Try again shortly." },
      { status: 503 }
    );
  }
  if (saved.length > 0) return alreadySavedResponse(saved);

  const { data, error } = await supabase
    .from("devices")
    .insert(rows)
    .select("id, name, device_type, openems_component_id");

  if (error) {
    // Saved by another request since the check above: the insert wrote nothing.
    if (error.code === "23505") {
      const now = await alreadySaved(supabase, edgeId, componentIds);
      if (now !== null && now.length > 0) return alreadySavedResponse(now);
    }
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

/**
 * Which of `componentIds` are saved on the edge, in the body's order, each
 * once; null when they could not be read.
 */
async function alreadySaved(supabase: Client, edgeId: string, componentIds: string[]): Promise<string[] | null> {
  const { data, error } = await supabase
    .from("devices")
    .select("openems_component_id")
    .eq("edge_id", edgeId)
    .in("openems_component_id", componentIds);
  if (error) return null;
  const stored = new Set((data ?? []).map((d) => d.openems_component_id));
  return [...new Set(componentIds.filter((id) => stored.has(id)))];
}

function alreadySavedResponse(componentIds: string[]): NextResponse {
  return NextResponse.json(
    {
      error: `Already saved on this edge: ${componentIds.join(", ")}. Nothing was saved. Discover devices again to see which are new.`,
      code: DEVICES_ALREADY_SAVED,
      componentIds,
    },
    { status: 409 }
  );
}

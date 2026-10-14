import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import { gateRoute } from "@/lib/runtime/gate";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/openems/status?microgridId=<uuid>&edgeIds=<id>[,<id>...]
 *
 * Post-#101: every status call names a microgrid; we resolve the client from
 * that microgrid's saved config.
 */
export async function GET(request: NextRequest) {
  const microgridId = request.nextUrl.searchParams.get("microgridId");
  const edgeIdsParam = request.nextUrl.searchParams.get("edgeIds");

  if (!microgridId) {
    return NextResponse.json(
      { error: "Missing required query parameter: microgridId" },
      { status: 400 }
    );
  }
  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json(
      { error: "microgridId must be a UUID" },
      { status: 400 }
    );
  }

  if (!edgeIdsParam) {
    return NextResponse.json(
      { error: "Missing required query parameter: edgeIds" },
      { status: 400 }
    );
  }

  const edgeIds = edgeIdsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (edgeIds.length === 0) {
    return NextResponse.json(
      { error: "edgeIds parameter must contain at least one edge ID" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  // MGM runtime gate: OpenEMS calls fail closed while Metering is disabled.
  const pluginGate = await gateRoute(supabase, {
    plugin: "metering",
    target: { kind: "microgrid", id: microgridId },
    method: "GET",
    access: "write",
  });
  if (pluginGate) return pluginGate;

  let emsConfig;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, microgridId);
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    throw err;
  }

  if (!emsConfig) {
    return NextResponse.json(
      {
        error:
          "OpenEMS Backend not configured. Configure it first on the OpenEMS Backend tab.",
      },
      { status: 409 }
    );
  }

  try {
    const client = createOpenEmsClient(emsConfig);
    const edges = await client.getEdgesStatus(edgeIds);
    return NextResponse.json({ edges });
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Unexpected error fetching edge status" },
      { status: 500 }
    );
  }
}

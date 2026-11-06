import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/microgrids/[id]/grid-tariffs/[tariffId]
 *
 * Removes one grid tariff version. Days it covered fall back to the previous
 * version, or to no tariff (their savings are then not valued).
 *
 * Access: the user's own RLS client only. The `grid_tariffs` FOR ALL policy
 * chains through `user_can_access_microgrid`; a row the caller cannot see
 * deletes nothing and answers 404, the same as a row that does not exist.
 *
 * 204 on success; 400 bad id; 401 no session; 404 not found.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; tariffId: string }> }
): Promise<NextResponse> {
  const { id: microgridId, tariffId } = await params;
  if (!UUID_RE.test(microgridId) || !UUID_RE.test(tariffId)) {
    return NextResponse.json({ error: "Invalid id — expected UUID." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const gate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "microgrid", id: microgridId },
    method: "DELETE",
    access: "write",
  });
  if (gate) return gate;

  const { data, error } = await supabase
    .from("grid_tariffs")
    .delete()
    .eq("id", tariffId)
    .eq("microgrid_id", microgridId)
    .select("id");

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to delete this grid tariff" },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: "Failed to delete grid tariff" }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Grid tariff not found" }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}

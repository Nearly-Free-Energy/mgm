import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";

function mapError(error: CommunityManagementError): NextResponse {
  const { ok, status, code, message, field, reason } = error;
  void ok;
  return NextResponse.json(
    {
      error: message,
      code,
      ...(field !== undefined ? { field } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
    { status }
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/households/[id]
 *
 * Released mutations route through the community-management Cordis
 * capability. The route resolves the parent organization needed for the
 * request-scoped composition; the capability re-validates scope, plugin
 * state, and organization access before writing. Household field validation,
 * device-link reconciliation, and cross-household steal protection live in
 * the capability operation so HTTP and future callers share one contract.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid household ID — expected UUID" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: household } = await supabase
    .from("households")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!household) {
    return NextResponse.json({ error: "Household not found" }, { status: 404 });
  }

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", household.microgrid_id)
    .maybeSingle<{
      id: string;
      communities: { org_id: string };
    }>();
  if (!microgrid) {
    return NextResponse.json(
      {
        error: "You do not have permission to update this household.",
        reason: "forbidden",
      },
      { status: 403 }
    );
  }

  const composed = await composeCommunityManagement({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.communityManagement.updateHousehold(
      id,
      body
    );
    if (!result.ok) return mapError(result);
    return NextResponse.json({ household: result.data }, { status: 200 });
  } finally {
    await composed.data.dispose();
  }
}

/**
 * DELETE /api/households/[id]
 *
 * Released deletions route through the community-management Cordis
 * capability — the previous browser-side direct table delete is replaced by
 * this endpoint. Safeguard: households with billing history are refused
 * (409) because line items cascade off the household row.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid household ID — expected UUID" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { data: household } = await supabase
    .from("households")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!household) {
    return NextResponse.json({ error: "Household not found" }, { status: 404 });
  }

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", household.microgrid_id)
    .maybeSingle<{
      id: string;
      communities: { org_id: string };
    }>();
  if (!microgrid) {
    return NextResponse.json(
      {
        error: "You do not have permission to delete this household.",
        reason: "forbidden",
      },
      { status: 403 }
    );
  }

  const composed = await composeCommunityManagement({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result =
      await composed.data.communityManagement.deleteHousehold(id);
    if (!result.ok) return mapError(result);
    return new NextResponse(null, { status: 204 });
  } finally {
    await composed.data.dispose();
  }
}

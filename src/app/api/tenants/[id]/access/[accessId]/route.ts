import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";

/**
 * DELETE /api/tenants/[id]/access/[accessId] — remove one person's access
 * to a unit's tenant pages (RFC mgm#197 § 6), from the tenant record.
 *
 * The unit and its organization are read with the caller's own client as
 * POST /api/tenants/[id]/access reads them, then
 * composeCommunityManagement checks the session, organization access and
 * the community-management gate. fn_tenant_access_revoke runs on the
 * caller's own client: it checks the caller against the unit's microgrid
 * and removes only a tenant row of this unit. The service role is not
 * used. Removing access is allowed while the tenant app is off.
 *
 * Response: 204 with no body.
 * Errors: { error, code, reason? } with fixed copy.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORBIDDEN_COPY = "You do not have permission to manage access to this unit.";

function mapError(error: CommunityManagementError): NextResponse {
  const { status, code, message, field, reason } = error;
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

const forbidden = () =>
  NextResponse.json(
    { error: FORBIDDEN_COPY, code: "forbidden", reason: "forbidden" },
    { status: 403 }
  );
const tenantNotFound = () =>
  NextResponse.json({ error: "Tenant not found", code: "tenant_not_found" }, { status: 404 });

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; accessId: string }> }
): Promise<NextResponse> {
  const { id, accessId } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid tenant ID — expected UUID" }, { status: 400 });
  }
  if (!UUID_RE.test(accessId)) {
    return NextResponse.json({ error: "Invalid access ID — expected UUID" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!tenant) return tenantNotFound();

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", tenant.microgrid_id)
    .maybeSingle<{ id: string; communities: { org_id: string } }>();
  if (!microgrid) return forbidden();

  const composed = await composeCommunityManagement({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const { error } = await supabase.rpc("fn_tenant_access_revoke", {
      _tenant_id: id,
      _access_id: accessId,
    });
    if (error) {
      const { code, message } = error as { code?: string; message?: string };
      if (code === "42501") return forbidden();
      if (code === "P0002" && message === "Tenant not found.") return tenantNotFound();
      if (code === "P0002") {
        return NextResponse.json(
          { error: "This address no longer has access to this unit.", code: "access_not_found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Could not remove access. Retry the request.", code: "tenant_access_failed" },
        { status: 500 }
      );
    }

    // Server log only, with ids.
    console.info(
      JSON.stringify({
        event: "tenant_access.revoked",
        tenant_id: id,
        access_id: accessId,
        actor_id: composed.data.scope.userId,
        at: new Date().toISOString(),
      })
    );
    return new NextResponse(null, { status: 204 });
  } finally {
    await composed.data.dispose();
  }
}

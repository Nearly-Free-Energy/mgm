import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";
import {
  CREATE_TENANT_REFUSALS,
  CreateTenantBody,
} from "@/lib/community-management/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

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

/**
 * POST /api/tenants/with-meter, as `community.create-tenant`.
 *
 * Creates a tenant. Originally written for the Add-Tenant wizard
 * (UX2 / #74) when meter assignment was mandatory; route name is preserved
 * for back-compat. Two paths post-#158:
 *
 *   - `device_id` present and non-empty → calls `fn_create_tenant_with_meter`
 *     (which now wraps `fn_create_tenant` with a non-null device id).
 *   - `device_id` null/missing/empty → calls `fn_create_tenant` directly
 *     with `p_device_id => null` (manual-billing tenant, no meter wiring).
 *
 * Released mutations route through the community-management Cordis
 * capability. The route resolves the parent organization needed for the
 * request-scoped composition; the capability re-validates scope, plugin
 * state, and organization access before writing. The RPC is SECURITY
 * INVOKER — RLS on tenants and tenant_devices decides whether the
 * caller may write.
 *
 * The body is CreateTenantBody (src/lib/community-management/schemas.ts),
 * refused with this route's own answers (CREATE_TENANT_REFUSALS) before
 * anything is read.
 *
 * Response:
 *   201 { tenant_id: string }
 *   400 invalid JSON | tenant_phone_required (#155)
 *   403 RLS denial (42501) or "device does not belong" / "not a consumption_meter"
 *   409 partial unique index collision (meter already assigned)
 *   422 missing required field
 *   500 unexpected
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJsonBody(request, CreateTenantBody, { refusals: CREATE_TENANT_REFUSALS });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const microgridId = body.microgrid_id;

  const supabase = await createClient();
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, community_id, communities!inner(org_id)")
    .eq("id", microgridId)
    .maybeSingle<{
      id: string;
      community_id: string;
      communities: { org_id: string };
    }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Not authorized to create a tenant on this microgrid." },
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
      await composed.data.communityManagement.createTenant(body);
    if (!result.ok) return mapError(result);
    return NextResponse.json(result.data, { status: 201 });
  } finally {
    await composed.data.dispose();
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";
import {
  DeleteTenantBody,
  UPDATE_TENANT_REFUSALS,
  UpdateTenantBody,
} from "@/lib/community-management/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import { typedNameMatches } from "@/lib/validation/typed-name";

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
 * PATCH /api/tenants/[id], as `community.update-tenant`.
 *
 * The body is UpdateTenantBody (src/lib/community-management/schemas.ts),
 * refused with this route's own answers (UPDATE_TENANT_REFUSALS) before the
 * tenant is read.
 *
 * Released mutations route through the community-management Cordis
 * capability. The route resolves the parent organization needed for the
 * request-scoped composition; the capability re-validates scope, plugin
 * state, and organization access before writing. Tenant field validation,
 * device-link reconciliation, and cross-tenant steal protection live in
 * the capability operation so HTTP and future callers share one contract.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid tenant ID — expected UUID" },
      { status: 400 }
    );
  }

  const parsed = await parseJsonBody(request, UpdateTenantBody, UPDATE_TENANT_REFUSALS);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", tenant.microgrid_id)
    .maybeSingle<{
      id: string;
      communities: { org_id: string };
    }>();
  if (!microgrid) {
    return NextResponse.json(
      {
        error: "You do not have permission to update this tenant.",
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
    const result = await composed.data.communityManagement.updateTenant(
      id,
      body
    );
    if (!result.ok) return mapError(result);
    return NextResponse.json({ tenant: result.data }, { status: 200 });
  } finally {
    await composed.data.dispose();
  }
}

/**
 * DELETE /api/tenants/[id], as `community.delete-tenant`.
 *
 * Released deletions route through the community-management Cordis
 * capability — the previous browser-side direct table delete is replaced by
 * this endpoint. Safeguard: tenants with billing history are refused
 * (409) because line items cascade off the tenant row.
 *
 * Confirmation: `community.delete-tenant` is a typed action, so the GUI host
 * sends DeleteTenantBody's `confirmation`, the name the person typed, and a
 * name that is not the tenant's answers 428 `tenant_delete_name_mismatch`
 * with nothing deleted. A request with no body, as the tenants page's
 * delete dialog sends (TenantTable), is not asked for one: requiring it
 * would change that page. If the page comes to send the confirmation,
 * require it. docs/cordis-runtime.md tells the action catalog's clients so.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid tenant ID — expected UUID" },
      { status: 400 }
    );
  }

  // A DELETE often has no body; an empty one is read as no confirmation.
  const empty = (await request.clone().text()).trim() === "";
  const parsed = empty
    ? ({ ok: true, data: DeleteTenantBody.parse({}) } as const)
    : await parseJsonBody(request, DeleteTenantBody);
  if (!parsed.ok) return parsed.response;

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, microgrid_id, display_name")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string; display_name: string | null }>();
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", tenant.microgrid_id)
    .maybeSingle<{
      id: string;
      communities: { org_id: string };
    }>();
  if (!microgrid) {
    return NextResponse.json(
      {
        error: "You do not have permission to delete this tenant.",
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
    const { confirmation } = parsed.data;
    if (confirmation) {
      // A typed confirmation needs a name to type: the delete prepare
      // refuses a tenant without one with this copy too.
      const name = tenant.display_name?.trim() ? tenant.display_name : null;
      if (name === null) {
        return NextResponse.json(
          { error: "Unnamed entity cannot be typed-to-confirm.", code: "tenant_unnamed" },
          { status: 409 }
        );
      }
      if (!typedNameMatches(confirmation.typed, name)) {
        return NextResponse.json(
          {
            error: `Type the tenant's name, ${name}, to delete it.`,
            code: "tenant_delete_name_mismatch",
            field: "confirmation",
          },
          { status: 428 }
        );
      }
    }
    const result =
      await composed.data.communityManagement.deleteTenant(id);
    if (!result.ok) return mapError(result);
    return new NextResponse(null, { status: 204 });
  } finally {
    await composed.data.dispose();
  }
}

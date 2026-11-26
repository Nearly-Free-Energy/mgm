import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";
import {
  DeleteCommunityBody,
  UPDATE_COMMUNITY_REFUSALS,
  UpdateCommunityBody,
} from "@/lib/community-management/schemas";
import { countEntityDescendants } from "@/lib/entity-descendants";
import { gateRoute } from "@/lib/runtime/gate";
import { parseJsonBody } from "@/lib/validation/parse-body";
import { typedNameMatches } from "@/lib/validation/typed-name";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  UUID_RE,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";

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
 * PATCH /api/communities/[id] — update a community (#76), as
 * `community.update-community`.
 *
 * Dirty-fields semantics: only keys present in body are applied. The body
 * is UpdateCommunityBody (src/lib/community-management/schemas.ts), refused
 * with this route's own answers (UPDATE_COMMUNITY_REFUSALS). Re-parenting
 * via `org_id` is NOT supported through this endpoint: the schema refuses
 * the key, which the route ignored before it parsed with a schema.
 *
 * Released mutations route through the community-management Cordis
 * capability. The route resolves the parent organization needed for the
 * request-scoped composition; the capability re-validates scope, plugin
 * state, and organization access before writing.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid community id — expected UUID." },
      { status: 400 }
    );
  }

  const parsed = await parseJsonBody(request, UpdateCommunityBody, UPDATE_COMMUNITY_REFUSALS);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = await createClient();
  const { data: parent } = await supabase
    .from("communities")
    .select("org_id")
    .eq("id", id)
    .maybeSingle<{ org_id: string }>();
  if (!parent) {
    return NextResponse.json(
      { error: "Not authorized to update this community." },
      { status: 403 }
    );
  }

  const composed = await composeCommunityManagement({
    supabase,
    organizationId: parent.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.communityManagement.updateCommunity(
      id,
      body
    );
    if (!result.ok) return mapError(result);
    return NextResponse.json({ community: result.data }, { status: 200 });
  } finally {
    await composed.data.dispose();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — see ./delete-preview/route.ts for the preview GET.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/communities/[id] — delete a community (#89).
 *
 * Authorization: super_admin OR org_manager with access to the community's
 * parent org (AC-ROUTE-2 step 2). Uses `currentUserCanAccessCommunity`.
 *
 * Cascade policy (trust-preview per AC-ROUTE-6): no pre-DELETE re-count;
 * the UI friction layer is the safety net. See organization DELETE header
 * for full rationale; the identical pattern applies here, including the
 * 409 for a community that holds closed billing or billing with recorded
 * payments.
 *
 * Idempotency: first-delete wins, repeats 404 (AC-ROUTE-7).
 *
 * Confirmation: `community.delete-community` is a typed action, so the GUI
 * host sends DeleteCommunityBody's `confirmation`, the name the person
 * typed, and a name that is not the community's answers 428
 * `community_delete_name_mismatch` with nothing deleted. A request with no
 * body, as the community page's delete dialog sends after its own typed
 * check (DeleteEntityButton), is not asked for one: requiring it would
 * change that page. If the page comes to send the confirmation, require it.
 * docs/cordis-runtime.md tells the action catalog's clients so.
 *
 * Cascade chain: communities → microgrids → (edges/devices/tenants/
 * billing_periods/billing_line_items/rate_schedules/tenant_devices), and
 * tenants → user_roles for the tenant role rows (scope_tenant_id, migration
 * 20261118100100). No staff role rows are removed: staff rows are
 * org-scoped. The delete guard on user_roles lets the tenant rows go as a
 * cascade (fn_user_roles_before_delete_guard); if staff roles ever get a
 * scope below the organization, revisit both. The cascade-bypass GUC is
 * still set, to stay consistent with the other entity DELETE routes.
 *
 * Revalidation (AC-UI-6): both `/organizations/<org_id>` and `/communities`
 * layouts are busted so nested nav + top-level community list refresh.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      errorBody("Invalid community id — expected UUID."),
      { status: 400 }
    );
  }

  // A DELETE often has no body; an empty one is read as no confirmation.
  const empty = (await request.clone().text()).trim() === "";
  const parsed = empty
    ? ({ ok: true, data: DeleteCommunityBody.parse({}) } as const)
    : await parseJsonBody(request, DeleteCommunityBody);
  if (!parsed.ok) return parsed.response;

  const supabase = await createClient();

  if (!(await currentUserCanAccessCommunity(supabase, id))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this community."),
      { status: 403 }
    );
  }

  const { data: community, error: fetchErr } = await supabase
    .from("communities")
    .select("id, name, org_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; org_id: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "community");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!community) {
    return NextResponse.json(errorBody("Community not found."), { status: 404 });
  }
  const pluginGate = await gateRoute(supabase, {
    plugin: "community-management",
    target: { kind: "organization", id: community.org_id },
    method: "DELETE",
  });
  if (pluginGate) return pluginGate;
  if (!community.name || !community.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }
  const { confirmation } = parsed.data;
  if (confirmation && !typedNameMatches(confirmation.typed, community.name)) {
    return NextResponse.json(
      {
        error: `Type the community's name, ${community.name}, to delete it.`,
        code: "community_delete_name_mismatch",
        field: "confirmation",
      },
      { status: 428 }
    );
  }

  const descendantCounts = await countEntityDescendants(
    supabase,
    "community",
    id
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this community."),
      { status: 403 }
    );
  }

  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_community",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "community");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Community not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "community",
    entity_id: id,
    entity_name: community.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath(`/organizations/${community.org_id}`, "layout");
  revalidatePath("/communities", "layout");

  return new NextResponse(null, { status: 204 });
}

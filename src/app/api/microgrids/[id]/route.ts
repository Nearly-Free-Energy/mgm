import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";
import { countEntityDescendants } from "@/lib/entity-descendants";
import { isCommunityManagementEnabled } from "@/lib/plugins/state";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  UUID_RE,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";

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
 * PATCH /api/microgrids/[id] — update a microgrid (#76).
 *
 * Dirty-fields semantics: only keys present in body are applied.
 * Re-parenting via `community_id` is NOT supported through this endpoint —
 * ignored if present (would be a "move" feature, deferred).
 *
 * Released mutations route through the community-management Cordis
 * capability. The route resolves the parent organization needed for the
 * request-scoped composition; the capability re-validates scope, plugin
 * state, and organization access before writing.
 *
 * Validation: currency (if sent) must be valid ISO 4217 (422 on RangeError).
 * timezone (if sent) must be a valid IANA zone id — literal 'UTC' or an
 * Area/Location id that Intl.DateTimeFormat resolves; stored in canonical
 * form (422 otherwise, #357 — see src/lib/validation/timezone.ts).
 * Duplicate rename (same community → same name) → 409 with exact copy.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID." },
      { status: 400 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, community_id, communities!inner(org_id)")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      community_id: string;
      communities: { org_id: string };
    }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Not authorized to update this microgrid." },
      { status: 403 }
    );
  }

  const composed = await composeCommunityManagement({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.communityManagement.updateMicrogrid(
      id,
      body
    );
    if (!result.ok) return mapError(result);
    return NextResponse.json({ microgrid: result.data }, { status: 200 });
  } finally {
    await composed.data.dispose();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — see ./delete-preview/route.ts for the preview GET.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/microgrids/[id] — delete a microgrid (#89).
 *
 * Authorization: super_admin OR org_manager with access to the microgrid's
 * parent org (AC-ROUTE-2 step 2).
 *
 * Cascade policy (trust-preview per AC-ROUTE-6): intentional data loss
 * warning per AC-ROUTE-8 — deleting a microgrid while a `draft` billing
 * period is active destroys in-progress meter readings + line items that
 * have not yet been finalized. This is acceptable: the blast-radius dialog
 * surfaces draft vs closed counts distinctly and the operator committed
 * to "destroy everything under {name}" by typing the name.
 *
 * Idempotency: first-delete wins, repeats 404 (AC-ROUTE-7).
 *
 * Revalidation (AC-UI-6): both `/communities/<community_id>` and
 * `/microgrids` layouts are busted.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      errorBody("Invalid microgrid id — expected UUID."),
      { status: 400 }
    );
  }

  const supabase = await createClient();

  if (!(await currentUserCanAccessMicrogrid(supabase, id))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this microgrid."),
      { status: 403 }
    );
  }

  const { data: microgrid, error: fetchErr } = await supabase
    .from("microgrids")
    .select("id, name, community_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; community_id: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "microgrid");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!microgrid) {
    return NextResponse.json(errorBody("Microgrid not found."), { status: 404 });
  }
  const { data: parent } = await supabase
    .from("communities")
    .select("org_id")
    .eq("id", microgrid.community_id)
    .maybeSingle<{ org_id: string }>();
  if (
    parent &&
    !(await isCommunityManagementEnabled(supabase, parent.org_id))
  ) {
    return NextResponse.json(
      errorBody(
        "Community management is disabled for this organization. Enable it in Settings → Plugins before deleting; existing records are preserved."
      ),
      { status: 409 }
    );
  }
  if (!microgrid.name || !microgrid.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }

  const descendantCounts = await countEntityDescendants(supabase, "microgrid", id);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this microgrid."),
      { status: 403 }
    );
  }

  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_microgrid",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "microgrid");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Microgrid not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "microgrid",
    entity_id: id,
    entity_name: microgrid.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath(`/communities/${microgrid.community_id}`, "layout");
  revalidatePath("/microgrids", "layout");

  return new NextResponse(null, { status: 204 });
}

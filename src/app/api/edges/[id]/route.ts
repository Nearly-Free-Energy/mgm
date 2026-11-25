import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  EDGE_ID_FORMAT_CONSTRAINT,
  OPENEMS_ID_FORMAT_HINT,
  isIdFormatViolation,
} from "@/lib/openems/ids";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";
import { DeleteEdgeBody, EditEdgeBody } from "@/lib/metering/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/edges/[id]
 *
 * Post-#104: the body accepts only { name, role }: `EditEdgeBody`
 * (`@/lib/metering/schemas`), the `metering.edit-edge` action's input. A
 * body of another shape answers 400 `invalid_body`, and the following
 * fields are refused with a pointer:
 *   - `data_source_type`, `openems_backend_url` — retired in #101
 *   - `openems_edge_id` — assigned by OpenEMS Discover and is not editable.
 *     Remove the edge and rediscover to link a different OpenEMS edge.
 *
 * Authorization enforced by RLS on `edges`. Postgres `42501` → HTTP 403.
 * A row whose stored openems_edge_id is outside the format
 * (`edges_openems_edge_id_format`) → 409 `stored_id_outside_format`.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid edge ID — expected UUID" }, { status: 400 });
  }

  // Retired and immutable fields are refused by the schema, with the most
  // specific pointer for the most actionable field (EditEdgeBody).
  const parsed = await parseJsonBody(request, EditEdgeBody);
  if (!parsed.ok) return parsed.response;
  const { name, role } = parsed.data;

  // At least one supported field must be provided.
  const hasName = name !== undefined;
  const hasRole = role !== undefined;

  if (!hasName && !hasRole) {
    return NextResponse.json({ error: "No fields provided to update" }, { status: 400 });
  }

  // A blank name is refused here, as it always was (422).
  if (hasName && !name.trim()) {
    return NextResponse.json({ error: "name must be a non-empty string" }, { status: 422 });
  }

  const supabase = await createClient();
  // MGM runtime gate: metering writes fail closed while the plugin is disabled.
  const pluginGate = await gateRoute(supabase, {
    plugin: "metering",
    target: { kind: "edge", id: id },
    method: "PATCH",
  });
  if (pluginGate) return pluginGate;

  // Fetch current row (RLS-filtered) for 404 semantics.
  const { data: currentEdge, error: fetchError } = await supabase
    .from("edges")
    .select("id, name")
    .eq("id", id)
    .single();

  if (fetchError || !currentEdge) {
    if (fetchError?.code === "PGRST116") {
      return NextResponse.json({ error: "Edge not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: fetchError?.message ?? "Edge not found" },
      { status: 404 }
    );
  }

  // Build the update payload — only include fields that were provided.
  // openems_edge_id is intentionally excluded: it is assigned by Discover and
  // is immutable via this endpoint (rejected above as a forbidden field).
  const updateRow: Record<string, unknown> = {};

  if (hasName) updateRow.name = name.trim();
  if (hasRole) updateRow.role = role?.trim() || null;

  const { data, error } = await supabase
    .from("edges")
    .update(updateRow)
    .eq("id", id)
    .select("id, name, openems_edge_id, role, microgrid_id, created_at")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this edge" },
        { status: 403 }
      );
    }

    if (error.code === "23505") {
      if (
        error.message.includes("openems_edge_id") ||
        (error as { details?: string }).details?.includes("openems_edge_id")
      ) {
        return NextResponse.json(
          {
            error:
              "An edge with this OpenEMS edge ID is already registered for this microgrid.",
          },
          { status: 409 }
        );
      }
      const edgeName = name !== undefined ? name.trim() : currentEdge.name;
      return NextResponse.json(
        {
          error: `An edge named '${edgeName}' already exists on this microgrid.`,
        },
        { status: 409 }
      );
    }

    if (isIdFormatViolation(error, EDGE_ID_FORMAT_CONSTRAINT)) {
      return NextResponse.json(
        {
          error: `This edge's stored OpenEMS edge id is not in the format MGM stores (${OPENEMS_ID_FORMAT_HINT}), so the edge cannot be changed until an administrator corrects the id.`,
          reason: "stored_id_outside_format",
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: `Failed to update edge: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ edge: data }, { status: 200 });
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — see ./delete-preview/route.ts for the preview GET.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/edges/[id] — delete an edge (#89).
 *
 * The body is `DeleteEdgeBody` (`@/lib/metering/schemas`), the
 * `metering.delete-edge` action's input. The Edges page confirms in the
 * browser and sends no body, which is read as `{}` and deletes as before. A
 * `confirmation`, as the GUI host sends for the typed step, must carry the
 * edge's name typed, or the answer is 428 `metering_edge_name_mismatch` and
 * nothing is deleted. Once the Edges page sends its delete through the host,
 * require the confirmation, as DELETE /api/billing-periods/[periodId] does.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(errorBody("Invalid edge id — expected UUID."), {
      status: 400,
    });
  }

  const parsed = await parseJsonBody(request, DeleteEdgeBody, { whenEmpty: {} });
  if (!parsed.ok) return parsed.response;
  const { confirmation } = parsed.data;

  const supabase = await createClient();
  // MGM runtime gate: metering writes fail closed while the plugin is disabled.
  const pluginGate = await gateRoute(supabase, {
    plugin: "metering",
    target: { kind: "edge", id: id },
    method: "DELETE",
  });
  if (pluginGate) return pluginGate;

  const { data: edge, error: fetchErr } = await supabase
    .from("edges")
    .select("id, name, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; microgrid_id: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "edge");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!edge) {
    return NextResponse.json(errorBody("Edge not found."), { status: 404 });
  }

  if (!(await currentUserCanAccessMicrogrid(supabase, edge.microgrid_id))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this edge."),
      { status: 403 }
    );
  }

  if (!edge.name || !edge.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }

  if (confirmation && confirmation.typed?.trim() !== edge.name.trim()) {
    return NextResponse.json(
      { ...errorBody("The name typed does not match this edge's name."), code: "metering_edge_name_mismatch" },
      { status: 428 }
    );
  }

  const descendantCounts = await countEntityDescendants(supabase, "edge", id);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this edge."),
      { status: 403 }
    );
  }

  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_edge",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "edge");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Edge not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "edge",
    entity_id: id,
    entity_name: edge.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath(`/microgrids/${edge.microgrid_id}`, "layout");

  return new NextResponse(null, { status: 204 });
}

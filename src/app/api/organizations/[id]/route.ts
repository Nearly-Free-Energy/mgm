import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";
import { isCommunityManagementEnabled } from "@/lib/plugins/state";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  DeleteOrganizationBody,
  UPDATE_ORGANIZATION_REFUSALS,
  UpdateOrganizationBody,
} from "@/lib/organization-directory/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import { typedNameMatches } from "@/lib/validation/typed-name";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  UUID_RE,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";

/**
 * PATCH /api/organizations/[id] — update an organization (#76), as
 * `org.update-organization`.
 *
 * Dirty-fields semantics: the client sends only changed fields. Any column NOT
 * present in the body is left untouched. The handler builds an UPDATE payload
 * from body keys only; a missing `name` key will NOT set name to null. The
 * body is UpdateOrganizationBody (src/lib/organization-directory/schemas.ts),
 * refused with this route's own answers (UPDATE_ORGANIZATION_REFUSALS), so a
 * body is checked before the caller's role, as community management's edits
 * are.
 *
 * Authorization: super_admin only (defense-in-depth + RLS backstop).
 *
 * Validation:
 *   - If `name` is present, it must be non-empty (422).
 *   - If `address_city` is present, it must be non-empty (422).
 *   - If `address_country` is present, it must be non-empty (422).
 *     (Org invariant: we never allow clearing city/country to null.)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid organization id — expected UUID." },
      { status: 400 }
    );
  }

  const parsed = await parseJsonBody(request, UpdateOrganizationBody, { refusals: UPDATE_ORGANIZATION_REFUSALS });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = await createClient();

  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      { error: "Only super_admin users can update organizations." },
      { status: 403 }
    );
  }

  const updates: Record<string, string | null> = {};

  // The schema has trimmed the name, city and country, and refused them
  // blank, so a key present here is a value to store.
  for (const f of ["name", "address_city", "address_country"] as const) {
    const v = body[f];
    if (v !== undefined) updates[f] = v;
  }

  // Optional address fields — only keys present in the body. "" or null
  // clears one (stored as null).
  const OPTIONAL_ADDR_FIELDS = [
    "address_line1",
    "address_line2",
    "address_region",
    "address_postal_code",
  ] as const;

  for (const f of OPTIONAL_ADDR_FIELDS) {
    if (f in body) {
      const v = body[f];
      updates[f] = typeof v === "string" && v.trim() ? v.trim() : null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No fields to update." },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("organizations")
    .update(updates)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this organization." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update organization: ${error.message}` },
      { status: 500 }
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Organization not found." },
      { status: 404 }
    );
  }

  return NextResponse.json({ organization: data }, { status: 200 });
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — GET delete-preview lives in `./delete-preview/route.ts`.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/organizations/[id] — delete an organization (#89).
 *
 * Authorization: `super_admin` only (PM decision #2 / AC-ROUTE-2 step 2).
 *
 * Cascade policy (trust-preview per AC-ROUTE-6): the DELETE does NOT re-run
 * `countEntityDescendants` pre-check. The type-to-confirm UI + blast-radius
 * dialog is the safety layer; racing new descendants in between preview and
 * confirm is acceptable — the caller has explicitly typed the name and
 * committed to "destroy everything under {name}."
 *
 * Closed billing and billing with recorded payments are never deleted: the
 * database refuses the delete while the organization holds either
 * (migration 20261103160000), the delete preview reports it before the
 * dialog opens, and `mapPgError` turns a refusal here into a 409 that says
 * why.
 *
 * Idempotency: first-delete wins, repeats 404 (AC-ROUTE-7). Document rather
 * than chase 204-on-already-gone.
 *
 * Confirmation: `org.delete-organization` is a typed action. The body is
 * DeleteOrganizationBody (src/lib/organization-directory/schemas.ts), and a
 * DELETE often has none, so an empty one is read as `{}`. The route checks
 * the confirmation on every request, after the caller, the plugin and the
 * organization's name are checked:
 *   - no `confirmation`: 428 `organization_delete_confirmation_required`,
 *     naming the organization to type. Nothing is deleted.
 *   - a name that is not the organization's, or none typed: 428
 *     `organization_delete_name_mismatch`.
 * The GUI host sends the name typed in its step, and the organization
 * page's delete dialog (DeleteEntityButton) the name it asked for.
 *
 * Cascade chain: organizations → communities → microgrids → edges → devices
 * → tenant_devices + billing_line_items (device_id SET NULL, survives);
 * microgrids → tenants → tenant_devices + user_roles (tenant role rows,
 * through scope_tenant_id, migration 20261118100100); microgrids
 * → billing_periods → billing_line_items; microgrids → rate_schedules; and,
 * via 00015's new FK, organizations → user_roles (org-scoped).
 *
 * The DELETE is dispatched through `fn_entity_delete_org()` which wraps
 * `SET LOCAL app.entity_cascade_delete = 'on'` + DELETE in a single
 * transaction — required so the `user_roles` BEFORE DELETE trigger's
 * self-revoke guard doesn't roll an org_manager's own-org-delete back.
 * See 00015 header for the full rationale.
 *
 * Revalidation (AC-UI-6): `/organizations` layout is busted post-delete
 * so the shell's organization list reflects the removal on next navigation.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      errorBody("Invalid organization id — expected UUID."),
      { status: 400 }
    );
  }

  // A DELETE often has no body; an empty one is read as `{}`, which asks for the name.
  const parsed = await parseJsonBody(request, DeleteOrganizationBody, { whenEmpty: {} });
  if (!parsed.ok) return parsed.response;

  const supabase = await createClient();

  // Authorization (defense-in-depth in front of RLS).
  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this organization."),
      { status: 403 }
    );
  }

  // A disabled community-management plugin preserves the organization's
  // domain rows: the database trigger would roll the cascade back anyway,
  // so fail here with an actionable message instead.
  if (!(await isCommunityManagementEnabled(supabase, id))) {
    return NextResponse.json(
      errorBody(
        "Community management is disabled for this organization. Enable it in Settings → Plugins before deleting; existing records are preserved."
      ),
      { status: 409 }
    );
  }

  // Load entity name + existence. 404 if gone; 409 if unnamed (unnamed
  // entity can't be typed-to-confirm, so the UI branch can't reach here
  // legitimately — surface a clear error).
  const { data: org, error: fetchErr } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "organization");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!org) {
    return NextResponse.json(errorBody("Organization not found."), { status: 404 });
  }
  if (!org.name || !org.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }
  const { confirmation } = parsed.data;
  const typeTheName = `Type the organization's name, ${org.name.trim()}, to delete it.`;
  if (!confirmation) {
    return NextResponse.json(
      { error: typeTheName, code: "organization_delete_confirmation_required" },
      { status: 428 }
    );
  }
  if (!typedNameMatches(confirmation.typed, org.name)) {
    return NextResponse.json(
      { error: typeTheName, code: "organization_delete_name_mismatch", field: "confirmation" },
      { status: 428 }
    );
  }

  // Pre-count descendants for the log payload (AC-LOG-1). Counts are
  // advisory per AC-ROUTE-6 — we do not re-verify against the preview.
  const descendantCounts = await countEntityDescendants(
    supabase,
    "organization",
    id
  );

  // Resolve actor metadata for the log payload. We never emit the log
  // for an unauthenticated caller (auth() already gated above), but
  // belt-and-suspenders in case the order changes.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this organization."),
      { status: 403 }
    );
  }

  // Execute DELETE via the cascade-safe RPC (see fn_entity_delete_org).
  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_org",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "organization");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }

  // RLS-filtered OR already deleted → 404 (AC-ROUTE-7 idempotency).
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Organization not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "organization",
    entity_id: id,
    entity_name: org.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath("/organizations", "layout");

  return new NextResponse(null, { status: 204 });
}

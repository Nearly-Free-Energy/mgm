import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { SaveInvoiceSettingsBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * PATCH /api/communities/[id]/invoice-config — Save invoice settings (#204 / PDF2).
 *
 * Why a separate sub-route (not extending PATCH /api/communities/[id]):
 *   - Different permission gate: invoice-config requires
 *     `currentUserCanAccessOrg` (org_manager-of-parent-org / super_admin)
 *     while the parent route uses `currentUserCanAccessCommunity`.
 *   - Different validation path (`SaveInvoiceSettingsBody`, which parses
 *     invoice_config with the Zod `InvoiceConfigSchema`, vs a hand-rolled
 *     allow-list).
 *   - Clean rollback boundary if the PDF workstream needs a partial revert.
 *
 * Why PATCH (not PUT like Payment):
 *   - Matches the org-update precedent at `src/app/api/organizations/[id]/route.ts`.
 *   - Signals partial-resource semantics on the parent `communities` row.
 *   - Payment's PUT is the codebase outlier; don't mirror it blindly.
 *
 * Body shape (`SaveInvoiceSettingsBody`, `@/lib/billing/schemas`):
 *   {
 *     invoice_prefix: string | null,    // null → DB column NULL (allowed by 00033)
 *     invoice_config: InvoiceConfig,    // Zod-validated JSONB
 *   }
 * Unknown top-level keys are refused.
 *
 * Check ordering (mirrors UX5b #184 + #196):
 *   1. UUID check on [id] → 400.
 *   2. Parse the body → 400 { error, field?, code: "invalid_body" }. Before
 *      the read and the permission check: the answer depends only on the
 *      body the caller sent, so it reveals nothing about the community.
 *   3. Row read via user-bound client → NULL → 404 (don't leak existence).
 *   4. `currentUserCanAccessOrg(community.org_id)` → false → 403.
 *   5. Billing plugin gate.
 *   6. UPDATE both columns. On success: revalidatePath + 200 { status: "success" }.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: communityId } = await params;

  // (1) UUID parse.
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json(
      { error: "Invalid community id — expected UUID." },
      { status: 400 },
    );
  }

  // (2) Body.
  const parsed = await parseJsonBody(request, SaveInvoiceSettingsBody);
  if (!parsed.ok) return parsed.response;
  const { invoice_prefix: invoicePrefix, invoice_config: invoiceConfig } =
    parsed.data;

  const supabase = await createClient();

  // (3) Row read — RLS-hidden / missing → 404 (don't leak via 403).
  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select("id, org_id, invoice_config, invoice_prefix")
    .eq("id", communityId)
    .maybeSingle<{
      id: string;
      org_id: string;
      invoice_config: unknown;
      invoice_prefix: string | null;
    }>();

  if (commErr) {
    return NextResponse.json(
      { error: `Failed to read community: ${commErr.message}` },
      { status: 500 },
    );
  }
  if (!community) {
    return NextResponse.json(
      { error: "Community not found." },
      { status: 404 },
    );
  }

  // (4) Permission — currentUserCanAccessOrg returns true for super_admin OR
  // org_manager scoped to this community's parent org (#196).
  if (!(await currentUserCanAccessOrg(supabase, community.org_id))) {
    return NextResponse.json(
      {
        error:
          "You do not have permission to update this community's invoice settings.",
      },
      { status: 403 },
    );
  }

  // (4a) Release 3 (issue #5): invoice branding writes fail closed while
  // billing is disabled.
  const billingGate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "community", id: communityId },
    method: "PATCH",
  });
  if (billingGate) return billingGate;

  // (6) UPDATE.
  const { error: updateErr } = await supabase
    .from("communities")
    .update({
      invoice_prefix: invoicePrefix,
      invoice_config: invoiceConfig,
    })
    .eq("id", communityId);

  if (updateErr) {
    if (
      updateErr.code === "42501" ||
      updateErr.message?.includes("row-level security")
    ) {
      return NextResponse.json(
        {
          error:
            "You do not have permission to update this community's invoice settings.",
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: `Failed to update invoice settings: ${updateErr.message}` },
      { status: 500 },
    );
  }

  // Bust the layout cache so the community's pages re-fetch.
  revalidatePath(`/communities/${communityId}`, "layout");

  return NextResponse.json({ status: "success" }, { status: 200 });
}

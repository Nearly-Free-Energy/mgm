/**
 * GET /api/payments/attempts?lineItemId=<uuid>
 *
 * Payment receipt history for one bill. Reads stay available while the
 * Payments/Pesapal plugins are disabled — only organization scope applies.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { composePayments } from "@/lib/payments/compose";
import { resolveOrgForLineItem } from "@/lib/payments/resolve-org";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const lineItemId = request.nextUrl.searchParams.get("lineItemId") ?? "";
  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "lineItemId must be a UUID.", reason: "bad_request" },
      { status: 400 }
    );
  }
  const supabase = await createClient();
  const scope = await resolveOrgForLineItem(supabase, lineItemId);
  if (!scope) {
    return NextResponse.json(
      { error: "Bill not found.", reason: "not_found" },
      { status: 404 }
    );
  }
  const composed = await composePayments({
    supabase,
    organizationId: scope.orgId,
    allowDisabled: true,
  });
  if (!composed.ok) {
    return NextResponse.json(
      { error: composed.message, reason: composed.code },
      { status: composed.status }
    );
  }
  try {
    const history = await composed.data.payments.listHistory(lineItemId);
    if (!history.ok) {
      return NextResponse.json(
        { error: history.message, reason: history.code },
        { status: history.status }
      );
    }
    return NextResponse.json(history.data);
  } finally {
    await composed.data.dispose();
  }
}

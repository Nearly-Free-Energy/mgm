import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { composePayments } from "@/lib/payments/compose";
import { resolveOrgForLineItem } from "@/lib/payments/resolve-org";

// Sharing a stable link never submits a checkout or charges a customer.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ lineItemId: string }> }) {
  const { lineItemId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(lineItemId)) return NextResponse.json({ error: "Invalid bill id" }, { status: 400 });
  const supabase = await createClient();
  const scope = await resolveOrgForLineItem(supabase, lineItemId);
  if (!scope) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  const composed = await composePayments({ supabase, organizationId: scope.orgId, allowDisabled: true });
  if (!composed.ok) return NextResponse.json({ error: composed.message, reason: composed.code }, { status: composed.status });
  try {
    const result = await composed.data.payments.stablePaymentLink(lineItemId);
    if (!result.ok) return NextResponse.json({ error: result.message, reason: result.code }, { status: result.status });
    return NextResponse.json({ redirectUrl: result.data.url, orderTrackingId: null, merchantReference: null });
  } finally { await composed.data.dispose(); }
}

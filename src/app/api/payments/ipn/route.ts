import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { composePaymentsPublic } from "@/lib/payments/compose";

export async function processNotification(request: NextRequest) {
  let raw: Record<string, unknown> = Object.fromEntries(request.nextUrl.searchParams);
  if (request.method === "POST") {
    try {
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
      if (body && typeof body === "object") raw = { ...raw, ...body };
    } catch { /* Invalid bodies receive a failed acknowledgement. */ }
  }
  const tracking = String(raw.OrderTrackingId ?? raw.orderTrackingId ?? "");
  const reference = String(raw.OrderMerchantReference ?? raw.merchantReference ?? "");
  let processed = false;
  if (tracking && reference && tracking.length <= 200 && reference.length <= 200) {
    try {
      const supabase = createServiceClient();
      const { data: attempt, error } = await supabase.from("payment_attempts").select("org_id").eq("merchant_reference", reference).maybeSingle<{ org_id: string }>();
      if (error) throw error;
      if (attempt) {
        const composed = await composePaymentsPublic({ supabase, organizationId: attempt.org_id });
        if (composed.ok) {
          try {
            const result = await composed.data.payments.handleNotification(raw);
            processed = result.ok && result.data.processed;
          } finally { await composed.data.dispose(); }
        }
      } else {
        // Unknown references remain invisible to session clients; retry later.
        await supabase.from("payment_notifications").upsert({ provider: "pesapal", org_id: null, tracking_id: tracking, merchant_reference: reference, raw_payload: raw }, { onConflict: "provider,tracking_id", ignoreDuplicates: true });
      }
    } catch { /* Fail closed; durable inbox/worker retries processing. */ }
  }
  return NextResponse.json({ orderNotificationType: "IPNCHANGE", orderTrackingId: tracking, orderMerchantReference: reference, status: processed ? 200 : 500 }, { status: processed ? 200 : 500, headers: { "Cache-Control": "no-store" } });
}
export const GET = processNotification;
export const POST = processNotification;

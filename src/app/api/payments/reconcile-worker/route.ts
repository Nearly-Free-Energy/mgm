/** Five-minute Supabase worker. Header authentication is required; durable
 * leases recover crashes and stop retrying after the configured limit. */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { composePaymentsPublic } from "@/lib/payments/compose";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = (process.env.PAYMENTS_WORKER_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "Worker is not configured" }, { status: 503 });
  const provided = request.headers.get("x-payments-worker-secret") ?? "";
  if (provided !== secret) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const supabase = createServiceClient();
  const { data: pending } = await supabase.from("payment_attempts").select("org_id, provider_tracking_id, merchant_reference").in("status", ["pending", "confirmation_pending"]).not("provider_tracking_id", "is", null).limit(50);
  for (const attempt of pending ?? []) await supabase.from("payment_notifications").upsert({ org_id: attempt.org_id, provider: "pesapal", tracking_id: attempt.provider_tracking_id, merchant_reference: attempt.merchant_reference, raw_payload: { OrderTrackingId: attempt.provider_tracking_id, OrderMerchantReference: attempt.merchant_reference } }, { onConflict: "provider,tracking_id", ignoreDuplicates: true });
  const { data: due, error } = await supabase.rpc("fn_payment_due_notifications", {
    _limit: 50,
  });
  if (error) {
    // Tables not migrated yet (deploy ordering) — no-op, do not fail the cron.
    if ((error.code ?? "") === "42P01" || /does not exist/i.test(error.message ?? "")) {
      return NextResponse.json({ processed: 0, failed: 0, skipped: "not_migrated" });
    }
    return NextResponse.json({ processed: 0, failed: 0, error: "Could not lease payment notifications" }, { status: 500 });
  }
  const rows = (due ?? []) as {
    id: string;
    tracking_id: string;
    merchant_reference: string;
    raw_payload: unknown;
  }[];

  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const { data: attempt } = await supabase
        .from("payment_attempts")
        .select("id, org_id")
        .eq("merchant_reference", row.merchant_reference)
        .maybeSingle<{ id: string; org_id: string }>();
      if (!attempt?.org_id) {
        await supabase.from("payment_notifications").update({ status: "dead_letter", last_error: "unknown_reference" }).eq("id", row.id);
        failed += 1;
        continue;
      }
      const composed = await composePaymentsPublic({
        supabase,
        organizationId: attempt.org_id,
      });
      if (!composed.ok) {
        failed += 1;
        continue;
      }
      try {
        const handled = await composed.data.payments.handleNotification(
          row.raw_payload ?? {
            OrderTrackingId: row.tracking_id,
            OrderMerchantReference: row.merchant_reference,
          }
        );
        if (handled.ok && handled.data.processed) processed += 1;
        else failed += 1;
      } finally {
        await composed.data.dispose().catch(() => {});
      }
    } catch {
      failed += 1;
    }
  }
  return NextResponse.json({ processed, failed });
}

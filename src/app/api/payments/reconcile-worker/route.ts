/**
 * POST /api/payments/reconcile-worker
 *
 * Reconciliation worker: processes due `payment_notifications`
 * (received/failed past next_retry_at) idempotently. Runs every five
 * minutes through Supabase scheduling (pg_cron → webhook) or Vercel cron.
 * Guarded by a shared secret (`PAYMENTS_WORKER_SECRET`); without it the
 * route only accepts service-role callers. Always returns 200 with counts —
 * failures are retained for retry with backoff, persistent ones surface via
 * `needs_reconciliation` for manager attention.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { composePaymentsPublic } from "@/lib/payments/compose";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = (process.env.PAYMENTS_WORKER_SECRET ?? "").trim();
  if (secret) {
    const provided =
      request.headers.get("x-payments-worker-secret") ??
      request.nextUrl.searchParams.get("secret") ??
      "";
    if (provided !== secret) {
      return NextResponse.json(
        { error: "Forbidden.", processed: 0, failed: 0 },
        { status: 403 }
      );
    }
  }

  const supabase = createServiceClient();
  const { data: due, error } = await supabase.rpc("fn_payment_due_notifications", {
    _limit: 50,
  });
  if (error) {
    // Tables not migrated yet (deploy ordering) — no-op, do not fail the cron.
    if ((error.code ?? "") === "42P01" || /does not exist/i.test(error.message ?? "")) {
      return NextResponse.json({ processed: 0, failed: 0, skipped: "not_migrated" });
    }
    return NextResponse.json({ processed: 0, failed: 0, error: error.message });
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

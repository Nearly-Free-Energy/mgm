import { createServiceClient } from "@/lib/supabase/service";
import { composePaymentsPublic } from "@/lib/payments/compose";
export const dynamic = "force-dynamic";
export default async function PaymentCallback({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const tracking = typeof query.OrderTrackingId === "string" ? query.OrderTrackingId : "";
  const reference = typeof query.OrderMerchantReference === "string" ? query.OrderMerchantReference : "";
  let status = "Payment confirmation is pending. Please contact your operator before trying again.";
  if (tracking && reference) {
    try {
      const supabase = createServiceClient();
      const { data: attempt } = await supabase.from("payment_attempts").select("org_id").eq("merchant_reference", reference).maybeSingle<{ org_id: string }>();
      if (attempt) {
        const composed = await composePaymentsPublic({ supabase, organizationId: attempt.org_id });
        if (composed.ok) {
          try {
            const result = await composed.data.payments.handleNotification({ OrderTrackingId: tracking, OrderMerchantReference: reference });
            if (result.ok && result.data.processed) status = "Your payment status has been checked. Your operator can confirm the receipt and any outstanding balance.";
          } finally { await composed.data.dispose(); }
        }
      }
    } catch { /* Never trust redirect parameters as proof of settlement. */ }
  }
  return <main className="mx-auto max-w-lg p-8"><h1 className="text-2xl font-semibold">Payment confirmation</h1><p className="mt-4">{status}</p></main>;
}

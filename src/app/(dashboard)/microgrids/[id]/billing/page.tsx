import { createClient } from "@/lib/supabase/server";
import type { BillingPeriod } from "@/lib/types/domain";
import { BillingPeriodList } from "@/components/BillingPeriodList";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { requestUserCanAccessMicrogrid } from "@/lib/auth/request-access";

export default async function BillingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Step 1: Fetch periods
  const periodsRead = Promise.resolve(
    supabase
      .from("billing_periods")
      .select("*")
      .eq("microgrid_id", id)
      .order("start_date", { ascending: false })
      .returns<BillingPeriod[]>()
  );

  // Step 2: Fetch line item summaries for those periods
  const lineItemsRead = periodsRead.then(async ({ data: periods, error }) => {
    const periodIds = (periods ?? []).map((p) => p.id);
    if (error || periodIds.length === 0) {
      return {
        data: [] as {
          billing_period_id: string;
          usage_kwh: number;
          total_amount: number;
        }[],
        error: null,
      };
    }
    return await supabase
      .from("billing_line_items")
      .select("billing_period_id, usage_kwh, total_amount")
      .in("billing_period_id", periodIds);
  });

  // None of these reads waits on the access check or the breadcrumb: RLS
  // decides which rows come back and canManage only shapes the UI. A read
  // that canManage had to gate would need to wait for it. The breadcrumb's
  // dependent queries are the longest chain.
  const [
    canManage,
    levels,
    { data: periods, error },
    lineItemsResult,
    microgridResult,
  ] = await Promise.all([
    requestUserCanAccessMicrogrid(supabase, id),
    getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: id,
    }),
    periodsRead,
    lineItemsRead,
    supabase.from("microgrids").select("currency").eq("id", id).single(),
  ]);

  if (error) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading billing periods: {error.message}
      </div>
    );
  }

  // Step 3: Aggregate client-side
  const summaries: Record<string, { totalKwh: number; totalAmount: number }> =
    {};
  for (const item of lineItemsResult.data ?? []) {
    const existing = summaries[item.billing_period_id] ?? {
      totalKwh: 0,
      totalAmount: 0,
    };
    existing.totalKwh += Number(item.usage_kwh);
    existing.totalAmount += Number(item.total_amount);
    summaries[item.billing_period_id] = existing;
  }

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <BillingPeriodList
        microgridId={id}
        periods={periods ?? []}
        summaries={summaries}
        currency={microgridResult.data?.currency ?? "UGX"}
        canManage={canManage}
      />
    </>
  );
}

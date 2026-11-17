"use client";

import { Currency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";

export type BillingLineItemRow = {
  usage_kwh: number | null;
  total_amount: number | null;
  billing_periods: {
    id: string;
    start_date: string;
    end_date: string;
    status: string;
  };
};

/**
 * TenantBillingTable — the tenant's closed bills. A client component because
 * <Kwh> and <Currency> read the microgrid's locale and currency with
 * useLocale(), which a server component cannot call (#194).
 */
export function TenantBillingTable({ items }: { items: BillingLineItemRow[] }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted">
          <tr>
            <th className="px-4 py-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              Period
            </th>
            <th className="px-4 py-2 text-right text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              Usage (kWh)
            </th>
            <th className="px-4 py-2 text-right text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((li, idx) => {
            const bp = li.billing_periods;
            return (
              <tr key={bp?.id ?? idx} className="border-t border-border">
                <td className="px-4 py-3 text-foreground">
                  {bp ? (
                    <span>
                      {bp.start_date} — {bp.end_date}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {li.usage_kwh != null ? (
                    <Kwh value={li.usage_kwh} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {li.total_amount != null ? (
                    <Currency value={li.total_amount} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * periods-model.ts — a microgrid's billing periods, as a `collection` view
 * model (`billing.periods`), with period creation and draft deletion.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here. The columns and empty-state copy are the legacy
 * periods list's (src/components/BillingPeriodList.tsx and the billing page
 * that loads it), so the two show the same thing while both are served.
 */
import type { Fmt, LoadedModel } from "@/lib/gui/surface";

/** Every cell key the view emits. */
export const PERIODS_KEYS = ["period", "status", "energy", "total"] as const;

export const PERIODS_TITLE = "Billing periods";

/** The billing actions the view offers; BILLING_SURFACE (../surface.ts) defines them. */
export const CREATE_PERIOD_ACTION = { id: "billing.create-period", title: "New billing period" } as const;
export const DELETE_PERIOD_ACTION = { id: "billing.delete-period", title: "Delete period" } as const;

export type PeriodRowInput = {
  id: string;
  start_date: string;
  end_date: string;
  status: "draft" | "closed";
  /** Summed over the period's bills; null when it has none. */
  totalKwh: number | null;
  totalAmount: number | null;
};

export type PeriodsModelInput = {
  microgridId: string;
  currency: string;
  /** Newest first, as the loader reads them. */
  periods: readonly PeriodRowInput[];
  fmt: Fmt;
};

type Row = LoadedModel<"collection">["body"]["rows"][number];

export function buildPeriodsModel({ microgridId, currency, periods, fmt }: PeriodsModelInput): LoadedModel<"collection"> {
  // No prefill on create: CreatePeriodBody is refined, so the host cannot
  // check one and would drop it (cleanPrefill in src/lib/gui/host/server/merge.ts).
  // The form opens empty; the legacy page starts it at the previous month.
  const create = { action: CREATE_PERIOD_ACTION.id, params: { microgrid_id: microgridId } };
  const rows: Row[] = periods.map((p) => {
    // As the host labels a billing period (src/lib/gui/host/server/entities.ts).
    const label = `${fmt.date(p.start_date).text} – ${fmt.date(p.end_date).text}`;
    return {
      id: p.id,
      entity: { kind: "billingPeriod", id: p.id, label },
      href: `/microgrids/${microgridId}/billing/${p.id}`,
      cells: {
        // A one-day period shows its one date, as the legacy list does.
        period: fmt.text(p.start_date === p.end_date ? fmt.date(p.start_date).text : label),
        status: fmt.status("billingPeriod", p.status),
        // Energy Values take Wh; a period with no bills shows 0, as the legacy list does.
        energy: fmt.energy((p.totalKwh ?? 0) * 1000, { bare: true }),
        total: p.totalAmount === null ? fmt.empty() : fmt.money(p.totalAmount, currency, { bare: true }),
      },
      // Only a draft can be deleted; the database refuses a closed one anyway.
      actions: p.status === "draft" ? [{ action: DELETE_PERIOD_ACTION.id, params: { periodId: p.id } }] : [],
    };
  });
  return {
    title: PERIODS_TITLE,
    actions: [create],
    body: {
      columns: [
        { key: "period", label: "Period", type: "text", priority: 1 },
        { key: "status", label: "Status", type: "status", priority: 1 },
        { key: "energy", label: "Total kWh", type: "energy", priority: 2 },
        // A bare money column names its currency in the header.
        { key: "total", label: `Total (${currency})`, type: "money", priority: 1, copy: "bare" },
      ],
      rows,
      empty: {
        title: "Create the first billing period",
        text: "A billing period defines the start and end dates you're invoicing for — typically one calendar month. When you close it, MGM snapshots meter readings and generates line items for every tenant.",
        action: create,
      },
    },
  };
}

/**
 * period-review-model.ts — one billing period's bills, as a `collection`
 * view model (`billing.period-review`), with the actions on the period and
 * on each bill.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here. The columns, totals and empty-state copy are the
 * legacy period page's (src/components/BillingTable.tsx), and each row's
 * actions follow its row menu (computeMenuItems in
 * src/components/billing/row-actions-menu.tsx; period-review-menu-parity.test.ts
 * compares the two), so both show the same thing while both are served.
 */
import type { LinkRef, Value } from "@/lib/gui/contract";
import type { ActionLink, Fmt, LoadedModel } from "@/lib/gui/surface";
import { ALLOWED_MANUAL_TRANSITIONS, type ManualPaymentTransition, type PaymentStatus } from "@/lib/payments/state";
import { buildCsvFilename } from "../csv-export";
import { sumMoney } from "../money";

/** Every cell and total key the view emits, besides the per-tier ones under PERIOD_REVIEW_PREFIXES. */
export const PERIOD_REVIEW_KEYS = ["tenant", "begin", "end", "usage", "total", "source", "payment", "entered"] as const;
/** `tier.<n>.kwh` and `tier.<n>.amount`, n counting the period's tariff tiers from 1. */
export const PERIOD_REVIEW_PREFIXES = ["tier."] as const;

/** The billing actions the view offers; BILLING_SURFACE (../surface.ts) defines them. */
export const GENERATE_BILLS_ACTION = { id: "billing.generate-bills", title: "Generate bills" } as const;
export const REGENERATE_BILL_ACTION = { id: "billing.regenerate-bill", title: "Regenerate bill" } as const;
export const RECORD_USAGE_ACTION = { id: "billing.record-usage", title: "Correct usage" } as const;
export const MARK_PAID_ACTION = { id: "billing.mark-paid", title: "Mark as paid" } as const;
export const MARK_UNPAID_ACTION = { id: "billing.mark-unpaid", title: "Mark as unpaid" } as const;
export const MARK_REFUNDED_ACTION = { id: "billing.mark-refunded", title: "Mark as refunded" } as const;
export const MARK_FAILED_ACTION = { id: "billing.mark-failed", title: "Mark as failed" } as const;
export const CANCEL_PAYMENT_LINK_ACTION = { id: "billing.cancel-payment-link", title: "Cancel pending link" } as const;

/** The view's links. */
export const EXPORT_CSV_LINK = "billing.export-csv";
export const VIEW_HISTORY_LINK = "billing.view-history";
export const DOWNLOAD_BILL_LINK = "billing.download-bill";

/**
 * The statuses only a super admin may set by hand: the payment-status
 * route's SUPER_ADMIN_ONLY_STATUSES (src/app/api/billing-line-items/[lineItemId]/payment-status/route.ts);
 * if that list changes, revisit.
 */
export const SUPER_ADMIN_ONLY_STATUSES: readonly PaymentStatus[] = ["failed", "refunded"];

type PaymentActionId =
  | typeof MARK_PAID_ACTION.id
  | typeof MARK_UNPAID_ACTION.id
  | typeof MARK_REFUNDED_ACTION.id
  | typeof MARK_FAILED_ACTION.id
  | typeof CANCEL_PAYMENT_LINK_ACTION.id;

/** The action that makes one manual transition of the payment state machine. */
export function paymentActionFor(t: ManualPaymentTransition): PaymentActionId {
  switch (t.to) {
    case "paid":
      return MARK_PAID_ACTION.id;
    case "refunded":
      return MARK_REFUNDED_ACTION.id;
    case "failed":
      return MARK_FAILED_ACTION.id;
    case "unpaid":
      // Back to unpaid from a pending link cancels the link; from paid it is a correction.
      return t.from === "link_generated" ? CANCEL_PAYMENT_LINK_ACTION.id : MARK_UNPAID_ACTION.id;
    default:
      throw new Error(`no billing action sets payment status ${t.to}`);
  }
}

/** The legacy row menu's order of the payment-status items. */
const MENU_ORDER: readonly PaymentActionId[] = [
  MARK_PAID_ACTION.id,
  MARK_UNPAID_ACTION.id,
  MARK_REFUNDED_ACTION.id,
  CANCEL_PAYMENT_LINK_ACTION.id,
  MARK_FAILED_ACTION.id,
];

/**
 * The payment-status actions a bill in `status` is offered, with the status
 * each sets, in the legacy menu's order: every manual transition out of it
 * (ALLOWED_MANUAL_TRANSITIONS), less those to a super-admin-only status for
 * anyone else, whom the route answers 403.
 */
export function paymentActionsFor(status: PaymentStatus, superAdmin: boolean): { action: PaymentActionId; to: PaymentStatus }[] {
  return ALLOWED_MANUAL_TRANSITIONS.filter((t) => t.from === status && (superAdmin || !SUPER_ADMIN_ONLY_STATUSES.includes(t.to)))
    .map((t) => ({ action: paymentActionFor(t), to: t.to }))
    .sort((a, b) => MENU_ORDER.indexOf(a.action) - MENU_ORDER.indexOf(b.action));
}

export type ReviewBill = {
  id: string;
  tenant_id: string;
  device_id: string | null;
  start_kwh: number | null;
  end_kwh: number | null;
  usage_kwh: number | null;
  tier_breakdown: { label: string; kwh: number; amount: number }[] | null;
  total_amount: number;
  reading_source: "edge" | "manual" | null;
  payment_status: PaymentStatus;
  invoice_number: string | null;
  entered_at: string | null;
  /** The display name of whoever entered a manual reading, or null when it is not visible. */
  entered_by: string | null;
};

export type ReviewTenant = {
  id: string;
  display_name: string;
  /** The tenant's primary meter has an OpenEMS component and edge, so generation can read it. */
  edgeAvailable: boolean;
  /** A primary meter assignment overlaps the period, so the usage route refuses a correction. */
  meterLinkInPeriod: boolean;
};

export type PeriodReviewInput = {
  microgrid: { id: string; name: string; currency: string };
  period: { id: string; start_date: string; end_date: string; status: "draft" | "closed"; timezone: string | null };
  /** The period's pinned tariff's tiers, in order. */
  tiers: readonly { label: string }[];
  /** Every tenant of the microgrid the person can read, in display_name order. */
  tenants: readonly ReviewTenant[];
  bills: readonly ReviewBill[];
  superAdmin: boolean;
  fmt: Fmt;
};

type Row = LoadedModel<"collection">["body"]["rows"][number];
type Column = LoadedModel<"collection">["body"]["columns"][number];

const num = (v: unknown): number => Number(v ?? 0);

/** A period as the host labels it (src/lib/gui/host/server/entities.ts). */
export function periodLabel(fmt: Fmt, start: string, end: string): string {
  return `${fmt.date(start).text} – ${fmt.date(end).text}`;
}

/** The actions one bill is offered, in the legacy row menu's order. */
function rowActions(bill: ReviewBill, tenant: ReviewTenant, i: PeriodReviewInput): ActionLink[] {
  const params = { lineItemId: bill.id };
  const out: ActionLink[] = [];
  // Hidden on a refunded bill: refunding then re-billing reads as data corruption.
  if (bill.payment_status !== "refunded") {
    const regenerate = (label: string, prefill: Record<string, string | number>) =>
      out.push({ action: REGENERATE_BILL_ACTION.id, params, label, prefill });
    // A null reading would fail the input's number check and drop the whole prefill.
    const readings = (o: { start_kwh: number | null; end_kwh?: number | null }) =>
      Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Record<string, number>;
    if (bill.reading_source === "edge") {
      if (tenant.edgeAvailable) regenerate("Regenerate from edge data", { readings: "edge" });
      regenerate("Switch to manual entry", { readings: "manual", ...readings({ start_kwh: bill.start_kwh }) });
    } else if (bill.reading_source === "manual") {
      if (tenant.edgeAvailable) regenerate("Switch back to edge data", { readings: "edge" });
      regenerate("Re-enter manual readings", { readings: "manual", ...readings({ start_kwh: bill.start_kwh, end_kwh: bill.end_kwh }) });
    }
  }
  // Only where the usage route accepts a correction (its checks, in order):
  // a draft, an unmetered bill with no meter assigned in the period, and a
  // starting reading. No prefill: LineItemUsageBody is refined.
  if (i.period.status === "draft" && bill.device_id === null && !tenant.meterLinkInPeriod && bill.start_kwh !== null) {
    out.push({ action: RECORD_USAGE_ACTION.id, params });
  }
  for (const { action, to } of paymentActionsFor(bill.payment_status, i.superAdmin)) {
    out.push({ action, params, prefill: { status: to } });
  }
  return out;
}

export function buildPeriodReviewModel(i: PeriodReviewInput): LoadedModel<"collection"> {
  const { microgrid, period, tiers, fmt } = i;
  const currency = microgrid.currency;
  const label = periodLabel(fmt, period.start_date, period.end_date);
  const historyHref = `/microgrids/${microgrid.id}/billing/${period.id}/history` as const;
  const isDraft = period.status === "draft";

  // No prefill: GenerateBillsBody is refined, so the host cannot check one
  // and would drop it (cleanPrefill in src/lib/gui/host/server/merge.ts).
  const generate: ActionLink = {
    action: GENERATE_BILLS_ACTION.id,
    params: { billingPeriodId: period.id },
    ...(i.bills.length > 0 ? { label: "Refresh readings" } : {}),
  };

  const energy = (kwh: number | null | undefined) => (kwh === null || kwh === undefined ? fmt.empty() : fmt.energy(num(kwh) * 1000, { bare: true }));
  const money = (amount: number | null | undefined) =>
    amount === null || amount === undefined ? fmt.empty() : fmt.money(num(amount), currency, { bare: true });

  const columns: Column[] = [
    { key: "tenant", label: "Tenant", type: "ref", priority: 1 },
    { key: "begin", label: "Begin (kWh)", type: "energy", priority: 3 },
    { key: "end", label: "End (kWh)", type: "energy", priority: 3 },
    { key: "usage", label: "Usage (kWh)", type: "energy", priority: 2 },
    ...tiers.flatMap((tier, n): Column[] => [
      { key: `tier.${n + 1}.kwh`, label: `${tier.label} kWh`, type: "energy", priority: 3 },
      { key: `tier.${n + 1}.amount`, label: `${tier.label} (${currency})`, type: "money", priority: 3, copy: "bare" },
    ]),
    // A bare money column names its currency in the header.
    { key: "total", label: `Total (${currency})`, type: "money", priority: 1, copy: "bare" },
    { key: "source", label: "Source", type: "status", priority: 2 },
    { key: "payment", label: "Payment", type: "status", priority: 1 },
    { key: "entered", label: "Updated by", type: "text", priority: 3 },
  ];

  const billByTenant = new Map(i.bills.map((b) => [b.tenant_id, b]));
  const rows: Row[] = i.tenants.flatMap((tenant): Row[] => {
    const bill = billByTenant.get(tenant.id);
    if (!bill) return [];
    // As the host links a tenant (src/lib/gui/host/server/entities.ts): the tenant's own page.
    const tenantRef = { kind: "tenant", id: tenant.id, label: tenant.display_name, href: `/microgrids/${microgrid.id}/setup/tenants/${tenant.id}` } as const;
    const tierCells = Object.fromEntries(
      tiers.flatMap((_, n) => {
        const part = bill.tier_breakdown?.[n];
        return [
          [`tier.${n + 1}.kwh`, energy(part?.kwh)],
          [`tier.${n + 1}.amount`, money(part?.amount)],
        ];
      }),
    );
    const links: LinkRef[] = [
      {
        id: DOWNLOAD_BILL_LINK,
        label: "Download bill (PDF)",
        icon: "download",
        href: `/api/billing-line-items/${bill.id}/pdf`,
        // The route names the file after the invoice number it allocates on first use; before then, as the legacy menu falls back.
        download: { mime: "application/pdf", filename: bill.invoice_number ? `${bill.invoice_number}.pdf` : `bill-${bill.id}.pdf` },
      },
      { id: VIEW_HISTORY_LINK, label: "View history", href: `${historyHref}?tenant_id=${tenant.id}` },
    ];
    return [
      {
        id: bill.id,
        entity: { kind: "lineItem", id: bill.id, label: tenant.display_name },
        related: [tenantRef],
        cells: {
          tenant: fmt.ref(tenantRef),
          begin: energy(bill.start_kwh),
          end: energy(bill.end_kwh),
          usage: energy(bill.usage_kwh),
          ...tierCells,
          total: money(bill.total_amount),
          source: bill.reading_source === null ? fmt.empty() : fmt.status("billingLineItemReadingSource", bill.reading_source),
          payment: fmt.status("billingLineItemPaymentStatus", bill.payment_status),
          // An absolute time where the legacy page says how long ago: a model has no clock.
          entered:
            bill.reading_source === "manual" && bill.entered_at
              ? fmt.text(`${bill.entered_by ?? "a user"} · ${fmt.datetime(bill.entered_at, period.timezone ?? "UTC").text}`)
              : fmt.empty(),
        },
        actions: rowActions(bill, tenant, i),
        links,
      },
    ];
  });

  // Over every bill, those of tenants the person cannot read included, as the
  // legacy page sums them; a bill with no usage yet counts as 0.
  let totals: Record<string, Value> | undefined;
  if (i.bills.length > 0) {
    const tierKwh = tiers.map(() => 0);
    const tierAmounts = tiers.map((): number[] => []);
    let usage = 0;
    for (const bill of i.bills) {
      usage += num(bill.usage_kwh);
      const breakdown = bill.tier_breakdown ?? [];
      // By index, and only as many tiers as the tariff has.
      for (let n = 0; n < breakdown.length && n < tiers.length; n++) {
        tierKwh[n] += num(breakdown[n].kwh);
        tierAmounts[n].push(num(breakdown[n].amount));
      }
    }
    // Money in minor units, as the periods list sums a period (../money.ts),
    // so the two show the same total.
    totals = {
      usage: fmt.energy(usage * 1000, { bare: true }),
      ...Object.fromEntries(
        tiers.flatMap((_, n) => [
          [`tier.${n + 1}.kwh`, fmt.energy(tierKwh[n] * 1000, { bare: true })],
          [`tier.${n + 1}.amount`, fmt.money(sumMoney(tierAmounts[n], currency), currency, { bare: true })],
        ]),
      ),
      total: fmt.money(
        sumMoney(
          i.bills.map((b) => num(b.total_amount)),
          currency,
        ),
        currency,
        { bare: true },
      ),
    };
  }

  const links: LinkRef[] = [{ id: VIEW_HISTORY_LINK, label: "View history", href: historyHref }];
  // Left out with no bills, where the legacy page shows it disabled.
  if (i.bills.length > 0) {
    links.push({
      id: EXPORT_CSV_LINK,
      label: "Export CSV",
      icon: "download",
      href: `/api/billing-periods/${period.id}/export-csv`,
      download: {
        mime: "text/csv",
        filename: buildCsvFilename({ microgridName: microgrid.name, startDate: period.start_date, endDate: period.end_date }),
      },
    });
  }

  const empty: LoadedModel<"collection">["body"]["empty"] =
    i.tenants.length === 0
      ? { title: "No tenants configured for this microgrid." }
      : isDraft
        ? { title: "No billing data yet.", text: "Generate bills to fetch meter readings and calculate costs.", action: generate }
        : { title: "No billing data yet." };

  return {
    // A one-day period shows its one date, as the legacy list does.
    title: period.start_date === period.end_date ? fmt.date(period.start_date).text : label,
    ...(period.timezone ? { subtitle: period.timezone } : {}),
    entity: { kind: "billingPeriod", id: period.id, label },
    // Bills are generated on a draft; a closed period's are regenerated one at a time.
    actions: isDraft ? [generate] : [],
    links,
    body: {
      columns,
      rows,
      ...(totals ? { totals } : {}),
      empty,
    },
  };
}

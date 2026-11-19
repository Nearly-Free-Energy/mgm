/**
 * `billing.period-review@1` models as Gridtop receives them, written by hand:
 * a GUI's tests import no capability (gui-boundary.test.ts), so the view's
 * own examples are drawn by src/lib/gui/__tests__/view-examples.test.tsx.
 * They follow buildPeriodReviewModel (src/lib/billing/surface): two tariff
 * tiers in UGX, the copy figures as the CSV writes them.
 */
import type { ActionRef, Column, Json, LinkRef, ModelOf, RowOf, Value } from "@/lib/gui/contract";

export const MG = "00000000-0000-4000-8000-0000000000a1";
export const PERIOD = "00000000-0000-4000-8000-0000000000b2";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const BILLING_OFF = "Billing is disabled for this organization. Enable it in Settings → Plugins.";
export const HISTORY: LinkRef = { id: "billing.view-history", label: "View history", href: `/microgrids/${MG}/billing/${PERIOD}/history` };
export const EXPORT: LinkRef = {
  id: "billing.export-csv",
  label: "Export CSV",
  icon: "download",
  href: `/api/billing-periods/${PERIOD}/export-csv`,
  download: { mime: "text/csv", filename: "example-site-2026-11.csv" },
};

const energy = (v: number, text: string): Value => ({ t: "energy", v, unit: "kWh", text });
const money = (v: number, text: string): Value => ({ t: "money", v, currency: "UGX", text });
export const EMPTY: Value = { t: "empty", text: "—" };
const status = (v: string, tone: "success" | "warning" | "neutral" | "info", text: string): Value => ({ t: "status", v, tone, text });

export const COLUMNS: Column[] = [
  { key: "tenant", label: "Tenant", type: "ref", priority: 1 },
  { key: "begin", label: "Begin (kWh)", type: "energy", priority: 3, copy: "bare" },
  { key: "end", label: "End (kWh)", type: "energy", priority: 3, copy: "bare" },
  { key: "usage", label: "Usage (kWh)", type: "energy", priority: 2, copy: "bare" },
  { key: "tier.1.kwh", label: "Lifeline kWh", type: "energy", priority: 3, copy: "bare" },
  { key: "tier.1.amount", label: "Lifeline (UGX)", type: "money", priority: 3, copy: "bare" },
  { key: "tier.2.kwh", label: "Standard kWh", type: "energy", priority: 3, copy: "bare" },
  { key: "tier.2.amount", label: "Standard (UGX)", type: "money", priority: 3, copy: "bare" },
  { key: "total", label: "Total (UGX)", type: "money", priority: 1, copy: "bare" },
  { key: "source", label: "Source", type: "status", priority: 2 },
  { key: "payment", label: "Payment", type: "status", priority: 1 },
  { key: "entered", label: "Updated by", type: "text", priority: 3 },
];
export const COPY_KEYS = COLUMNS.filter((c) => c.copy === "bare").map((c) => c.key);

export const TENANTS = ["Aisha M.", "Brian K.", "Carol N."] as const;
const tenantId = (i: number) => id(0xc1 + i);
export const tenantHref = (i: number) => `/microgrids/${MG}/setup/tenants/${tenantId(i)}` as const;
export const billId = (i: number) => id(0xd1 + i);

type Bill = { cells: Record<string, Value>; figures: (string | null)[] };

/** Three bills: an edge bill, a manual one with no usage and no second tier, and a paid one. */
const BILLS: Bill[] = [
  {
    cells: {
      begin: energy(1200, "1,200.0"),
      end: energy(1284.512, "1,284.5"),
      usage: energy(84.512, "84.5"),
      "tier.1.kwh": energy(15, "15.0"),
      "tier.1.amount": money(3750, "3,750"),
      "tier.2.kwh": energy(69.512, "69.5"),
      "tier.2.amount": money(52125, "52,125"),
      total: money(55875, "55,875"),
      source: status("edge", "info", "Edge"),
      payment: status("unpaid", "warning", "Unpaid"),
      entered: EMPTY,
    },
    figures: ["1200", "1284.512", "84.512", "15", "3750", "69.512", "52125", "55875"],
  },
  {
    cells: {
      begin: energy(310, "310.0"),
      end: EMPTY,
      usage: EMPTY,
      "tier.1.kwh": energy(15, "15.0"),
      "tier.1.amount": money(3751, "3,751"),
      "tier.2.kwh": EMPTY,
      "tier.2.amount": EMPTY,
      total: money(3751, "3,751"),
      source: status("manual", "neutral", "Manual"),
      payment: status("paid", "success", "Paid"),
      entered: { t: "text", text: "Okello Daniel · 30 Nov 2026, 18:20" },
    },
    figures: ["310", null, null, "15", "3751", null, null, "3751"],
  },
  {
    cells: {
      begin: energy(500, "500.0"),
      end: energy(542, "542.0"),
      usage: energy(42, "42.0"),
      "tier.1.kwh": energy(15, "15.0"),
      "tier.1.amount": money(3750, "3,750"),
      "tier.2.kwh": energy(27, "27.0"),
      "tier.2.amount": money(20250, "20,250"),
      total: money(24000, "24,000"),
      source: status("edge", "info", "Edge"),
      payment: status("paid", "success", "Paid"),
      entered: EMPTY,
    },
    figures: ["500", "542", "42", "15", "3750", "27", "20250", "24000"],
  },
];

export const TOTALS: Record<string, Value> = {
  usage: energy(126.512, "126.5"),
  "tier.1.kwh": energy(45, "45.0"),
  "tier.1.amount": money(11251, "11,251"),
  "tier.2.kwh": energy(96.512, "96.5"),
  "tier.2.amount": money(72375, "72,375"),
  total: money(83626, "83,626"),
};
export const TOTAL_FIGURES = [null, null, "126.512", "45", "11251", "96.512", "72375", "83626"];

const ref = (action: ActionRef["action"], i: number, label: string, o: Partial<ActionRef> = {}): ActionRef => ({
  action,
  params: { lineItemId: billId(i) },
  label,
  enabled: true,
  ...o,
});

export const MARK_PAID = (i: number) => ref("billing.mark-paid", i, "Mark as paid", { prefill: { status: "paid" } });
export const REGENERATE = (i: number) => ref("billing.regenerate-bill", i, "Regenerate from edge data", { prefill: { readings: "edge" } });
export const pdf = (i: number): LinkRef => ({
  id: "billing.download-bill",
  label: "Download bill (PDF)",
  icon: "download",
  href: `/api/billing-line-items/${billId(i)}/pdf`,
  download: { mime: "application/pdf", filename: `bill-${billId(i)}.pdf` },
});

function row(i: number, actions: ActionRef[]): RowOf<ActionRef> {
  const tenant = { kind: "tenant" as const, id: tenantId(i), label: TENANTS[i], href: tenantHref(i) };
  return {
    id: billId(i),
    entity: { kind: "lineItem", id: billId(i), label: TENANTS[i] },
    related: [tenant],
    cells: { tenant: { t: "ref", ref: tenant, text: TENANTS[i] }, ...BILLS[i].cells },
    actions,
    links: [pdf(i), { id: "billing.view-history", label: "View history", href: `${HISTORY.href}?tenant_id=${tenantId(i)}` }],
  };
}

export const GENERATE: ActionRef = { action: "billing.generate-bills", params: { billingPeriodId: PERIOD }, label: "Generate bills", enabled: true };
export const REFRESH: ActionRef = { ...GENERATE, label: "Refresh readings" };

type Ext = { columns: string[]; rows: { id: string; figures: (string | null)[] }[]; totals: (string | null)[] };

function model(o: { rows: RowOf<ActionRef>[]; totals?: Record<string, Value>; ext: Ext } & Omit<Partial<ModelOf<"collection">>, "ext">): ModelOf<"collection"> {
  const { rows, totals, ext, ...rest } = o;
  return {
    type: "view",
    view: "billing.period-review",
    kind: "collection",
    title: "1 Nov 2026 – 30 Nov 2026",
    subtitle: "Africa/Kampala",
    org: "00000000-0000-4000-8000-0000000000a0",
    entity: { kind: "billingPeriod", id: PERIOD, label: "1 Nov 2026 – 30 Nov 2026" },
    trail: [{ label: "Billing", href: `/microgrids/${MG}/billing` }],
    actions: [REFRESH],
    links: [HISTORY, EXPORT],
    attached: [],
    live: { refreshSeconds: 30, staleAfterSeconds: 120 },
    body: {
      columns: COLUMNS,
      rows,
      ...(totals ? { totals } : {}),
      empty: { title: "No billing data yet.", text: "Generate bills to fetch meter readings and calculate costs.", action: GENERATE },
    },
    ext: { schema: "billing.period-review@1", data: ext as unknown as Json },
    ...rest,
  };
}

const extOf = (n: number[]): Ext => ({ columns: COPY_KEYS, rows: n.map((i) => ({ id: billId(i), figures: BILLS[i].figures })), totals: TOTAL_FIGURES });

/** A draft with three bills, seen by an organization manager. */
export const draftModel = (o: Omit<Partial<ModelOf<"collection">>, "ext"> = {}) =>
  model({ rows: [row(0, [REGENERATE(0), MARK_PAID(0)]), row(1, [MARK_PAID(1)]), row(2, [])], totals: TOTALS, ext: extOf([0, 1, 2]), ...o });

/** A closed period: no Generate. */
export const closedModel = () => model({ rows: [row(2, [])], totals: TOTALS, ext: { ...extOf([2]) }, actions: [] });

/** A draft with tenants and no bills: the empty state offers Generate, as the toolbar would. */
export const noBillsModel = () =>
  model({ rows: [], ext: { columns: COPY_KEYS, rows: [], totals: [] }, actions: [GENERATE], links: [HISTORY] });

/** A microgrid with no tenants. */
export const noTenantsModel = () =>
  model({
    rows: [],
    ext: { columns: COPY_KEYS, rows: [], totals: [] },
    actions: [GENERATE],
    links: [HISTORY],
    body: { columns: COLUMNS, rows: [], empty: { title: "No tenants configured for this microgrid." } },
  });

const off = (r: ActionRef): ActionRef => ({ ...r, enabled: false, reason: BILLING_OFF });

/** The draft while billing is off: every action disabled with the gate's reason, and its notice. */
export const billingOffModel = () => {
  const m = draftModel();
  return {
    ...m,
    actions: m.actions.map(off),
    notice: { tone: "warning" as const, text: BILLING_OFF },
    body: { ...m.body, rows: m.body.rows.map((r) => ({ ...r, actions: r.actions.map(off) })) },
  };
};

/** The draft with its ext data replaced by `patch` over the well-formed one. */
export const withFigures = (patch: Partial<Ext> | Json): ModelOf<"collection"> => {
  const m = draftModel();
  const data = patch !== null && typeof patch === "object" && !Array.isArray(patch) ? { ...(m.ext!.data as object), ...patch } : patch;
  return { ...m, ext: { schema: "billing.period-review@1", data: data as Json } };
};

/** The draft with its ext named `schema`. */
export const versioned = (schema: `${string}.${string}@${number}`): ModelOf<"collection"> => ({ ...draftModel(), ext: { ...draftModel().ext!, schema } });

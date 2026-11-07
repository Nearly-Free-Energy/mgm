/**
 * A billing contribution, written against the GUI contract for tests only.
 * Nothing registers it. Its loaders and its prepare step answer 503, and its
 * body schemas stand in for the routes' own. Its paths need not be pages MGM
 * serves (the close checklist is not one), so a test that checks ownership or
 * release gives it a catalog of its own. All data is synthetic.
 */
import { z } from "zod";
import type { ActionRef, ModelOf } from "@/lib/gui/contract";
import type { Contribution, Loaded } from "@/lib/gui/surface";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MICROGRID = "00000000-0000-4000-8000-0000000000b1";
const PERIOD = "00000000-0000-4000-8000-0000000000c1";
const HOUSEHOLD = "00000000-0000-4000-8000-0000000000d1";

const CreatePeriodBody = z.strictObject({
  microgrid_id: z.uuid(),
  start_date: z.iso.date(),
  end_date: z.iso.date(),
});
const GenerateBody = z.strictObject({ billingPeriodId: z.uuid() });
const CloseBody = z.strictObject({ confirmed: z.boolean().optional() });
const PeriodReviewExt = z.strictObject({
  tariffVersion: z.number().int(),
  preflight: z.strictObject({ readings: z.number().int(), missing: z.number().int() }),
});

async function unavailable(): Promise<Loaded<never>> {
  return { ok: false, status: 503, message: "fixture" };
}

const trail = [
  { label: "Demo organization", href: `/organizations/${ORG}` },
  { label: "Demo microgrid", href: `/microgrids/${MICROGRID}/operations` },
] satisfies ModelOf<"collection">["trail"];
const microgrid = { kind: "microgrid", id: MICROGRID, label: "Demo microgrid" } as const;
const period = { kind: "billingPeriod", id: PERIOD, label: "1–31 October 2026" } as const;
const createPeriod: ActionRef = {
  action: "billing.create-period",
  params: { microgrid_id: MICROGRID },
  label: "New billing period",
  enabled: true,
};
const closePeriod: ActionRef = {
  action: "billing.close-period",
  params: { periodId: PERIOD },
  label: "Close period",
  enabled: false,
  reason: "Review the bills first",
  tone: "danger",
};

const periodsExample: ModelOf<"collection"> = {
  type: "view",
  view: "billing.periods",
  kind: "collection",
  title: "Billing",
  org: ORG,
  entity: microgrid,
  trail,
  actions: [createPeriod],
  links: [],
  attached: [],
  body: {
    columns: [
      { key: "period", label: "Period", type: "text", priority: 1 },
      { key: "status", label: "Status", type: "status", priority: 1 },
      { key: "bills", label: "Bills", type: "number", priority: 2 },
      { key: "energy", label: "Energy (kWh)", type: "energy", priority: 2 },
      { key: "total", label: "Total (UGX)", type: "money", priority: 1, copy: "bare" },
    ],
    rows: [
      {
        id: PERIOD,
        entity: period,
        href: `/microgrids/${MICROGRID}/billing/${PERIOD}`,
        cells: {
          period: { t: "text", text: "1–31 October 2026" },
          status: { t: "status", v: "draft", tone: "warning", text: "Draft" },
          bills: { t: "number", v: 12, text: "12" },
          energy: { t: "energy", v: 1840.5, unit: "kWh", text: "1,840.5" },
          total: { t: "money", v: 4216800, currency: "UGX", text: "4,216,800" },
        },
        actions: [],
      },
    ],
    filters: [
      { label: "All", href: `/microgrids/${MICROGRID}/billing`, current: true },
      { label: "Draft", href: `/microgrids/${MICROGRID}/billing?status=draft`, count: 1, current: false },
    ],
    empty: { title: "No billing periods yet", action: createPeriod },
  },
};

const reviewExample: ModelOf<"collection"> = {
  type: "view",
  view: "billing.period-review",
  kind: "collection",
  title: "October 2026",
  org: ORG,
  entity: period,
  trail,
  actions: [closePeriod],
  links: [],
  attached: [],
  live: { refreshSeconds: 30, staleAfterSeconds: 120 },
  ext: { schema: "billing.period-review@1", data: { tariffVersion: 1, preflight: { readings: 12, missing: 0 } } },
  body: {
    columns: [
      { key: "household", label: "Household", type: "ref", priority: 1 },
      { key: "tier.1", label: "Tier 1 (kWh)", type: "energy", priority: 2 },
      { key: "total", label: "Total (UGX)", type: "money", priority: 1, copy: "bare" },
      { key: "payment", label: "Payment", type: "status", priority: 2 },
    ],
    rows: [
      {
        id: HOUSEHOLD,
        entity: { kind: "household", id: HOUSEHOLD, label: "House 1" },
        cells: {
          household: { t: "ref", ref: { kind: "household", id: HOUSEHOLD, label: "House 1" }, text: "House 1" },
          "tier.1": { t: "energy", v: 153.4, unit: "kWh", text: "153.4" },
          total: { t: "money", v: 351400, currency: "UGX", text: "351,400" },
          payment: { t: "status", v: "pending", tone: "neutral", text: "Pending" },
        },
        actions: [],
      },
    ],
    totals: { total: { t: "money", v: 351400, currency: "UGX", text: "351,400" } },
    empty: { title: "No bills in this period" },
  },
};

const checklistExample: ModelOf<"flow"> = {
  type: "view",
  view: "billing.close-checklist",
  kind: "flow",
  title: "Close October 2026",
  org: ORG,
  entity: period,
  trail,
  actions: [],
  links: [],
  attached: [],
  body: {
    steps: [
      { id: "readings", title: "Readings in", state: "done" },
      { id: "generate", title: "Bills generated", state: "done" },
      { id: "review", title: "Bills reviewed", state: "current", href: `/microgrids/${MICROGRID}/billing/${PERIOD}` },
      { id: "close", title: "Period closed", state: "todo", action: closePeriod },
    ],
  },
};

export const BILLING_SURFACE: Contribution = {
  plugin: "billing",
  nav: [
    { id: "billing.nav", view: "billing.periods", title: "Billing", icon: "billing", group: "money", order: 10 },
    {
      id: "billing.tariff",
      href: "/microgrids/[id]/setup/rates",
      needs: ["microgrid"],
      legacy: true,
      title: "Tariff",
      icon: "tariff",
      group: "configure",
      order: 10,
    },
  ],
  views: [
    {
      id: "billing.periods",
      kind: "collection",
      path: "/microgrids/[id]/billing",
      params: { id: "microgrid" },
      entity: "id",
      query: ["status"],
      attach: { to: "microgrid", order: 20, hint: "tab" },
      cost: "db",
      agent: "read",
      declares: { keys: ["period", "status", "bills", "energy", "total"] },
      examples: [periodsExample],
      load: unavailable,
    },
    {
      id: "billing.period-review",
      kind: "collection",
      path: "/microgrids/[id]/billing/[periodId]",
      params: { id: "microgrid", periodId: "billingPeriod" },
      entity: "periodId",
      cost: "db",
      agent: "read",
      live: { refreshSeconds: 30, staleAfterSeconds: 120 },
      declares: { keys: ["household", "total", "payment"], prefixes: ["tier."] },
      ext: { schema: "billing.period-review@1", zod: PeriodReviewExt },
      examples: [reviewExample],
      load: unavailable,
    },
    {
      id: "billing.close-checklist",
      kind: "flow",
      path: "/microgrids/[id]/billing/[periodId]/close",
      params: { id: "microgrid", periodId: "billingPeriod" },
      entity: "periodId",
      attach: { to: { view: "billing.period-review" }, order: 10, hint: "section" },
      cost: "db",
      declares: { keys: ["readings", "generate", "review", "close"] },
      examples: [checklistExample],
      load: unavailable,
    },
  ],
  actions: [
    {
      id: "billing.create-period",
      title: "New billing period",
      target: "microgrid",
      input: CreatePeriodBody,
      inputVersion: 1,
      method: "POST",
      path: "/api/billing-periods",
      bind: { body: { microgrid_id: "microgrid" } },
      risk: "money",
      humanOnly: false,
      confirm: "confirm",
    },
    {
      id: "billing.generate-bills",
      title: "Generate bills",
      target: "billingPeriod",
      input: GenerateBody,
      inputVersion: 1,
      method: "POST",
      path: "/api/billing/generate",
      bind: { body: { billingPeriodId: "billingPeriod" } },
      risk: "money",
      humanOnly: false,
      confirm: "confirm",
    },
    {
      id: "billing.close-period",
      title: "Close period",
      target: "billingPeriod",
      input: CloseBody,
      inputVersion: 1,
      method: "POST",
      path: "/api/billing-periods/[periodId]/close",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "money",
      humanOnly: true,
      confirm: "ceremony",
      prepare: unavailable,
    },
  ],
  signals: [{ id: "billing.period-due", load: async () => [] }],
};

/**
 * The `billing.period-review` model: the legacy period page's table as a
 * collection, one row per bill of a readable tenant, totals over every bill,
 * the period's links and its Generate from meter data, and each bill's
 * actions and links; and generateReadiness, what Generate would do.
 */
import { describe, expect, it } from "vitest";
import type { LinkRef } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { ViewDef } from "@/lib/gui/surface";
import { ALLOWED_MANUAL_TRANSITIONS, type PaymentStatus } from "@/lib/payments/state";
import { sumMoney } from "../../money";
import { BILLING_SURFACE } from "../../surface";
import { PERIOD_REVIEW_EXAMPLES, PERIOD_REVIEW_LOADED_EXAMPLES } from "../period-review-examples";
import {
  buildPeriodReviewModel,
  CANCEL_PAYMENT_LINK_ACTION,
  GENERATE_FROM_METERS_ACTION,
  generateReadiness,
  MARK_FAILED_ACTION,
  MARK_PAID_ACTION,
  MARK_REFUNDED_ACTION,
  MARK_UNPAID_ACTION,
  paymentActionFor,
  paymentActionsFor,
  PERIOD_REVIEW_KEYS,
  RECORD_USAGE_ACTION,
  REFRESH_FROM_METERS_LABEL,
  REGENERATE_BILL_ACTION,
  type PeriodReviewInput,
  type ReviewBill,
  type ReviewTenant,
} from "../period-review-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7500000-0000-4000-8002-0000000000a1";
const PERIOD = "e7500000-0000-4000-8003-0000000000b1";
const view = BILLING_SURFACE.views!.find((v) => v.id === "billing.period-review") as ViewDef;

const tenant = (n: number, name: string, o: Partial<ReviewTenant> = {}): ReviewTenant => ({
  id: `e7500000-0000-4000-8004-00000000000${n}`,
  display_name: name,
  edgeAvailable: true,
  meterLinkInPeriod: true,
  ...o,
});
const A = tenant(1, "Akello");
const B = tenant(2, "Byaruhanga");
const C = tenant(3, "Kato");

const bill = (n: number, t: ReviewTenant, o: Partial<ReviewBill> = {}): ReviewBill => ({
  id: `e7500000-0000-4000-8005-00000000000${n}`,
  tenant_id: t.id,
  device_id: "e7500000-0000-4000-8006-000000000001",
  start_kwh: 100,
  end_kwh: 150.25,
  usage_kwh: 50.25,
  tier_breakdown: [
    { label: "Lifeline", kwh: 15, amount: 3750 },
    { label: "Standard", kwh: 35.25, amount: 26437.5 },
  ],
  total_amount: 30187.5,
  reading_source: "edge",
  payment_status: "unpaid",
  invoice_number: null,
  entered_at: null,
  entered_by: null,
  ...o,
});

const input = (o: Partial<PeriodReviewInput> = {}): PeriodReviewInput => ({
  microgrid: { id: MG, name: "North Site", currency: "UGX" },
  period: { id: PERIOD, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala" },
  tiers: [{ label: "Lifeline" }, { label: "Standard" }],
  tenants: [A, B, C],
  bills: [bill(1, A)],
  superAdmin: false,
  fmt,
  ...o,
});
const build = (o: Partial<PeriodReviewInput> = {}) => buildPeriodReviewModel(input(o));
const actionsOf = (row: { actions: { action: string; label?: string }[] }) => row.actions.map((a) => [a.action, a.label]);

describe("buildPeriodReviewModel: columns", () => {
  it.each([
    [0, []],
    [1, [["tier.1.kwh", "Lifeline kWh", "energy"], ["tier.1.amount", "Lifeline (UGX)", "money"]]],
    [
      2,
      [
        ["tier.1.kwh", "Lifeline kWh", "energy"],
        ["tier.1.amount", "Lifeline (UGX)", "money"],
        ["tier.2.kwh", "Standard kWh", "energy"],
        ["tier.2.amount", "Standard (UGX)", "money"],
      ],
    ],
  ])("emits the legacy table's columns with %i tariff tiers", (n, tierColumns) => {
    const tiers = [{ label: "Lifeline" }, { label: "Standard" }].slice(0, n);
    const model = build({ tiers });
    expect(model.body.columns.map((c) => [c.key, c.label, c.type])).toEqual([
      ["tenant", "Tenant", "ref"],
      ["begin", "Begin (kWh)", "energy"],
      ["end", "End (kWh)", "energy"],
      ["usage", "Usage (kWh)", "energy"],
      ...tierColumns,
      ["total", "Total (UGX)", "money"],
      ["source", "Source", "status"],
      ["payment", "Payment", "status"],
      ["entered", "Updated by", "text"],
    ]);
    // Bare money columns name their currency in the header; every figure a person copies is bare.
    for (const c of model.body.columns) if (c.type === "money" || c.type === "energy") expect(c.copy).toBe("bare");
    for (const c of model.body.columns) if (c.type !== "money" && c.type !== "energy") expect(c).not.toHaveProperty("copy");
  });

  it("emits only declared keys, so the host's strict parse passes", () => {
    for (const model of PERIOD_REVIEW_LOADED_EXAMPLES) {
      expect(strictParseModel(view, model)).toMatchObject({ ok: true });
      for (const key of Object.keys(model.body.rows[0]?.cells ?? {})) {
        expect((PERIOD_REVIEW_KEYS as readonly string[]).includes(key) || key.startsWith("tier.")).toBe(true);
      }
    }
  });

  it("refuses an ext of another version", () => {
    const model = PERIOD_REVIEW_LOADED_EXAMPLES[0];
    expect(strictParseModel(view, { ...model, ext: { ...model.ext!, schema: "billing.period-review@2" } })).toMatchObject({ ok: false });
  });

  it("names the microgrid's currency in the headers", () => {
    const model = build({ microgrid: { id: MG, name: "North", currency: "KES" } });
    expect(model.body.columns.find((c) => c.key === "total")!.label).toBe("Total (KES)");
    expect(model.body.columns.find((c) => c.key === "tier.2.amount")!.label).toBe("Standard (KES)");
  });
});

describe("buildPeriodReviewModel: rows", () => {
  it("shows one row per tenant with a bill, in the tenants' order, identified by the bill", () => {
    const model = build({ bills: [bill(3, C), bill(1, A)] });
    expect(model.body.rows.map((r) => r.id)).toEqual([bill(1, A).id, bill(3, C).id]);
    const [row] = model.body.rows;
    const tenantRef = { kind: "tenant", id: A.id, label: "Akello", href: `/microgrids/${MG}/setup/tenants/${A.id}` };
    expect(row.entity).toEqual({ kind: "lineItem", id: bill(1, A).id, label: "Akello" });
    expect(row.related).toEqual([tenantRef]);
    expect(row.cells.tenant).toEqual({ t: "ref", ref: tenantRef, text: "Akello" });
    expect(row).not.toHaveProperty("href");
  });

  it("formats readings, tiers by index, bare money and statuses", () => {
    const [row] = build().body.rows;
    expect(row.cells.begin).toMatchObject({ t: "energy", v: 100, unit: "kWh", text: "100.000" });
    expect(row.cells.usage).toMatchObject({ t: "energy", v: 50.25 });
    expect(row.cells["tier.2.kwh"]).toMatchObject({ t: "energy", v: 35.25 });
    expect(row.cells["tier.1.amount"]).toEqual({ t: "money", v: 3750, currency: "UGX", text: "3,750" });
    expect(row.cells.total).toMatchObject({ t: "money", currency: "UGX", text: "30,188" });
    expect(row.cells.source).toMatchObject({ t: "status", v: "edge" });
    expect(row.cells.payment).toMatchObject({ t: "status", v: "unpaid" });
    expect(row.cells.entered.t).toBe("empty");
  });

  it("shows a missing reading, tier or source as empty", () => {
    const [row] = build({
      tiers: [{ label: "Lifeline" }, { label: "Standard" }, { label: "Peak" }],
      bills: [bill(1, A, { start_kwh: null, usage_kwh: null, reading_source: null, tier_breakdown: null })],
    }).body.rows;
    for (const key of ["begin", "usage", "source", "tier.1.kwh", "tier.3.amount"]) expect(row.cells[key].t, key).toBe("empty");
  });

  it("says who entered a manual reading and when, or 'a user' when the name is not visible", () => {
    const at = "2026-10-31T12:00:00Z";
    const [named, unnamed, edge] = build({
      bills: [
        bill(1, A, { reading_source: "manual", entered_at: at, entered_by: "Okello Daniel" }),
        bill(2, B, { reading_source: "manual", entered_at: at, entered_by: null }),
        bill(3, C, { reading_source: "edge", entered_at: at, entered_by: "Okello Daniel" }),
      ],
    }).body.rows;
    const when = fmt.datetime(at, "Africa/Kampala").text;
    expect(named.cells.entered).toEqual({ t: "text", text: `Okello Daniel · ${when}` });
    expect(unnamed.cells.entered).toEqual({ t: "text", text: `a user · ${when}` });
    expect(edge.cells.entered.t).toBe("empty");
  });

  it("links each bill's PDF and its history filtered to the tenant", () => {
    const [numbered, unnumbered] = build({ bills: [bill(1, A, { invoice_number: "NS-2026-0007" }), bill(2, B)] }).body.rows;
    expect(numbered.links).toEqual<LinkRef[]>([
      {
        id: "billing.download-bill",
        label: "Download bill (PDF)",
        icon: "download",
        href: `/api/billing-line-items/${bill(1, A).id}/pdf`,
        download: { mime: "application/pdf", filename: "NS-2026-0007.pdf" },
      },
      { id: "billing.view-history", label: "View history", href: `/microgrids/${MG}/billing/${PERIOD}/history?tenant_id=${A.id}` },
    ]);
    // As the legacy menu names a bill with no invoice number yet.
    expect(unnumbered.links![0].download).toEqual({ mime: "application/pdf", filename: `bill-${bill(2, B).id}.pdf` });
  });
});

describe("buildPeriodReviewModel: totals", () => {
  it("sums every bill, a tenant the person cannot read included, with no usage as 0", () => {
    const hidden = tenant(9, "Hidden");
    const model = build({
      tenants: [A, B],
      bills: [
        bill(1, A),
        bill(2, B, { usage_kwh: null, tier_breakdown: [{ label: "Lifeline", kwh: 0, amount: 0 }], total_amount: 0 }),
        bill(3, hidden, {
          usage_kwh: 10,
          total_amount: 2500,
          // A breakdown longer than the tariff: the extra tier is left out.
          tier_breakdown: [
            { label: "Lifeline", kwh: 10, amount: 2500 },
            { label: "Standard", kwh: 0, amount: 0 },
            { label: "Old", kwh: 99, amount: 99 },
          ],
        }),
      ],
    });
    expect(model.body.rows).toHaveLength(2);
    expect(model.body.totals).toEqual({
      usage: fmt.energy(60250, { bare: true }),
      "tier.1.kwh": fmt.energy(25000, { bare: true }),
      "tier.1.amount": fmt.money(6250, "UGX", { bare: true }),
      "tier.2.kwh": fmt.energy(35250, { bare: true }),
      "tier.2.amount": fmt.money(26437.5, "UGX", { bare: true }),
      total: fmt.money(32687.5, "UGX", { bare: true }),
    });
  });

  it("adds money in the currency's minor units, as the periods list does, so the total is the rows' sum", () => {
    // Each row shows 1,251 (UGX has no minor unit); adding the floats would give 2,501.
    const half = { total_amount: 1250.5, tier_breakdown: [{ label: "Lifeline", kwh: 5, amount: 1250.5 }] };
    const model = build({ tenants: [A, B], bills: [bill(1, A, half), bill(2, B, half)] });
    expect(model.body.rows.map((r) => r.cells.total)).toEqual([fmt.money(1251, "UGX", { bare: true }), fmt.money(1251, "UGX", { bare: true })]);
    expect(model.body.totals?.total).toEqual(fmt.money(2502, "UGX", { bare: true }));
    expect(model.body.totals?.["tier.1.amount"]).toEqual(fmt.money(2502, "UGX", { bare: true }));
    expect(model.body.totals?.total).toEqual(fmt.money(sumMoney([1250.5, 1250.5], "UGX"), "UGX", { bare: true }));

    // In a currency with cents too: each row shows 0.01, so the total is
    // 0.02; adding the floats would give 0.01. (0.1 + 0.2 would not do here:
    // fmt.money rounds 0.30000000000000004 to the same 0.30.)
    const usd = build({
      microgrid: { id: MG, name: "North", currency: "USD" },
      tenants: [A, B],
      bills: [
        bill(1, A, { total_amount: 0.005, tier_breakdown: [{ label: "Lifeline", kwh: 1, amount: 0.005 }] }),
        bill(2, B, { total_amount: 0.005, tier_breakdown: [{ label: "Lifeline", kwh: 1, amount: 0.005 }] }),
      ],
    });
    expect(usd.body.rows.map((r) => r.cells.total)).toEqual([fmt.money(0.01, "USD", { bare: true }), fmt.money(0.01, "USD", { bare: true })]);
    expect(usd.body.totals?.total).toEqual(fmt.money(0.02, "USD", { bare: true }));
    expect(usd.body.totals?.["tier.1.amount"]).toEqual(fmt.money(0.02, "USD", { bare: true }));
    expect(fmt.money(0.005 + 0.005, "USD", { bare: true })).not.toEqual(fmt.money(0.02, "USD", { bare: true }));
  });

  it("has no totals with no bills", () => {
    expect(build({ bills: [] }).body).not.toHaveProperty("totals");
  });
});

describe("buildPeriodReviewModel: the copy figures (ext)", () => {
  type Figures = { columns: string[]; rows: { id: string; figures: (string | null)[] }[]; totals: (string | null)[] };
  const extOf = (model: ReturnType<typeof build>) => {
    expect(model.ext?.schema).toBe("billing.period-review@1");
    return model.ext!.data as Figures;
  };
  const figure = (model: ReturnType<typeof build>, row: number, key: string) => {
    const ext = extOf(model);
    return ext.rows[row].figures[ext.columns.indexOf(key)];
  };

  it.each([0, 1, 2])("lists the copy columns in table order with %i tariff tiers", (n) => {
    const model = build({ tiers: [{ label: "Lifeline" }, { label: "Standard" }].slice(0, n) });
    expect(extOf(model).columns).toEqual(model.body.columns.filter((c) => c.copy === "bare").map((c) => c.key));
    expect(extOf(model).columns).toEqual([
      "begin",
      "end",
      "usage",
      ...Array.from({ length: n }, (_, i) => [`tier.${i + 1}.kwh`, `tier.${i + 1}.amount`]).flat(),
      "total",
    ]);
  });

  it("writes each figure plainly: 3-dp kWh as the CSV does, money in the currency's minor unit, no grouping", () => {
    const model = build({
      bills: [
        bill(1, A, {
          start_kwh: 1200,
          end_kwh: 1284.5,
          usage_kwh: 84.5123,
          tier_breakdown: [
            { label: "Lifeline", kwh: 15, amount: 3750 },
            { label: "Standard", kwh: 69.5123, amount: 26437.5 },
          ],
          total_amount: 55875,
        }),
      ],
    });
    // Shown to 3 dp, as the legacy table shows it, and copied the same.
    expect(model.body.rows[0].cells.usage.text).toBe("84.512");
    expect(figure(model, 0, "begin")).toBe("1200");
    expect(figure(model, 0, "end")).toBe("1284.5");
    expect(figure(model, 0, "usage")).toBe("84.512");
    expect(figure(model, 0, "tier.2.kwh")).toBe("69.512");
    expect(model.body.rows[0].cells.total.text).toBe("55,875");
    expect(figure(model, 0, "total")).toBe("55875");
    expect(figure(model, 0, "tier.2.amount")).toBe("26438");
    // A currency with a minor unit keeps it, where the CSV export rounds to a whole number.
    const usd = build({ microgrid: { id: MG, name: "North", currency: "USD" }, bills: [bill(1, A, { total_amount: 12.34 })] });
    expect(figure(usd, 0, "total")).toBe("12.34");
    expect(figure(usd, 0, "tier.1.amount")).toBe("3750.00");
  });

  it("gives an empty cell no figure, and one row per model row with its id", () => {
    const model = build({
      bills: [bill(1, A, { usage_kwh: null, tier_breakdown: [{ label: "Lifeline", kwh: 5, amount: 1250 }] }), bill(3, C)],
    });
    expect(figure(model, 0, "usage")).toBeNull();
    expect(figure(model, 0, "tier.2.kwh")).toBeNull();
    expect(figure(model, 0, "tier.2.amount")).toBeNull();
    expect(figure(model, 0, "tier.1.amount")).toBe("1250");
    const ext = extOf(model);
    expect(ext.rows.map((r) => r.id)).toEqual(model.body.rows.map((r) => r.id));
    for (const row of ext.rows) expect(row.figures).toHaveLength(ext.columns.length);
  });

  it("totals every bill, a hidden tenant's included, aligned with the columns and without float-dust", () => {
    const hidden = tenant(9, "Hidden");
    const model = build({
      tenants: [A, B],
      bills: [
        bill(1, A, { usage_kwh: 0.1, tier_breakdown: [{ label: "Lifeline", kwh: 0.1, amount: 25 }], total_amount: 25 }),
        bill(2, B, { usage_kwh: 0.2, tier_breakdown: [{ label: "Lifeline", kwh: 0.2, amount: 50 }], total_amount: 50 }),
        bill(3, hidden, { usage_kwh: 10, tier_breakdown: [{ label: "Lifeline", kwh: 10, amount: 2500 }], total_amount: 2500 }),
      ],
    });
    const ext = extOf(model);
    expect(ext.rows).toHaveLength(2);
    expect(ext.rows.map((r) => r.id)).not.toContain(bill(3, hidden).id);
    expect(ext.totals).toHaveLength(ext.columns.length);
    const total = (key: string) => ext.totals[ext.columns.indexOf(key)];
    expect(total("begin")).toBeNull();
    expect(total("end")).toBeNull();
    expect(total("usage")).toBe("10.3");
    expect(total("tier.1.kwh")).toBe("10.3");
    expect(total("tier.1.amount")).toBe("2575");
    expect(total("tier.2.amount")).toBe("0");
    expect(total("total")).toBe("2575");
    // 0.1 + 0.2 alone is 0.30000000000000004: rounded as the CSV rounds.
    const dust = build({ tenants: [A, B], bills: [bill(1, A, { usage_kwh: 0.1 }), bill(2, B, { usage_kwh: 0.2 })] });
    expect(extOf(dust).totals[extOf(dust).columns.indexOf("usage")]).toBe("0.3");
  });

  it("has no rows and no totals with no bills", () => {
    expect(extOf(build({ bills: [] }))).toMatchObject({ rows: [], totals: [] });
  });

  it("carries no tenant's name", () => {
    const model = build({ bills: [bill(1, A), bill(2, B)] });
    const json = JSON.stringify(model.ext);
    for (const t of [A, B]) expect(json).not.toContain(t.display_name);
  });
});

describe("buildPeriodReviewModel: the period", () => {
  it("is titled by the period, with its time zone, and is the period's entity", () => {
    const model = build();
    const label = `${fmt.date("2026-10-01").text} – ${fmt.date("2026-10-31").text}`;
    expect(model.title).toBe(label);
    expect(model.subtitle).toBe("Africa/Kampala");
    expect(model.entity).toEqual({ kind: "billingPeriod", id: PERIOD, label });
    const oneDay = build({ period: { id: PERIOD, start_date: "2026-10-05", end_date: "2026-10-05", status: "draft", timezone: null } });
    expect(oneDay.title).toBe(fmt.date("2026-10-05").text);
    expect(oneDay).not.toHaveProperty("subtitle");
  });

  it("offers a draft with tenants Generate from meter data, labelled as the legacy header labels it", () => {
    const generate = { action: GENERATE_FROM_METERS_ACTION.id, params: { periodId: PERIOD } };
    expect(build({ bills: [] }).actions).toEqual([{ ...generate, label: "Generate bills from meter data" }]);
    expect(build().actions).toEqual([{ ...generate, label: REFRESH_FROM_METERS_LABEL }]);
    expect(REFRESH_FROM_METERS_LABEL).toBe("Refresh readings from meters");
  });

  it.each([
    ["a closed period with bills", { period: { ...input().period, status: "closed" as const } }],
    ["a closed period with no bills", { bills: [], period: { ...input().period, status: "closed" as const } }],
    ["a draft with no tenants", { tenants: [], bills: [] }],
  ])("offers Generate nowhere on %s", (_label, o) => {
    const model = build(o);
    expect(model.actions).toEqual([]);
    expect(model.body.empty).not.toHaveProperty("action");
    expect(JSON.stringify(model)).not.toContain(GENERATE_FROM_METERS_ACTION.id);
  });

  it("links the history always, a draft's close checklist, and the send queue and CSV export only when there are bills", () => {
    const history = { id: "billing.view-history", label: "View history", href: `/microgrids/${MG}/billing/${PERIOD}/history` };
    const close = { id: "billing.close-checklist", label: "Close period", href: `/microgrids/${MG}/billing/${PERIOD}/close` };
    const send = { id: "billing.send-queue", label: "Payment links", icon: "payments", href: `/microgrids/${MG}/billing/${PERIOD}/send` };
    // With no bills too: the checklist says why Close is blocked. No bills, nothing to send.
    expect(build({ bills: [] }).links).toEqual([history, close]);
    expect(build({ bills: [], period: { ...input().period, status: "closed" } }).links).toEqual([history]);
    // A closed period's bills are still payable, so it links its send queue too.
    const closed = build({ period: { ...input().period, status: "closed" } }).links ?? [];
    expect(closed.map((l) => l.id)).toEqual(["billing.view-history", "billing.send-queue", "billing.export-csv"]);
    expect(closed[1]).toEqual(send);
    expect(build().links).toEqual([
      history,
      close,
      send,
      {
        id: "billing.export-csv",
        label: "Export CSV",
        icon: "download",
        href: `/api/billing-periods/${PERIOD}/export-csv`,
        download: { mime: "text/csv", filename: "north-site-billing-period-2026-10-01-to-2026-10-31.csv" },
      },
    ]);
  });

  it.each([
    ["no tenants, a draft", { tenants: [], bills: [] }, { title: "No tenants configured for this microgrid." }],
    ["no tenants, closed", { tenants: [], bills: [], period: { ...input().period, status: "closed" as const } }, { title: "No tenants configured for this microgrid." }],
    // The legacy page's Generate, as the empty state's call to action.
    [
      "tenants and no bills, a draft",
      { bills: [] },
      {
        title: "No billing data yet.",
        text: "Generate bills from meter data to read each tenant's meter for this period and calculate their bills.",
        action: { action: GENERATE_FROM_METERS_ACTION.id, params: { periodId: PERIOD }, label: "Generate bills from meter data" },
      },
    ],
    ["tenants and no bills, closed", { bills: [], period: { ...input().period, status: "closed" as const } }, { title: "No billing data yet." }],
  ])("shows the legacy empty state for %s", (_label, o, empty) => {
    const model = build(o);
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty).toEqual(empty);
  });
});

describe("buildPeriodReviewModel: each bill's actions", () => {
  const params = (b: ReviewBill) => ({ lineItemId: b.id });

  it("offers regenerating by reading source, in the legacy menu's order, with each mode prefilled", () => {
    const edge = bill(1, A, { start_kwh: 100 });
    const manual = bill(2, B, { reading_source: "manual", start_kwh: 10, end_kwh: 20 });
    const [edgeRow, manualRow] = build({ bills: [edge, manual] }).body.rows;
    expect(edgeRow.actions.filter((a) => a.action === REGENERATE_BILL_ACTION.id)).toEqual([
      { action: REGENERATE_BILL_ACTION.id, params: params(edge), label: "Regenerate from edge data", prefill: { readings: "edge" } },
      { action: REGENERATE_BILL_ACTION.id, params: params(edge), label: "Switch to manual entry", prefill: { readings: "manual", start_kwh: 100 } },
    ]);
    expect(manualRow.actions.filter((a) => a.action === REGENERATE_BILL_ACTION.id)).toEqual([
      { action: REGENERATE_BILL_ACTION.id, params: params(manual), label: "Switch back to edge data", prefill: { readings: "edge" } },
      { action: REGENERATE_BILL_ACTION.id, params: params(manual), label: "Re-enter manual readings", prefill: { readings: "manual", start_kwh: 10, end_kwh: 20 } },
    ]);
  });

  it("offers only manual entry without an edge, leaves a missing reading out of the prefill, and nothing on a refunded bill", () => {
    const noEdge = tenant(4, "Nambi", { edgeAvailable: false });
    const [row, refunded] = build({
      tenants: [noEdge, A],
      bills: [bill(1, noEdge, { reading_source: "manual", start_kwh: null, end_kwh: 20 }), bill(2, A, { payment_status: "refunded" })],
    }).body.rows;
    expect(row.actions.filter((a) => a.action === REGENERATE_BILL_ACTION.id).map((a) => [a.label, a.prefill])).toEqual([
      ["Re-enter manual readings", { readings: "manual", end_kwh: 20 }],
    ]);
    expect(refunded.actions).toEqual([]);
  });

  it("offers a usage correction only where the usage route accepts one", () => {
    const unmetered = tenant(5, "Unmetered", { meterLinkInPeriod: false });
    const ok = bill(1, unmetered, { device_id: null, reading_source: "manual" });
    const has = (o: Partial<PeriodReviewInput>) =>
      build({ tenants: [unmetered], ...o }).body.rows[0].actions.some((a) => a.action === RECORD_USAGE_ACTION.id);
    expect(has({ bills: [ok] })).toBe(true);
    expect(build({ tenants: [unmetered], bills: [ok] }).body.rows[0].actions.find((a) => a.action === RECORD_USAGE_ACTION.id)).toEqual({
      action: RECORD_USAGE_ACTION.id,
      params: params(ok),
    });
    expect(has({ bills: [ok], period: { ...input().period, status: "closed" } })).toBe(false);
    expect(has({ bills: [{ ...ok, device_id: "e7500000-0000-4000-8006-000000000009" }] })).toBe(false);
    expect(has({ bills: [ok], tenants: [{ ...unmetered, meterLinkInPeriod: true }] })).toBe(false);
    expect(has({ bills: [{ ...ok, start_kwh: null }] })).toBe(false);
  });

  it.each([false, true])("offers only a usage correction on a refunded unmetered draft bill (super admin: %s), as the usage route accepts one", (superAdmin) => {
    const unmetered = tenant(5, "Unmetered", { meterLinkInPeriod: false });
    const refunded = bill(1, unmetered, { device_id: null, start_kwh: 100, payment_status: "refunded" });
    const [row] = build({ tenants: [unmetered], bills: [refunded], superAdmin }).body.rows;
    expect(row.actions).toEqual([{ action: RECORD_USAGE_ACTION.id, params: params(refunded) }]);
  });

  it("offers each payment action with the status it sets", () => {
    const [row] = build({ bills: [bill(1, A, { payment_status: "link_generated" })], superAdmin: true }).body.rows;
    expect(row.actions.filter((a) => a.prefill && "status" in (a.prefill as object))).toEqual([
      { action: MARK_PAID_ACTION.id, params: params(bill(1, A)), prefill: { status: "paid" } },
      { action: CANCEL_PAYMENT_LINK_ACTION.id, params: params(bill(1, A)), prefill: { status: "unpaid" } },
      { action: MARK_FAILED_ACTION.id, params: params(bill(1, A)), prefill: { status: "failed" } },
    ]);
  });

  it("orders a row's actions as the legacy menu does: regenerate, correct usage, then payment status", () => {
    const unmetered = tenant(5, "Unmetered", { meterLinkInPeriod: false, edgeAvailable: false });
    const [row] = build({ tenants: [unmetered], bills: [bill(1, unmetered, { device_id: null, reading_source: "manual" })] }).body.rows;
    expect(actionsOf(row)).toEqual([
      [REGENERATE_BILL_ACTION.id, "Re-enter manual readings"],
      [RECORD_USAGE_ACTION.id, undefined],
      [MARK_PAID_ACTION.id, undefined],
    ]);
  });
});

describe("the payment actions", () => {
  it("map each manual transition of the payment state machine to exactly one action", () => {
    const seen = new Map<string, string>();
    for (const t of ALLOWED_MANUAL_TRANSITIONS) {
      const action = paymentActionFor(t);
      const key = `${t.from}->${t.to}`;
      expect(seen.has(key)).toBe(false);
      seen.set(key, action);
    }
    expect(Object.fromEntries(seen)).toEqual({
      "unpaid->paid": MARK_PAID_ACTION.id,
      "paid->unpaid": MARK_UNPAID_ACTION.id,
      "failed->paid": MARK_PAID_ACTION.id,
      "paid->refunded": MARK_REFUNDED_ACTION.id,
      "link_generated->unpaid": CANCEL_PAYMENT_LINK_ACTION.id,
      "link_generated->paid": MARK_PAID_ACTION.id,
      "link_generated->failed": MARK_FAILED_ACTION.id,
    });
  });

  it.each<[PaymentStatus, boolean, string[]]>([
    ["unpaid", false, [MARK_PAID_ACTION.id]],
    ["paid", false, [MARK_UNPAID_ACTION.id]],
    ["paid", true, [MARK_UNPAID_ACTION.id, MARK_REFUNDED_ACTION.id]],
    ["failed", false, [MARK_PAID_ACTION.id]],
    ["link_generated", false, [MARK_PAID_ACTION.id, CANCEL_PAYMENT_LINK_ACTION.id]],
    ["link_generated", true, [MARK_PAID_ACTION.id, CANCEL_PAYMENT_LINK_ACTION.id, MARK_FAILED_ACTION.id]],
    ["refunded", true, []],
  ])("offer a %s bill, super admin %s, the legacy menu's items", (status, superAdmin, ids) => {
    expect(paymentActionsFor(status, superAdmin).map((a) => a.action)).toEqual(ids);
  });
});

describe("the examples", () => {
  it("are received models of this view, built by the model", () => {
    expect(PERIOD_REVIEW_EXAMPLES).toHaveLength(5);
    for (const example of PERIOD_REVIEW_EXAMPLES) {
      expect(example).toMatchObject({ view: "billing.period-review", kind: "collection" });
      // So a GUI with a renderer for it draws them with that renderer.
      expect(example.ext?.schema).toBe("billing.period-review@1");
    }
    expect(PERIOD_REVIEW_EXAMPLES[4].notice).toMatchObject({ tone: "warning" });
    expect(PERIOD_REVIEW_EXAMPLES[4].body.rows.flatMap((r) => r.actions).every((a) => !a.enabled)).toBe(true);
    // The closed example is seen by a super admin, who is offered marking failed and refunded.
    const closed = PERIOD_REVIEW_EXAMPLES[1].body.rows.flatMap((r) => r.actions.map((a) => a.action));
    expect(closed).toEqual(expect.arrayContaining([MARK_REFUNDED_ACTION.id, MARK_FAILED_ACTION.id]));
    expect(closed).not.toContain(RECORD_USAGE_ACTION.id);
    expect(PERIOD_REVIEW_EXAMPLES[1].actions).toEqual([]);
  });
});

describe("generateReadiness", () => {
  const PERIOD_DATES = { start_date: "2026-10-01", end_date: "2026-10-31" };
  const meter = { openems_component_id: "meter0", edges: { openems_edge_id: "edge0" } };
  const covering = { effective_from: "2026-01-01", effective_to: null, devices: meter };
  const t = (n: number, primaryLinks: unknown[]) => ({ id: `t${n}`, display_name: `Unit ${n}`, primaryLinks: primaryLinks as never[] });
  const b = (n: number, o: Partial<{ reading_source: string | null; payment_status: string; invoice_number: string | null }> = {}) => ({
    tenant_id: `t${n}`,
    reading_source: "edge",
    payment_status: "unpaid",
    invoice_number: null,
    ...o,
  });

  it("decides each tenant as the engine does with guardExistingBills: kept, left, read from its meter, or not read", () => {
    const r = generateReadiness(
      PERIOD_DATES,
      [
        t(1, [covering]),
        t(2, [covering]),
        t(3, [covering]),
        t(4, [covering]),
        t(5, [covering]),
        t(6, [covering]),
        t(7, []),
        t(8, [{ ...covering, effective_from: "2026-10-15" }]),
        t(9, [{ ...covering, devices: { ...meter, openems_component_id: null } }]),
        // A manual bill is kept, whatever its meter or payment.
        t(10, []),
        t(11, [covering]),
      ],
      [
        b(2),
        b(3, { reading_source: "manual" }),
        b(4, { payment_status: "paid" }),
        b(5, { invoice_number: "EXS-1" }),
        b(6, { payment_status: "refunded" }),
        b(10, { reading_source: "manual", payment_status: "paid" }),
        b(11, { reading_source: null, payment_status: "link_generated" }),
      ],
    );
    expect(r).toEqual({
      fromMeters: 3,
      refresh: 2,
      kept: 2,
      left: 3,
      notRead: [
        { tenantName: "Unit 7", reason: "no_meter" },
        { tenantName: "Unit 8", reason: "assignment_gap" },
        { tenantName: "Unit 9", reason: "no_meter" },
      ],
    });
  });
});

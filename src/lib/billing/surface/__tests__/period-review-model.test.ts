/**
 * The `billing.period-review` model: the legacy period page's table as a
 * collection, one row per bill of a readable tenant, totals over every bill,
 * the period's links and Generate, and each bill's actions and links.
 */
import { describe, expect, it } from "vitest";
import type { LinkRef } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { ViewDef } from "@/lib/gui/surface";
import { ALLOWED_MANUAL_TRANSITIONS, type PaymentStatus } from "@/lib/payments/state";
import { BILLING_SURFACE } from "../../surface";
import { PERIOD_REVIEW_EXAMPLES, PERIOD_REVIEW_LOADED_EXAMPLES } from "../period-review-examples";
import {
  buildPeriodReviewModel,
  CANCEL_PAYMENT_LINK_ACTION,
  GENERATE_BILLS_ACTION,
  MARK_FAILED_ACTION,
  MARK_PAID_ACTION,
  MARK_REFUNDED_ACTION,
  MARK_UNPAID_ACTION,
  paymentActionFor,
  paymentActionsFor,
  PERIOD_REVIEW_KEYS,
  RECORD_USAGE_ACTION,
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
    // Bare money columns name their currency in the header.
    for (const c of model.body.columns) if (c.type === "money") expect(c.copy).toBe("bare");
  });

  it("emits only declared keys, so the host's strict parse passes", () => {
    for (const model of PERIOD_REVIEW_LOADED_EXAMPLES) {
      expect(strictParseModel(view, model)).toMatchObject({ ok: true });
      for (const key of Object.keys(model.body.rows[0]?.cells ?? {})) {
        expect((PERIOD_REVIEW_KEYS as readonly string[]).includes(key) || key.startsWith("tier.")).toBe(true);
      }
    }
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
    expect(row.cells.begin).toMatchObject({ t: "energy", v: 100, unit: "kWh", text: "100.0" });
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

  it("has no totals with no bills", () => {
    expect(build({ bills: [] }).body).not.toHaveProperty("totals");
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

  it("offers Generate on a draft, as Refresh readings once there are bills, with no prefill", () => {
    expect(build({ bills: [] }).actions).toEqual([{ action: GENERATE_BILLS_ACTION.id, params: { billingPeriodId: PERIOD } }]);
    expect(build().actions).toEqual([{ action: GENERATE_BILLS_ACTION.id, params: { billingPeriodId: PERIOD }, label: "Refresh readings" }]);
    const closed = build({ period: { ...input().period, status: "closed" } });
    expect(closed.actions).toEqual([]);
  });

  it("links the history always, and the CSV export only when there are bills", () => {
    const history = { id: "billing.view-history", label: "View history", href: `/microgrids/${MG}/billing/${PERIOD}/history` };
    expect(build({ bills: [] }).links).toEqual([history]);
    expect(build().links).toEqual([
      history,
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
    [
      "tenants and no bills, a draft",
      { bills: [] },
      {
        title: "No billing data yet.",
        text: "Generate bills to fetch meter readings and calculate costs.",
        action: { action: GENERATE_BILLS_ACTION.id, params: { billingPeriodId: PERIOD } },
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
    for (const example of PERIOD_REVIEW_EXAMPLES) expect(example).toMatchObject({ view: "billing.period-review", kind: "collection" });
    expect(PERIOD_REVIEW_EXAMPLES[4].notice).toMatchObject({ tone: "warning" });
    expect(PERIOD_REVIEW_EXAMPLES[4].body.rows.flatMap((r) => r.actions).every((a) => !a.enabled)).toBe(true);
    // The closed example is seen by a super admin, who is offered marking failed and refunded.
    const closed = PERIOD_REVIEW_EXAMPLES[1].body.rows.flatMap((r) => r.actions.map((a) => a.action));
    expect(closed).toEqual(expect.arrayContaining([MARK_REFUNDED_ACTION.id, MARK_FAILED_ACTION.id]));
    expect(closed).not.toContain(RECORD_USAGE_ACTION.id);
    expect(PERIOD_REVIEW_EXAMPLES[1].actions).toEqual([]);
  });
});

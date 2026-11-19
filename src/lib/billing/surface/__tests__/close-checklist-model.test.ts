/**
 * The close checklist's model: each step's state and detail from the close
 * review and the bills' sources, the close step's action, the closed state
 * with its CSV export, and the header and links.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { CLOSE_ACKNOWLEDGEMENTS, type CloseReview } from "../../close";
import {
  buildCloseChecklistModel,
  CLOSE_CHECKLIST_DETAIL_MAX,
  CLOSE_CHECKLIST_STEPS,
  CLOSE_PERIOD_ACTION,
  closeChecklistHref,
  type CloseChecklistInput,
} from "../close-checklist-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7d00000-0000-4000-8000-0000000000a1";
const PERIOD = "e7d00000-0000-4000-8000-0000000000b1";
const REVIEW_HREF = `/microgrids/${MG}/billing/${PERIOD}`;
const houses = (n: number, name = "House") => Array.from({ length: n }, (_, i) => ({ tenantId: `t-${i + 1}`, tenantName: `${name} ${i + 1}` }));

const review = (o: Partial<CloseReview> = {}): CloseReview => ({
  periodId: PERIOD,
  microgridId: MG,
  status: "draft",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  currency: "UGX",
  billCount: 4,
  totalAmount: 120_000,
  usageKwh: 84.5,
  unbilled: [],
  unmetered: [],
  fractionalTotals: [],
  name: "October 2026",
  acknowledgements: [{ id: "totals_reviewed", label: CLOSE_ACKNOWLEDGEMENTS.totals_reviewed }],
  digest: "v1:abc",
  ...o,
});

const input = (o: Partial<CloseChecklistInput> = {}): CloseChecklistInput => ({
  microgrid: { id: MG, name: "North site", timezone: "Africa/Nairobi" },
  period: { id: PERIOD, start_date: "2026-10-01", end_date: "2026-10-31", closed_at: null, timezone: "Africa/Kampala" },
  review: review(),
  sources: { edge: 3, manual: 1 },
  fmt,
  ...o,
});

const build = (o: Partial<CloseChecklistInput> = {}) => buildCloseChecklistModel(input(o));
const states = (o: Partial<CloseChecklistInput> = {}) => build(o).body.steps.map((s) => [s.id, s.state]);
const stepOf = (o: Partial<CloseChecklistInput>, id: string) => build(o).body.steps.find((s) => s.id === id)!;
const CLOSE = { action: CLOSE_PERIOD_ACTION.id, params: { periodId: PERIOD }, label: "Close period" };

describe("buildCloseChecklistModel: a draft's steps", () => {
  it("are the declared steps, in order, each check linking to the period review", () => {
    const steps = build().body.steps;
    expect(steps.map((s) => s.id)).toEqual([...CLOSE_CHECKLIST_STEPS]);
    expect(steps.slice(0, 3).map((s) => s.href)).toEqual([REVIEW_HREF, REVIEW_HREF, REVIEW_HREF]);
    expect(steps[3]).not.toHaveProperty("href");
  });

  it("leave only the totals to confirm when every tenant has a bill with usage", () => {
    expect(states()).toEqual([
      ["bills", "done"],
      ["usage", "done"],
      ["totals", "todo"],
      ["close", "current"],
    ]);
    const [bills, usage, totals, close] = build().body.steps;
    expect(bills.detail).toBe("4 bills.");
    expect(usage.detail).toBe("Every bill has usage recorded. 3 read from meters, 1 entered by hand.");
    expect(totals.detail).toBe(`4 bills, ${fmt.energy(84_500).text}, total ${fmt.money(120_000, "UGX").text}. You confirm these figures when you close.`);
    expect(close).toEqual({
      id: "close",
      title: "Close the period",
      state: "current",
      detail: "Closing asks you to confirm the totals, tick each warning and type the period's name. Bills become final.",
      action: CLOSE,
    });
  });

  it("says one bill in the singular", () => {
    expect(stepOf({ review: review({ billCount: 1 }) }, "bills").detail).toBe("1 bill.");
  });

  it("asks to bill or acknowledge tenants with no bill, naming five and counting the rest", () => {
    const o = { review: review({ unbilled: houses(7) }) };
    expect(stepOf(o, "bills")).toMatchObject({
      state: "todo",
      detail:
        "7 tenants have no bill in this period: House 1, House 2, House 3, House 4, House 5 and 2 more. Generate their bills, or acknowledge it when you close.",
    });
    expect(stepOf({ review: review({ unbilled: houses(1) }) }, "bills").detail).toMatch(/^1 tenant has no bill in this period: House 1\. /);
    expect(stepOf(o, "close").state).toBe("current");
  });

  it("asks to record or acknowledge bills with no usage, with the readings' sources", () => {
    expect(stepOf({ review: review({ unmetered: houses(2) }) }, "usage")).toMatchObject({
      state: "todo",
      detail:
        "2 bills have no usage recorded: House 1, House 2. Enter their readings on the period's page, or acknowledge it when you close. 3 read from meters, 1 entered by hand.",
    });
  });

  it("blocks the close with no bills, leaving usage and totals to do with no detail", () => {
    const o = { review: review({ billCount: 0, totalAmount: 0, usageKwh: 0, unbilled: houses(3) }), sources: { edge: 0, manual: 0 } };
    expect(states(o)).toEqual([
      ["bills", "blocked"],
      ["usage", "todo"],
      ["totals", "todo"],
      ["close", "blocked"],
    ]);
    const [bills, usage, totals, close] = build(o).body.steps;
    expect(bills.detail).toBe("No bills yet. Generate the bills on the period's page before closing.");
    expect(usage).not.toHaveProperty("detail");
    expect(totals).not.toHaveProperty("detail");
    // Offered blocked too, so available() can say why.
    expect(close).toEqual({ id: "close", title: "Close the period", state: "blocked", detail: "Fix the blocked items above before closing.", action: CLOSE });
  });

  it("blocks the close on a total that is not a whole number, as the route refuses it", () => {
    const o = { review: review({ fractionalTotals: houses(6, "Flat") }) };
    expect(states(o)).toEqual([
      ["bills", "done"],
      ["usage", "done"],
      ["totals", "blocked"],
      ["close", "blocked"],
    ]);
    expect(stepOf(o, "totals").detail).toBe(
      "Regenerate the bills for Flat 1, Flat 2, Flat 3, Flat 4, Flat 5 and 1 more before closing: their totals are not whole numbers.",
    );
  });

  it("mixes the states when warnings and a blocked total meet", () => {
    expect(states({ review: review({ unbilled: houses(1), unmetered: houses(1), fractionalTotals: houses(1) }) })).toEqual([
      ["bills", "todo"],
      ["usage", "todo"],
      ["totals", "blocked"],
      ["close", "blocked"],
    ]);
  });

  it("shows a total with no currency as a plain number, as the ceremony does", () => {
    expect(stepOf({ review: review({ currency: null }) }, "totals").detail).toContain(`total ${fmt.number(120_000).text}.`);
  });

  it("clips every detail under the host's text cap, however long the tenants' names", () => {
    const long = Array.from({ length: 5 }, (_, i) => ({ tenantId: `t-${i}`, tenantName: `${"x".repeat(900)}${i}` }));
    const model = build({ review: review({ unbilled: long, unmetered: long, fractionalTotals: long }) });
    for (const s of model.body.steps) expect((s.detail ?? "").length).toBeLessThanOrEqual(CLOSE_CHECKLIST_DETAIL_MAX);
    expect(model.body.steps[0].detail?.endsWith("…")).toBe(true);
  });
});

describe("buildCloseChecklistModel: a closed period", () => {
  const closedAt = "2026-11-05T13:00:00+00:00";
  const closed = (o: Partial<CloseChecklistInput["period"]> = {}, r: Partial<CloseReview> = {}) =>
    build({ period: { ...input().period, closed_at: closedAt, ...o }, review: review({ status: "closed", ...r }) });

  it("is one done step, closed at the time in the period's zone, with no action", () => {
    const model = closed();
    expect(model.title).toBe("October 2026 is closed");
    expect(model.body.steps).toEqual([
      {
        id: "close",
        title: "Period closed",
        state: "done",
        detail: `Closed ${fmt.datetime(closedAt, "Africa/Kampala").text}. Bills are final; corrections are recorded against the closed period.`,
      },
    ]);
    expect(JSON.stringify(model)).not.toContain(CLOSE_PERIOD_ACTION.id);
  });

  it("falls back to the microgrid's zone, and says only Closed with no time", () => {
    expect(closed({ timezone: null }).body.steps[0].detail).toContain(fmt.datetime(closedAt, "Africa/Nairobi").text);
    expect(closed({ closed_at: null }).body.steps[0].detail).toBe("Closed. Bills are final; corrections are recorded against the closed period.");
  });

  it("links the CSV for URA when it has bills, as the legacy close dialog did", () => {
    expect(closed().links?.at(-1)).toEqual({
      id: "billing.export-csv",
      label: "Export CSV for URA",
      icon: "download",
      href: `/api/billing-periods/${PERIOD}/export-csv`,
      download: { mime: "text/csv", filename: "north-site-billing-period-2026-10-01-to-2026-10-31.csv" },
    });
    expect(closed({}, { billCount: 0 }).links?.map((l) => l.id)).toEqual(["billing.back-to-period", "billing.view-history"]);
  });
});

describe("buildCloseChecklistModel: the header and links", () => {
  it("titles a draft by the name the person types, with the period's zone and entity", () => {
    const model = build();
    expect(model.title).toBe("Close October 2026");
    expect(model.subtitle).toBe("Africa/Kampala");
    expect(model.entity).toEqual({ kind: "billingPeriod", id: PERIOD, label: `${fmt.date("2026-10-01").text} – ${fmt.date("2026-10-31").text}` });
    expect(model.actions).toEqual([]);
    expect(build({ period: { ...input().period, timezone: null } })).not.toHaveProperty("subtitle");
  });

  it("links back to the period and to its history, and no export on a draft", () => {
    expect(build().links).toEqual([
      { id: "billing.back-to-period", label: "Back to period", href: REVIEW_HREF },
      { id: "billing.view-history", label: "View history", href: `${REVIEW_HREF}/history` },
    ]);
  });

  it("closeChecklistHref is the view's path", () => {
    expect(closeChecklistHref(MG, PERIOD)).toBe(`${REVIEW_HREF}/close`);
  });
});

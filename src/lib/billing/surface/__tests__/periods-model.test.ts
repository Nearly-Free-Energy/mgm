/**
 * The `billing.periods` model: the legacy periods list as a collection, with
 * the create action on the view and its empty state, and Delete on each
 * draft row.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { ViewDef } from "@/lib/gui/surface";
import { BillingCapability } from "../../capability";
import type { BillingRepository } from "../../repository";
import { BILLING_SURFACE } from "../../surface";
import { PERIODS_EXAMPLES, PERIODS_LOADED_EXAMPLES } from "../periods-examples";
import { buildPeriodsModel, CREATE_PERIOD_ACTION, DELETE_PERIOD_ACTION, PERIODS_KEYS, type PeriodRowInput } from "../periods-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7100000-0000-4000-8002-0000000000a1";
const view = BILLING_SURFACE.views!.find((v) => v.id === "billing.periods") as ViewDef;

const period = (o: Partial<PeriodRowInput> = {}): PeriodRowInput => ({
  id: "e7100000-0000-4000-8003-0000000000b1",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  status: "draft",
  totalKwh: null,
  totalAmount: null,
  ...o,
});
const build = (periods: PeriodRowInput[], currency = "UGX") => buildPeriodsModel({ microgridId: MG, currency, periods, fmt });

describe("buildPeriodsModel", () => {
  it("emits the legacy list's columns, and only declared keys", () => {
    const model = build([period()]);
    expect(model.title).toBe("Billing periods");
    expect(model.body.columns.map((c) => [c.key, c.label, c.type])).toEqual([
      ["period", "Period", "text"],
      ["status", "Status", "status"],
      ["energy", "Total kWh", "energy"],
      ["total", "Total (UGX)", "money"],
    ]);
    expect(Object.keys(model.body.rows[0].cells)).toEqual([...PERIODS_KEYS]);
    // A bare money column names its currency in the header (the conformance check).
    expect(model.body.columns.find((c) => c.key === "total")).toMatchObject({ copy: "bare", label: "Total (UGX)" });
    expect(build([period()], "USD").body.columns.find((c) => c.key === "total")!.label).toBe("Total (USD)");
  });

  it("gives each row its billing period, its review page and the host's label", () => {
    const row = build([period()]).body.rows[0];
    expect(row.entity).toEqual({ kind: "billingPeriod", id: period().id, label: "1 Oct 2026 – 31 Oct 2026" });
    expect(row.href).toBe(`/microgrids/${MG}/billing/${period().id}`);
    expect(row.cells.period).toEqual({ t: "text", text: "1 Oct 2026 – 31 Oct 2026" });
    expect(row.cells.status).toMatchObject({ t: "status", v: "draft" });
  });

  it("shows a one-day period as its one date", () => {
    const row = build([period({ start_date: "2026-10-05", end_date: "2026-10-05" })]).body.rows[0];
    expect(row.cells.period.text).toBe("5 Oct 2026");
  });

  it("gives energy in Wh to Fmt, and shows the bare figures", () => {
    const row = build([period({ status: "closed", totalKwh: 1284.5, totalAmount: 4_216_800 })]).body.rows[0];
    expect(row.cells.energy).toMatchObject({ t: "energy", v: 1284.5, unit: "kWh" });
    expect(row.cells.energy.text).not.toContain("kWh");
    expect(row.cells.total).toEqual({ t: "money", v: 4_216_800, currency: "UGX", text: "4,216,800" });
  });

  it("shows 0 kWh and an empty total for a period with no bills, as the legacy list does", () => {
    const row = build([period()]).body.rows[0];
    expect(row.cells.energy).toMatchObject({ v: 0 });
    expect(row.cells.total.t).toBe("empty");
  });

  it("offers Delete on draft rows only", () => {
    const draft = period();
    const closed = period({ id: "e7100000-0000-4000-8003-0000000000b2", status: "closed" });
    const rows = build([draft, closed]).body.rows;
    expect(rows[0].actions).toEqual([{ action: DELETE_PERIOD_ACTION.id, params: { periodId: draft.id } }]);
    expect(rows[1].actions).toEqual([]);
  });

  it("offers create on the view and in the empty state, with no prefill", () => {
    const create = { action: CREATE_PERIOD_ACTION.id, params: { microgrid_id: MG } };
    const empty = build([]);
    expect(empty.actions).toEqual([create]);
    expect(empty.body.empty).toMatchObject({ title: "Create the first billing period", action: create });
    expect(empty.body.empty.text).toContain("typically one calendar month");
    expect(build([period()]).actions).toEqual([create]);
  });
});

describe("PERIODS_EXAMPLES", () => {
  it("pass the view's strict parse as the loader returns them", () => {
    for (const loaded of PERIODS_LOADED_EXAMPLES) expect(strictParseModel(view, loaded)).toMatchObject({ ok: true });
  });

  it("are a list with a closed and a draft period, the empty state, and the empty state while billing is off", () => {
    expect(PERIODS_EXAMPLES.map((e) => [e.view, e.kind, e.body.rows.length, e.notice?.tone ?? null])).toEqual([
      ["billing.periods", "collection", 2, null],
      ["billing.periods", "collection", 0, null],
      ["billing.periods", "collection", 0, "warning"],
    ]);
    const [list, empty, off] = PERIODS_EXAMPLES;
    expect(list.body.rows.map((r) => r.actions.map((a) => [a.action, a.label, a.enabled, a.tone]))).toEqual([
      [["billing.delete-period", "Delete period", true, "danger"]],
      [],
    ]);
    expect(empty.body.empty.action).toMatchObject({ action: CREATE_PERIOD_ACTION.id, label: "New billing period", enabled: true });
    expect(off.body.empty.action).toMatchObject({ enabled: false, reason: off.notice!.text });
    expect(off.actions).toEqual([off.body.empty.action]);
  });

  it("carry the copy billing answers with while disabled", async () => {
    const repo = {
      isPluginEnabled: async () => false,
      getMicrogridOrganization: async () => ({ microgridId: MG, communityId: "c", orgId: "o" }),
    } as unknown as BillingRepository;
    const capability = new BillingCapability(repo, { organizationId: "o", userId: "u", roles: [] }, { run: async () => ({ results: [] }) }, () => true);
    const refused = await capability.createPeriod({ microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31" });
    expect(refused).toMatchObject({ ok: false, code: "billing_disabled" });
    expect(PERIODS_EXAMPLES[2].notice!.text).toBe((refused as { message: string }).message);
  });
});

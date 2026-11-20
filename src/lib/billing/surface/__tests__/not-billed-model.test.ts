/**
 * The `billing.not-billed` model: the tenants of the period's microgrid with
 * no bill for it, in the order given, with why (meterCoverage's answer), and
 * Bill from readings on each while the period is a draft.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { ViewDef } from "@/lib/gui/surface";
import type { MeterCoverage, PrimaryMeterLink } from "../../meter-coverage";
import { BILLING_SURFACE } from "../../surface";
import { NOT_BILLED_EXAMPLES, NOT_BILLED_LOADED_EXAMPLES } from "../not-billed-examples";
import {
  BILL_FROM_READINGS_ACTION,
  buildNotBilledModel,
  NOT_BILLED_COPY,
  NOT_BILLED_KEYS,
  NOT_BILLED_REASON,
  NOT_BILLED_TITLE,
  NOT_BILLED_VIEW,
  notBilledHref,
  type NotBilledInput,
} from "../not-billed-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7900000-0000-4000-8002-0000000000a1";
const PERIOD = { id: "e7900000-0000-4000-8003-0000000000b1", start_date: "2026-04-01", end_date: "2026-04-30", status: "draft" as const };
const T = (n: number) => `e7900000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const view = BILLING_SURFACE.views!.find((v) => v.id === NOT_BILLED_VIEW) as ViewDef;

const meter = { openems_component_id: "meter1", edges: { openems_edge_id: "edge0" } };
const link = (from: string | null, to: string | null, devices: PrimaryMeterLink["devices"] = meter): PrimaryMeterLink => ({
  effective_from: from,
  effective_to: to,
  devices,
});

const build = (o: Partial<NotBilledInput> = {}) =>
  buildNotBilledModel({
    microgridId: MG,
    period: PERIOD,
    tenants: [
      { id: T(1), display_name: "Akello Grace", primaryLinks: [link("2020-01-01", null)] },
      { id: T(2), display_name: "Byaruhanga Peter", primaryLinks: [] },
      { id: T(3), display_name: "Kato Joseph", primaryLinks: [link("2026-05-01", null)] },
      { id: T(4), display_name: "Nambi Sarah", primaryLinks: [link("2020-01-01", null)] },
    ],
    billedTenantIds: new Set([T(4)]),
    fmt,
    ...o,
  });

describe("buildNotBilledModel", () => {
  it("lists only tenants with no bill, in the order given, with only declared keys", () => {
    const model = build();
    expect(model.title).toBe(NOT_BILLED_TITLE);
    expect(model.subtitle).toBe(NOT_BILLED_COPY.subtitle);
    expect(model.body.columns.map((c) => [c.key, c.label, c.type])).toEqual([
      ["tenant", "Tenant", "ref"],
      ["reason", "Why", "text"],
    ]);
    expect(model.body.rows.map((r) => r.id)).toEqual([T(1), T(2), T(3)]);
    for (const row of model.body.rows) expect(Object.keys(row.cells).every((k) => (NOT_BILLED_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(model.actions).toEqual([]);
    expect(model).not.toHaveProperty("entity");
  });

  // The same links as meter-coverage.test.ts, which runs the engine on them.
  it.each([
    ["no link", [], "no_meter"],
    ["one link covering the period", [link("2020-01-01", null)], "metered"],
    ["a link ending on the period's last day", [link("2020-01-01", "2026-04-30")], "assignment_gap"],
    ["a link starting after the period", [link("2026-05-01", null)], "assignment_gap"],
    ["a replacement within the period", [link("2020-01-01", "2026-04-15"), link("2026-04-15", null)], "assignment_gap"],
    ["a covering link with no meter", [link("2020-01-01", null, null)], "no_meter"],
    ["a covering meter on an edge with no OpenEMS id", [link("2020-01-01", null, { ...meter, edges: { openems_edge_id: null } })], "no_meter"],
  ] as [string, PrimaryMeterLink[], MeterCoverage][])("says why for %s", (_label, primaryLinks, coverage) => {
    const model = build({ tenants: [{ id: T(1), display_name: "Akello Grace", primaryLinks }], billedTenantIds: new Set() });
    expect(model.body.rows[0].cells.reason).toEqual(fmt.text(NOT_BILLED_REASON[coverage]));
  });

  it("links each tenant as the host does, as its row's entity and its tenant cell", () => {
    const row = build().body.rows[0];
    const ref = { kind: "tenant", id: T(1), label: "Akello Grace", href: `/microgrids/${MG}/setup/tenants/${T(1)}` } as const;
    expect(row.entity).toEqual(ref);
    expect(row.cells.tenant).toEqual(fmt.ref(ref));
  });

  it("offers Bill from readings on each row of a draft, bound to the period and that tenant only", () => {
    for (const row of build().body.rows) {
      expect(row.actions).toEqual([
        { action: BILL_FROM_READINGS_ACTION.id, params: { periodId: PERIOD.id, tenantId: row.id }, label: BILL_FROM_READINGS_ACTION.title },
      ]);
    }
  });

  it("lists a closed period's tenants not billed with no action", () => {
    const model = build({ period: { ...PERIOD, status: "closed" } });
    expect(model.body.rows).toHaveLength(3);
    for (const row of model.body.rows) expect(row.actions).toEqual([]);
  });

  it("says every tenant has a bill, or that the microgrid has none", () => {
    expect(build({ billedTenantIds: new Set([T(1), T(2), T(3), T(4)]) }).body).toMatchObject({ rows: [], empty: { title: NOT_BILLED_COPY.allBilled } });
    expect(build({ tenants: [] }).body).toMatchObject({ rows: [], empty: { title: NOT_BILLED_COPY.noTenants } });
  });

  it("names its own page under the period", () => {
    expect(notBilledHref(MG, PERIOD.id)).toBe(`/microgrids/${MG}/billing/${PERIOD.id}/not-billed`);
    expect(view.path).toBe("/microgrids/[id]/billing/[periodId]/not-billed");
  });
});

describe("NOT_BILLED_EXAMPLES", () => {
  it("pass the view's strict parse as the loader returns them", () => {
    for (const loaded of NOT_BILLED_LOADED_EXAMPLES) expect(strictParseModel(view, loaded)).toMatchObject({ ok: true });
  });

  it("are a draft with one tenant for each reason, the same while billing is off, a closed period, every tenant billed, and no tenants", () => {
    expect(
      NOT_BILLED_EXAMPLES.map((e) => [
        e.title,
        e.body.rows.length,
        e.body.rows.map((r) => r.cells.reason && "text" in r.cells.reason ? r.cells.reason.text : null),
        e.body.rows.flatMap((r) => r.actions.map((a) => a.enabled)),
        e.notice?.tone ?? null,
      ]),
    ).toEqual([
      [NOT_BILLED_TITLE, 3, [NOT_BILLED_REASON.metered, NOT_BILLED_REASON.no_meter, NOT_BILLED_REASON.assignment_gap], [true, true, true], null],
      [NOT_BILLED_TITLE, 3, [NOT_BILLED_REASON.metered, NOT_BILLED_REASON.no_meter, NOT_BILLED_REASON.assignment_gap], [false, false, false], "warning"],
      // In October the replaced meter still covered the whole period.
      [NOT_BILLED_TITLE, 3, [NOT_BILLED_REASON.metered, NOT_BILLED_REASON.no_meter, NOT_BILLED_REASON.metered], [], null],
      [NOT_BILLED_TITLE, 0, [], [], null],
      [NOT_BILLED_TITLE, 0, [], [], null],
    ]);
  });
});

/**
 * Today (`org.today`): one row per signal, in the host's order, each
 * leading to where it is resolved; the tray's copy for nothing to do and
 * for a source that did not answer; a notice when more signals were found
 * than are shown; its own empty state when the signals could not be
 * collected; a proposal's action handed back as a link; no entity on a row,
 * so no other plugin's action is appended to a signal.
 */
import { describe, expect, it } from "vitest";
import type { ActionRef, Signal, Signals } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { SurfaceRequest, ViewDef } from "@/lib/gui/surface";
import { ORGANIZATION_DIRECTORY_SURFACE } from "../surface";
import { loadToday } from "../today";
import { TODAY_EXAMPLES } from "../today-examples";
import { buildTodayModel, TODAY_COPY, TODAY_KEYS, TODAY_VIEW } from "../today-model";

const fmt = createFmt({ locale: "en-GB" });
const ORG = "e7a00000-0000-4000-8000-000000000001";
const MG = "e7a00000-0000-4000-8000-0000000000a1";

const signal = (over: Partial<Signal> = {}): Signal =>
  ({
    id: "billing.period-due:p1",
    source: "billing.period-due",
    kind: "your-move",
    severity: "warn",
    title: "North site: October 2026 is not closed",
    href: `/microgrids/${MG}/billing/p1/close`,
    at: "2026-10-31T21:00:00.000Z",
    ...over,
  }) as Signal;

const signals = (over: Partial<Signals> = {}): Signals => ({
  type: "signals",
  org: ORG,
  count: 0,
  top: [],
  checked: ["billing.period-due"],
  unchecked: [],
  ...over,
});

const def = ORGANIZATION_DIRECTORY_SURFACE.views!.find((v) => v.id === TODAY_VIEW) as ViewDef;

describe("buildTodayModel", () => {
  it("lists each signal in the order given, linking to where it is resolved, with no entity", () => {
    const top = [
      signal({ id: "payments.reconcile:p1", severity: "critical", title: "North site: 1 payment needs reconciliation", href: `/microgrids/${MG}/billing/p1/payments` }),
      signal({ due: "2026-11-01", facts: [fmt.text("1–31 Oct 2026")] }),
      signal({ id: "metering.connection:m1", severity: "info", title: "North site: OpenEMS could not be reached", href: `/microgrids/${MG}/setup/openems-backend` }),
    ];
    const model = buildTodayModel(fmt, signals({ count: 3, top }));
    expect(model.title).toBe("Today");
    expect(model.notice).toBeUndefined();
    expect(model.body.rows.map((r) => [r.id, r.href, r.cells.title.text, r.cells.severity])).toEqual([
      ["payments.reconcile:p1", `/microgrids/${MG}/billing/p1/payments`, "North site: 1 payment needs reconciliation", fmt.status("signalSeverity", "critical")],
      ["billing.period-due:p1", `/microgrids/${MG}/billing/p1/close`, "North site: October 2026 is not closed", fmt.status("signalSeverity", "warn")],
      ["metering.connection:m1", `/microgrids/${MG}/setup/openems-backend`, "North site: OpenEMS could not be reached", fmt.status("signalSeverity", "info")],
    ]);
    expect(model.body.rows[1].cells.due).toEqual(fmt.date("2026-11-01"));
    expect(model.body.rows[1].cells.details).toEqual(fmt.text("1–31 Oct 2026"));
    expect(model.body.rows[0].cells.due).toEqual(fmt.empty());
    for (const row of model.body.rows) {
      expect(row.entity).toBeUndefined();
      expect(row.actions).toEqual([]);
      expect(Object.keys(row.cells).every((k) => (TODAY_KEYS as readonly string[]).includes(k))).toBe(true);
    }
  });

  it("says nothing needs the person when every source answered with nothing", () => {
    const model = buildTodayModel(fmt, signals());
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty).toEqual({ title: TODAY_COPY.nothing });
    expect(model.notice).toBeUndefined();
  });

  it("says when a source did not answer in time, beside what the others found", () => {
    const model = buildTodayModel(fmt, signals({ unchecked: ["metering.connection"] }));
    expect(model.body.empty.title).toBe("Nothing needs you right now.");
    expect(model.notice).toEqual({ tone: "warning", text: "Some sources did not answer in time." });
  });

  it("says how many are shown when more were found", () => {
    const model = buildTodayModel(fmt, signals({ count: 34, top: [signal()] }));
    expect(model.notice).toEqual({ tone: "warning", text: "1 of 34 are shown: the most severe first, alarms first, then the soonest due." });
    const both = buildTodayModel(fmt, signals({ count: 34, top: [signal()], unchecked: ["payments.failed"] }));
    expect(both.notice).toEqual({ tone: "warning", text: "Some sources did not answer in time. 1 of 34 are shown: the most severe first, alarms first, then the soonest due." });
  });

  it("does not say nothing needs the person when the signals could not be collected", () => {
    const model = buildTodayModel(fmt, null);
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty.title).toBe(TODAY_COPY.failed);
    expect(model.body.empty.title).not.toBe(TODAY_COPY.nothing);
  });

  it("hands a proposal's action back as a link, for the host to resolve again", () => {
    const action: ActionRef = {
      action: "metering.backend",
      params: { id: MG },
      label: "Change the data source",
      enabled: true,
      prefill: { url: "https://example.invalid" },
      provenance: { by: "watcher", at: "2026-11-19T08:00:00Z" },
    };
    const model = buildTodayModel(fmt, signals({ count: 1, top: [signal({ kind: "proposal", action } as Partial<Signal>)] }));
    expect(model.body.rows[0].actions).toEqual([
      { action: "metering.backend", params: { id: MG }, label: "Change the data source", prefill: { url: "https://example.invalid" }, provenance: action.provenance },
    ]);
  });

  it("marks the details synthetic when a fact is, and shows a due time in UTC", () => {
    const model = buildTodayModel(fmt, signals({ count: 1, top: [signal({ due: "2026-11-01T09:00:00Z", facts: [{ ...fmt.text("a"), synthetic: true }] })] }));
    expect(model.body.rows[0].cells.details).toMatchObject({ t: "text", text: "a", synthetic: true });
    expect(model.body.rows[0].cells.due).toEqual(fmt.datetime("2026-11-01T09:00:00Z", "UTC"));
  });

  it("passes the host's strict parse, as the loader returns it", () => {
    for (const s of [signals({ count: 1, top: [signal({ due: "2026-11-01", facts: [fmt.text("x")] })] }), signals(), null]) {
      expect(strictParseModel(def, buildTodayModel(fmt, s)).ok).toBe(true);
    }
  });
});

describe("loadToday", () => {
  const req = (s: Signals | null | undefined) => ({ fmt, ...(s === undefined ? {} : { signals: s }) }) as unknown as SurfaceRequest;

  it("builds Today from the signals the host handed over, and reads nothing itself", async () => {
    const s = signals({ count: 1, top: [signal()] });
    expect(await loadToday(req(s))).toEqual({ ok: true, model: buildTodayModel(fmt, s) });
    expect(await loadToday(req(null))).toEqual({ ok: true, model: buildTodayModel(fmt, null) });
    // A request without signals is one the host collected none for.
    expect(await loadToday(req(undefined))).toEqual({ ok: true, model: buildTodayModel(fmt, null) });
  });
});

describe("the org.today view", () => {
  it("takes signals on the home page, polls nothing, attaches nowhere and is read by no assistant", () => {
    expect(def).toMatchObject({ path: "/", params: {}, kind: "collection", cost: "db", takesSignals: true });
    expect(def.live).toBeUndefined();
    expect(def.attach).toBeUndefined();
    expect(def.agent).toBeUndefined();
    expect(ORGANIZATION_DIRECTORY_SURFACE.nav?.find((n) => n.id === "org.today")).toMatchObject({ title: "Today", view: TODAY_VIEW });
  });

  it("has examples of signals, nothing to do, a source that did not answer, and signals not collected", () => {
    expect(TODAY_EXAMPLES.map((e) => [e.body.rows.length, e.body.empty.title, e.notice?.text])).toEqual([
      [3, TODAY_COPY.nothing, undefined],
      [0, TODAY_COPY.nothing, undefined],
      [1, TODAY_COPY.nothing, "Some sources did not answer in time. 1 of 2 are shown: the most severe first, alarms first, then the soonest due."],
      [0, TODAY_COPY.failed, undefined],
    ]);
    expect(TODAY_EXAMPLES[0].attached).toEqual([expect.objectContaining({ view: "billing.current-periods", hint: "tile" })]);
  });
});

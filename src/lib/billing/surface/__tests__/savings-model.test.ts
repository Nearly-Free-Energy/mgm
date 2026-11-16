/**
 * The `billing.savings` model: the savings table as tiles and the
 * `billing.savings@1` ext, in the setup, unavailable and ready states.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { SYNTHETIC_NOTICE } from "@/lib/gui/host/server/view";
import type { Value } from "@/lib/gui/contract";
import type { SavingsColumn, SavingsSummary } from "../../site-savings";
import { SAVINGS_EXAMPLES, SAVINGS_LOADED_EXAMPLES } from "../examples";
import { SavingsExt, type SavingsExtData } from "../savings-ext";
import {
  buildSavingsModel,
  GRID_TARIFF_ADD_ACTION,
  SAVINGS_EXT_SCHEMA,
  SAVINGS_KEYS,
  SAVINGS_SETTINGS_ACTION,
  savingsActions,
  type SavingsModelInput,
} from "../savings-model";

const fmt = createFmt({ locale: "en-GB" });
const col = (solarSavings: number | null, arbitrageGain: number | null, total: number | null, lightsOnPct: number | null): SavingsColumn => ({
  solarSavings,
  arbitrageGain,
  total,
  lightsOnPct,
  days: 1,
});
const SUMMARY: SavingsSummary = {
  columns: { day: col(660.4, null, 660.4, 98.25), month: col(3960, 120.5, 4080.5, 99), sinceStart: col(null, null, null, null) },
  sinceStartDate: "2026-10-01",
  missingTariffDays: 0,
};
type Ready = Extract<SavingsModelInput, { state: "ready" }>;
const ready = (o: Partial<Ready> = {}) =>
  buildSavingsModel({
    state: "ready",
    summary: SUMMARY,
    date: "2026-11-05",
    currency: "UGX",
    locale: "en-GB",
    fmt,
    solarFrom: "2026-10-01",
    arbitrageFrom: null,
    cappedFrom: null,
    solarEstimated: false,
    synthetic: false,
    actions: [],
    ...o,
  });
const tile = (model: ReturnType<typeof ready>, key: string) => model.body.tiles.find((t) => t.key === key)!;
const ext = (model: ReturnType<typeof ready>) => model.ext!.data as SavingsExtData;
const values = (model: ReturnType<typeof ready>): Value[] => model.body.tiles.flatMap((t) => [t.value, ...(t.status ? [t.status] : [])]);

describe("buildSavingsModel, ready", () => {
  it("emits one tile per column and row, only declared keys, labelled by row and column", () => {
    const model = ready();
    expect(model.body.tiles.map((t) => t.key)).toEqual(SAVINGS_KEYS.filter((k) => k !== "setup"));
    expect(tile(model, "day.solar").label).toBe("Solar savings, 5 Nov");
    expect(tile(model, "month.arbitrage").label).toBe("Arbitrage gain, November so far");
    expect(tile(model, "since.total").label).toBe("Total saved, since 1 Oct 2026");
    expect(tile(model, "day.lights-on").label).toBe("Lights on, 5 Nov");
    expect(model.title).toBe("What the site saved");
    expect(model.ext!.schema).toBe(SAVINGS_EXT_SCHEMA);
  });

  it("gives money in integer minor units, rounded as the text, and marks it estimated", () => {
    const model = ready();
    expect(tile(model, "day.solar").value).toEqual({ t: "money", v: 660, currency: "UGX", text: expect.stringMatching(/^UGX\s660$/), derived: true });
    const usd = ready({ currency: "USD" });
    expect(tile(usd, "day.solar").value).toMatchObject({ t: "money", v: 66040, currency: "USD", text: expect.stringContaining("660.40"), derived: true });
  });

  it("puts each row's own figure in its tile", () => {
    // USD, so no figure rounds into another.
    const model = ready({ currency: "USD" });
    expect(tile(model, "month.solar").value).toMatchObject({ t: "money", v: 396000 });
    expect(tile(model, "month.arbitrage").value).toMatchObject({ t: "money", v: 12050 });
    expect(tile(model, "month.total").value).toMatchObject({ t: "money", v: 408050, derived: true });
    expect(tile(model, "month.lights-on").value).toMatchObject({ t: "percent", v: 99 });
  });

  it("gives lights on with one decimal, not estimated", () => {
    expect(tile(ready(), "day.lights-on").value).toEqual({ t: "percent", v: 98.25, text: "98.3%" });
    expect(tile(ready(), "month.lights-on").value.text).toBe("99.0%");
  });

  it("shows a missing figure as an empty value, never zero", () => {
    const model = ready();
    for (const key of ["day.arbitrage", "since.solar", "since.total", "since.lights-on"]) {
      expect(tile(model, key).value, key).toEqual({ t: "empty", text: "—" });
    }
  });

  it("carries the table's headings and row copy", () => {
    const data = ext(ready());
    expect(data).toMatchObject({
      state: "ready",
      synthetic: false,
      columns: [
        { id: "day", label: "5 Nov", sub: null },
        { id: "month", label: "November so far", sub: null },
        { id: "since", label: "Since start", sub: "from 1 Oct 2026" },
      ],
      rows: [
        { id: "solar", label: "Solar savings ≈", sub: "valued at the grid rate of each hour, since 1 Oct 2026", strong: false },
        { id: "arbitrage", label: "Arbitrage gain ≈", sub: "not counted: no start date set", strong: false },
        { id: "total", label: "Total saved", sub: null, strong: true },
        { id: "lights-on", label: "Lights on (%)", sub: null, strong: false },
      ],
      warnings: [],
    });
    const both = ext(ready({ arbitrageFrom: "2026-09-10", solarFrom: null }));
    expect(both.state === "ready" && both.rows.map((r) => r.sub)).toEqual(["not counted: no start date set", "since 10 Sept 2026", null, null]);
  });

  it("has no since-start date line when neither saving has one", () => {
    const data = ext(ready({ summary: { ...SUMMARY, sinceStartDate: null } }));
    expect(data.state === "ready" && data.columns[2]).toEqual({ id: "since", label: "Since start", sub: null });
    expect(tile(ready({ summary: { ...SUMMARY, sinceStartDate: null } }), "since.solar").label).toBe("Solar savings, since start");
  });

  it("warns of days with no tariff and of the one-year cap", () => {
    const one = ext(ready({ summary: { ...SUMMARY, missingTariffDays: 1 } }));
    expect(one.state === "ready" && one.warnings).toEqual(["1 day had no grid tariff in force and is left out of the money figures."]);
    const many = ext(ready({ summary: { ...SUMMARY, missingTariffDays: 4 }, cappedFrom: "2025-11-06" }));
    expect(many.state === "ready" && many.warnings).toEqual([
      "4 days had no grid tariff in force and are left out of the money figures.",
      "Since start covers at most a year: days before 6 Nov 2025 are not read.",
    ]);
  });

  it("adds the estimated-solar clause to the notes only when a day's solar was estimated", () => {
    const plain = ext(ready());
    const estimated = ext(ready({ solarEstimated: true }));
    expect(plain.state === "ready" && plain.notes).toHaveLength(3);
    // As site-savings.ts counts: only energy the site used itself.
    expect(plain.state === "ready" && plain.notes[0]).toContain("every kWh of solar the site used itself, by its load or to charge the battery");
    expect(plain.state === "ready" && plain.notes[0]).toContain("Solar sent to the grid saves nothing.");
    expect(plain.state === "ready" && plain.notes[1]).toContain("each kWh it gave the site while the grid was on");
    expect(plain.state === "ready" && plain.notes[1]).toContain("Power the battery sent to the grid saves nothing.");
    expect(plain.state === "ready" && plain.notes[0]).not.toContain("estimated");
    expect(estimated.state === "ready" && estimated.notes[0]).toContain(
      "(solar is estimated from the load, grid and battery where there is no solar meter).",
    );
  });

  it("marks every value and the ext synthetic when a day read was generated", () => {
    const model = ready({ synthetic: true });
    expect(values(model).every((v) => v.synthetic === true)).toBe(true);
    expect(ext(model).synthetic).toBe(true);
    expect(values(ready()).some((v) => v.synthetic)).toBe(false);
  });

  it("parses with SavingsExt", () => {
    for (const model of [ready(), ready({ synthetic: true, cappedFrom: "2025-11-06", solarEstimated: true })]) {
      expect(SavingsExt.safeParse(model.ext!.data).success).toBe(true);
    }
  });
});

describe("buildSavingsModel, setup and unavailable", () => {
  it("shows the setup note and its link to Setup > Rates", () => {
    const model = buildSavingsModel({ state: "setup", microgridId: "mg 1", fmt, actions: [] });
    expect(model.body.tiles).toEqual([
      { key: "setup", label: "Count what the site saves", value: { t: "text", text: expect.stringContaining("Enter the grid tariff") } },
    ]);
    expect(model.links).toEqual([{ id: "billing.setup-rates", label: "Go to Setup > Rates", href: "/microgrids/mg%201/setup/rates" }]);
    expect(model.ext!.data).toMatchObject({ state: "setup", synthetic: false, title: "Count what the site saves" });
  });

  it("has no figures when the day above explains why", () => {
    const model = buildSavingsModel({ state: "unavailable" });
    expect(model.body.tiles).toEqual([]);
    expect(model.links).toEqual([]);
    expect(model.ext!.data).toEqual({ state: "unavailable", synthetic: false });
  });
});

const MG = "00000000-0000-4000-8000-0000000000b1";

describe("savingsActions", () => {
  it("starts the settings form from the stored settings, and the tariff form from the newest bands in hour order", () => {
    const bands = [
      { from_hour: 18, to_hour: 24, rate: 910 },
      { from_hour: 0, to_hour: 18, rate: 600 },
    ];
    const settings = { solar_savings_from: "2026-10-01", arbitrage_from: null, round_trip_efficiency: 0.85 };
    expect(savingsActions(MG, settings, bands)).toEqual([
      { action: "billing.savings-settings", params: { id: MG }, prefill: settings },
      {
        action: "billing.grid-tariff-add",
        params: { id: MG },
        prefill: { bands: [bands[1], bands[0]] },
      },
    ]);
    // The stored list is not reordered.
    expect(bands[0].from_hour).toBe(18);
  });

  it("starts with nothing counted and the Rates page's efficiency when nothing is stored, and with no tariff bands", () => {
    expect(savingsActions(MG, null, null)).toEqual([
      {
        action: SAVINGS_SETTINGS_ACTION.id,
        params: { id: MG },
        prefill: { solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: 0.9 },
      },
      { action: GRID_TARIFF_ADD_ACTION.id, params: { id: MG } },
    ]);
  });

  it("are offered in the setup and ready states, and not when the day above explains", () => {
    const actions = savingsActions(MG, null, null);
    expect(buildSavingsModel({ state: "setup", microgridId: MG, fmt, actions }).actions).toEqual(actions);
    expect(ready({ actions }).actions).toEqual(actions);
    expect(ready({ actions, synthetic: true }).actions).toEqual(actions);
    expect(buildSavingsModel({ state: "unavailable" }).actions).toEqual([]);
  });
});

describe("SAVINGS_EXAMPLES", () => {
  it("covers each state, parses with SavingsExt, and carries the host's synthetic notice where it is", () => {
    expect(SAVINGS_LOADED_EXAMPLES.map((m) => (m.ext!.data as SavingsExtData).state)).toEqual(["ready", "setup", "unavailable"]);
    for (const example of SAVINGS_EXAMPLES) {
      expect(SavingsExt.safeParse(example.ext!.data).success).toBe(true);
      expect(example.view).toBe("billing.savings");
    }
    expect(SAVINGS_EXAMPLES.map((e) => e.notice ?? null)).toEqual([SYNTHETIC_NOTICE, null, null]);
  });

  it("offer both actions, enabled and labelled as the host resolves them, in the setup and ready states", () => {
    const offered = SAVINGS_EXAMPLES.map((e) => e.actions.map((a) => [a.action, a.label, a.enabled]));
    const both = [
      ["billing.savings-settings", "Edit savings settings", true],
      ["billing.grid-tariff-add", "Add a grid tariff version", true],
    ];
    expect(offered).toEqual([both, both, []]);
  });
});

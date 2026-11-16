/**
 * savings-model.ts — what a site's solar and battery saved, as a `metrics`
 * view model.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here. Each figure is a tile keyed `<column>.<row>`; the table's headings, warnings and notes go in the
 * `billing.savings@1` ext (./savings-ext.ts) for a renderer that draws the
 * table. The setup and ready states also offer the writes that change what
 * is counted (`savingsActions`).
 */
import { formatRate } from "@/components/format/currency";
import { formatLocalDate } from "@/components/format/local-date";
import type { LinkRef, Value } from "@/lib/gui/contract";
import { markSynthetic } from "@/lib/gui/mark-synthetic";
import type { ActionLink, Fmt, LoadedModel } from "@/lib/gui/surface";
import type { GridTariffBand } from "@/lib/types/domain";
import { DEFAULT_ROUND_TRIP_EFFICIENCY, type SavingsColumn, type SavingsSettingsInput, type SavingsSummary } from "../site-savings";
import type { SavingsExtData } from "./savings-ext";

/** The ext this model carries; its shape is SavingsExt in ./savings-ext.ts. */
export const SAVINGS_EXT_SCHEMA = "billing.savings@1" as const;
export const SAVINGS_COLUMNS = ["day", "month", "since"] as const;
export const SAVINGS_ROWS = ["solar", "arbitrage", "total", "lights-on"] as const;
/** Every tile key the view emits: one per column and row, and the setup note. */
export const SAVINGS_KEYS = [
  ...SAVINGS_COLUMNS.flatMap((c) => SAVINGS_ROWS.map((r) => `${c}.${r}` as const)),
  "setup",
] as const;

export const SAVINGS_TITLE = "What the site saved";

/** The billing actions the view offers; BILLING_SURFACE (../surface.ts) defines them. */
export const SAVINGS_SETTINGS_ACTION = { id: "billing.savings-settings", title: "Edit savings settings" } as const;
export const GRID_TARIFF_ADD_ACTION = { id: "billing.grid-tariff-add", title: "Add a grid tariff version" } as const;

/**
 * The two writes, on the microgrid. The settings form starts from the stored
 * settings, or the Rates page's default efficiency; the tariff form starts
 * from the newest version's bands, with no date.
 */
export function savingsActions(
  microgridId: string,
  settings: SavingsSettingsInput | null,
  newestBands: readonly GridTariffBand[] | null,
): ActionLink[] {
  const stored = settings ?? { solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: DEFAULT_ROUND_TRIP_EFFICIENCY };
  const bands = newestBands && [...newestBands].sort((a, b) => a.from_hour - b.from_hour);
  return [
    {
      action: SAVINGS_SETTINGS_ACTION.id,
      params: { id: microgridId },
      prefill: {
        solar_savings_from: stored.solar_savings_from,
        arbitrage_from: stored.arbitrage_from,
        round_trip_efficiency: stored.round_trip_efficiency,
      },
    },
    {
      action: GRID_TARIFF_ADD_ACTION.id,
      params: { id: microgridId },
      ...(bands ? { prefill: { bands: bands.map((b) => ({ from_hour: b.from_hour, to_hour: b.to_hour, rate: b.rate })) } } : {}),
    },
  ];
}

type Tile = LoadedModel<"metrics">["body"]["tiles"][number];
type Row = (typeof SAVINGS_ROWS)[number];

export type SavingsModelInput =
  | { state: "setup"; microgridId: string; fmt: Fmt; actions: ActionLink[] }
  | { state: "unavailable" }
  | {
      state: "ready";
      /** From savingsActions. */
      actions: ActionLink[];
      summary: SavingsSummary;
      /** The day shown, YYYY-MM-DD. */
      date: string;
      currency: string;
      locale: string;
      fmt: Fmt;
      /** The savings settings' start dates; null when that saving is not counted. */
      solarFrom: string | null;
      arbitrageFrom: string | null;
      /** First day read when the range was cut short; null when it was not. */
      cappedFrom: string | null;
      /** True when any day's solar is estimated from the balance rather than metered. */
      solarEstimated: boolean;
      /** True when any day read was generated rather than measured. */
      synthetic: boolean;
    };

const SHORT_DAY = { day: "numeric", month: "short" } as const;
const FULL_DAY = { day: "numeric", month: "short", year: "numeric" } as const;
const NOT_COUNTED = "not counted: no start date set";
const ROW_NAMES: Record<Row, string> = {
  solar: "Solar savings",
  arbitrage: "Arbitrage gain",
  total: "Total saved",
  "lights-on": "Lights on",
};

function base(tiles: Tile[], ext: SavingsExtData, links: LinkRef[] = [], actions: ActionLink[] = []): LoadedModel<"metrics"> {
  return { title: SAVINGS_TITLE, body: { tiles }, actions, links, ext: { schema: SAVINGS_EXT_SCHEMA, data: ext } };
}

export function buildSavingsModel(input: SavingsModelInput): LoadedModel<"metrics"> {
  if (input.state === "unavailable") return base([], { state: "unavailable", synthetic: false });
  if (input.state === "setup") {
    const title = "Count what the site saves";
    const text =
      "Enter the grid tariff (what the utility charges per kWh at each hour) and the day from which to count solar savings or arbitrage. This view then shows what the solar and the battery saved.";
    const href = `/microgrids/${encodeURIComponent(input.microgridId)}/setup/rates` as const;
    return base([{ key: "setup", label: title, value: input.fmt.text(text) }], { state: "setup", synthetic: false, title, text }, [
      { id: "billing.setup-rates", label: "Go to Setup > Rates", href },
    ], input.actions);
  }

  const { summary, date, currency, locale, fmt } = input;
  // Calendar days are YYYY-MM-DD keys, so they are formatted at UTC midnight in UTC.
  const day = (key: string, opts: Intl.DateTimeFormatOptions) =>
    formatLocalDate(new Date(`${key}T00:00:00Z`), locale, { ...opts, timeZone: "UTC" });
  const money = (v: number | null): Value => (v === null ? fmt.empty() : { ...fmt.money(v, currency), derived: true });
  // One decimal, which Fmt.percent does not offer.
  const percent = (v: number | null): Value =>
    v === null ? fmt.empty() : { ...fmt.percent(v), text: `${formatRate(v, locale, { minDigits: 1, maxDigits: 1 })}%` };
  const cell: Record<Row, (c: SavingsColumn) => Value> = {
    solar: (c) => money(c.solarSavings),
    arbitrage: (c) => money(c.arbitrageGain),
    total: (c) => money(c.total),
    "lights-on": (c) => percent(c.lightsOnPct),
  };

  const since = summary.sinceStartDate;
  const shortDay = day(date, SHORT_DAY);
  const month = `${day(date, { month: "long" })} so far`;
  // Each column's heading, and the phrase that names it in a tile's label.
  const columns: { id: (typeof SAVINGS_COLUMNS)[number]; data: SavingsColumn; label: string; sub: string | null; phrase: string }[] = [
    { id: "day", data: summary.columns.day, label: shortDay, sub: null, phrase: shortDay },
    { id: "month", data: summary.columns.month, label: month, sub: null, phrase: month },
    {
      id: "since",
      data: summary.columns.sinceStart,
      label: "Since start",
      sub: since ? `from ${day(since, FULL_DAY)}` : null,
      phrase: since ? `since ${day(since, FULL_DAY)}` : "since start",
    },
  ];
  const tiles: Tile[] = columns.flatMap((c) =>
    SAVINGS_ROWS.map((r) => ({ key: `${c.id}.${r}`, label: `${ROW_NAMES[r]}, ${c.phrase}`, value: cell[r](c.data) })),
  );

  const missing = summary.missingTariffDays;
  const warnings = [
    ...(missing > 0
      ? [`${missing === 1 ? "1 day" : `${missing} days`} had no grid tariff in force and ${missing === 1 ? "is" : "are"} left out of the money figures.`]
      : []),
    ...(input.cappedFrom ? [`Since start covers at most a year: days before ${day(input.cappedFrom, FULL_DAY)} are not read.`] : []),
  ];
  const ext: SavingsExtData = {
    state: "ready",
    synthetic: input.synthetic,
    columns: columns.map(({ id, label, sub }) => ({ id, label, sub })),
    rows: [
      {
        id: "solar",
        label: "Solar savings ≈",
        sub: input.solarFrom ? `valued at the grid rate of each hour, since ${day(input.solarFrom, FULL_DAY)}` : NOT_COUNTED,
        strong: false,
      },
      {
        id: "arbitrage",
        label: "Arbitrage gain ≈",
        sub: input.arbitrageFrom ? `since ${day(input.arbitrageFrom, FULL_DAY)}` : NOT_COUNTED,
        strong: false,
      },
      { id: "total", label: "Total saved", sub: null, strong: true },
      { id: "lights-on", label: "Lights on (%)", sub: null, strong: false },
    ],
    warnings,
    notes: [
      `Solar savings is every kWh of solar the site used itself, by its load or to charge the battery, priced at what the grid would have charged for it at that hour${
        input.solarEstimated ? " (solar is estimated from the load, grid and battery where there is no solar meter)" : ""
      }. Solar sent to the grid saves nothing.`,
      "Arbitrage gain is the battery charging when power is cheap and discharging when it is dear: each kWh it gave the site while the grid was on, at that hour's rate, less what it cost to put in, allowing for the energy the battery loses. Power the battery sent to the grid saves nothing. Power the battery gave during a cut is backup and is not counted. A day with too few battery readings is left out.",
      "Solar that charged the battery appears in both lines, as a saving and as a charging cost, so the total is the figure to rely on. Lights on is the share of the time with a known state that the houses had power.",
    ],
  };
  const model = base(tiles, ext, [], input.actions);
  return input.synthetic ? markSynthetic(model) : model;
}

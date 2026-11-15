/**
 * Hand-built `metering.site-day@1` models, shaped as the server builds them
 * (src/lib/metering/surface/site-day-model.ts, which these tests may not
 * import): the legacy page's test day of 5 November 2026, with today the 7th.
 * Each tile's text is the copy that builder writes for it.
 */
import type { ActionRef, Href, Json, LinkRef, ModelOf, Value } from "@/lib/gui/contract";
import type { Tile } from "../tiles";

/** A uuid, so the host's merge offers acme.poke on it. */
export const MG = "00000000-0000-4000-8000-0000000000b1";
export const DAY_HREF = `/microgrids/${MG}/operations` as const;
export const DATE = "2026-11-05";
export const TODAY = "2026-11-07";
export const SYNTHETIC_NOTICE = { tone: "warning", text: "Synthetic data: these figures are generated for demonstration, not measured." } as const;

export const text = (t: string): Value => ({ t: "text", text: t });
export const empty: Value = { t: "empty", text: "—" };
export const kwh = (v: number, t: string, derived?: true): Value => ({ t: "energy", v: v * 1000, unit: "Wh", text: t, ...(derived ? { derived } : {}) });
export const pct = (v: number, t: string): Value => ({ t: "percent", v, text: t });
export const num = (v: number, t: string, unit?: string): Value => ({ t: "number", v, text: t, ...(unit ? { unit } : {}) });
export const status = (v: string, tone: "warning" | "danger", t: string): Value => ({ t: "status", v, tone, text: t });

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const href = (date: string) => `${DAY_HREF}?date=${date}` as Href;

/** The links the server sends: previous always, next and today only before today. */
export function dayLinks(date: string, today: string): LinkRef[] {
  const next = addDays(date, 1);
  return [
    { id: "metering.day-previous", label: "Previous day", href: href(addDays(date, -1)) },
    ...(next <= today ? [{ id: "metering.day-next" as const, label: "Next day", href: href(next) }] : []),
    ...(date !== today ? [{ id: "metering.day-today" as const, label: "Today", href: href(today) }] : []),
  ];
}

export const TILES: Tile[] = [
  { key: "solar", label: "Solar", value: kwh(12.34, "12.3 kWh"), hint: "Solar meter" },
  { key: "houses-evening", label: "Houses used 18:00–24:00", value: kwh(3.21, "3.2 kWh"), hint: "Battery supplied 4.6 kWh" },
  { key: "battery-evening", label: "Battery supplied 18:00–24:00", value: kwh(4.56, "4.6 kWh") },
  { key: "cuts", label: "Power cuts", value: num(2, "2"), hint: `Cuts / time without grid power`, status: status("cut", "warning", "Grid cuts") },
  { key: "cut-time", label: `Time without grid power`, value: num(250, "4h 10m", "min") },
  { key: "lowest-soc", label: "Lowest battery", value: pct(12.4, "12%"), hint: "At 05:30, in a cut", status: status("floor", "warning", "At the floor") },
  { key: "soc-17", label: "Battery at 17:00", value: pct(63.6, "64%"), hint: "Before the evening window" },
  { key: "lights-on", label: "Lights on", value: pct(95.83, "95.8%"), hint: "Dark 1h 0m", status: status("dark", "danger", "Houses dark") },
  { key: "evening-supply", label: "Who served the houses, 18:00–24:00", value: text(`Battery 3.0 h · Battery + grid 1.0 h · Grid alone 1.0 h · Dark 1.0 h`) },
];

export const NOTES = [
  `A power cut is any grid phase below 170 V over a 15-minute reading. Dark means the gateway went silent during a cut: the battery had cut off and the houses had no power. When it went silent with the battery at or below 15%, the houses are taken to be dark and the grid off, since the gateway cannot outlive the battery; that time is shown as inferred. Lights on is the share of the day that was not dark, leaving out time with no data. Times are Africa/Kampala.`,
];

type Options = {
  date?: string;
  today?: string;
  subtitle?: string;
  /** Replaces fields of the tiles with these keys; `null` removes a field. */
  tiles?: Record<string, Partial<Record<keyof Tile, Tile[keyof Tile] | null>>>;
  notes?: string[];
  synthetic?: boolean;
  actions?: ActionRef[];
  links?: LinkRef[];
  ext?: Record<string, Json>;
} & Partial<Pick<ModelOf<"metrics">, "notice" | "attached">>;

function withTile(tile: Tile, change: Options["tiles"]): Tile {
  const fields = change?.[tile.key];
  if (!fields) return tile;
  const next: Record<string, unknown> = { ...tile };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as Tile;
}

const synthetic = (v: Value): Value => ({ ...v, synthetic: true });

/** A day as the loader returns it after the host fills its fields. */
export function dayModel(o: Options = {}): ModelOf<"metrics"> {
  const date = o.date ?? DATE;
  const today = o.today ?? TODAY;
  let tiles = TILES.map((t) => withTile(t, o.tiles));
  if (o.synthetic) tiles = tiles.map((t) => ({ ...t, value: synthetic(t.value), ...(t.status ? { status: synthetic(t.status) } : {}) }));
  return {
    type: "view",
    view: "metering.site-day",
    kind: "metrics",
    title: "Operations",
    subtitle: o.subtitle ?? "Thu, 05 Nov 2026 · Africa/Kampala",
    org: "o1",
    entity: { kind: "microgrid", id: MG, label: "East" },
    trail: [],
    body: { tiles },
    actions: o.actions ?? [],
    links: o.links ?? dayLinks(date, today),
    attached: o.attached ?? [],
    ...(o.notice ? { notice: o.notice } : {}),
    ext: {
      schema: "metering.site-day@1",
      data: {
        state: "day",
        date,
        today,
        timezone: "Africa/Kampala",
        dayHref: DAY_HREF,
        synthetic: o.synthetic === true,
        partial: false,
        notes: o.notes ?? NOTES,
        ...o.ext,
      },
    },
  };
}

/** The microgrid with none of its site meters registered. */
export function noSiteDevicesModel(o: Pick<Options, "date" | "today" | "actions"> = {}): ModelOf<"metrics"> {
  const date = o.date ?? DATE;
  const today = o.today ?? TODAY;
  const message =
    `This view reads the site's battery and grid meter from OpenEMS. Discover them on the microgrid's edge and set their types to Battery and Grid meter. For a solar estimate, also set the meter on the inverter's output to Inverter.`;
  return {
    ...dayModel({ date, today, actions: o.actions }),
    body: { tiles: [{ key: "setup", label: `Register the battery and grid meter`, value: text(message) }] },
    links: [{ id: "metering.edges", label: "Go to Edges", href: `/microgrids/${MG}/setup/edges` }, ...dayLinks(date, today)],
    ext: {
      schema: "metering.site-day@1",
      data: { state: "no-site-devices", date, today, timezone: "Africa/Kampala", dayHref: DAY_HREF, synthetic: false, title: `Register the battery and grid meter`, message },
    },
  };
}

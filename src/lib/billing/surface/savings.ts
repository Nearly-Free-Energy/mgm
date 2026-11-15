import "server-only";

/**
 * The loader of the `billing.savings` view: what a microgrid's solar and
 * battery saved for a day, its month so far and since the savings were
 * first counted, valued by ../site-savings.ts over the days savingsReadRange
 * picks.
 *
 * A refusal carries fixed copy chosen by its status and code, never a
 * database or capability message.
 */
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { composeMetering } from "@/lib/metering/compose";
import { resolveRequestedDay } from "@/lib/timezone/requested-day";
import type { GridTariffBand } from "@/lib/types/domain";
import { savingsReadRange, valueSiteDays, type SavingsSettingsInput, type TariffInput } from "../site-savings";
import { buildSavingsModel, savingsActions } from "./savings-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const SAVINGS_REFUSALS = {
  forbidden: { ok: false, status: 403, message: "You do not have access to this microgrid's savings." },
  notFound: { ok: false, status: 404, message: "This microgrid could not be found." },
  failed: { ok: false, status: 500, message: "Could not work out the savings." },
  settings: { ok: false, status: 503, message: "Could not load the savings settings" },
  unavailable: { ok: false, status: 503, message: "Could not work out the savings right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/**
 * A capability failure other than the ones the day above explains. The
 * metering source's codes come first, since its 401 or 403 is OpenEMS
 * refusing the stored settings, not the person.
 */
export function savingsRefusal({ status, code }: { status: number; code: string }): Refusal {
  if (code.startsWith("METERING_")) return SAVINGS_REFUSALS.unavailable;
  if (status === 401 || status === 403) return SAVINGS_REFUSALS.forbidden;
  if (status >= 400 && status < 500) return SAVINGS_REFUSALS.notFound;
  if (status === 500) return SAVINGS_REFUSALS.failed;
  return SAVINGS_REFUSALS.unavailable;
}

/**
 * The failures the `metering.site-day` view above this one already shows
 * with what to do about them: no battery or grid meter, every 409 (Metering
 * off, mixed synthetic and real edges), and no usable or a rejected OpenEMS
 * connection, which the day links to Setup > OpenEMS Backend (siteDayProblem
 * in src/lib/metering/surface/site-day-model.ts). Saying it twice is noise,
 * so the savings draw nothing. A passing source failure still refuses here:
 * the range read can fail when the day's read did not. If that view stops
 * showing one of these, or getSiteDays gains another 409, revisit.
 */
const explainedAbove = (f: { status: number; code: string }) =>
  f.code === "metering_no_site_devices" ||
  f.status === 409 ||
  f.code === "METERING_CONFIGURATION" ||
  f.code === "METERING_UNAUTHORIZED";

const ready = (model: LoadedModel<"metrics">) => ({ ok: true, model }) as const;

export async function loadSavings(req: SurfaceRequest): Promise<Loaded<LoadedModel<"metrics">>> {
  // The person's own client (row-level security), as the metering.site-day
  // loader reads: both savings tables are FOR ALL on
  // user_can_access_microgrid. If their policies change, revisit what this
  // shows.
  const id = req.params.id;
  const { data: microgrid, error } = await req.supabase
    .from("microgrids")
    .select("id, timezone, currency")
    .eq("id", id)
    .maybeSingle<{ id: string; timezone: string | null; currency: string }>();
  if (error) return SAVINGS_REFUSALS.unavailable;
  if (!microgrid) return SAVINGS_REFUSALS.notFound;

  const [tariffsRes, settingsRes] = await Promise.all([
    req.supabase
      .from("grid_tariffs")
      .select("effective_from, bands")
      .eq("microgrid_id", microgrid.id)
      .order("effective_from", { ascending: true }),
    req.supabase
      .from("microgrid_savings_settings")
      .select("solar_savings_from, arbitrage_from, round_trip_efficiency")
      .eq("microgrid_id", microgrid.id)
      .maybeSingle(),
  ]);
  if (tariffsRes.error || settingsRes.error) return SAVINGS_REFUSALS.settings;

  const tariffs: TariffInput[] = ((tariffsRes.data ?? []) as { effective_from: string; bands: unknown }[]).map((t) => ({
    effective_from: t.effective_from,
    bands: t.bands as GridTariffBand[],
  }));
  const row = settingsRes.data as { solar_savings_from: string | null; arbitrage_from: string | null; round_trip_efficiency: number | string } | null;
  const settings: SavingsSettingsInput | null = row
    ? { solar_savings_from: row.solar_savings_from, arbitrage_from: row.arbitrage_from, round_trip_efficiency: Number(row.round_trip_efficiency) }
    : null;
  // The newest version, whatever order the rows came in.
  const newest = tariffs.reduce<TariffInput | null>((a, t) => (!a || t.effective_from > a.effective_from ? t : a), null);
  const actions = savingsActions(microgrid.id, settings, newest?.bands ?? null);
  if (!settings || (!settings.solar_savings_from && !settings.arbitrage_from) || tariffs.length === 0) {
    return ready(buildSavingsModel({ state: "setup", microgridId: microgrid.id, fmt: req.fmt, actions }));
  }

  // The host passes on the Operations page's ?date= (query on both views).
  // With none, this works out yesterday itself, in a request made after the
  // day drew, so across the site's midnight it can value a day after the one
  // shown above. If the host comes to pass on the day the metering.site-day
  // loader resolved, that gap closes.
  const { date } = resolveRequestedDay({ requested: req.search.getAll("date"), stored: microgrid.timezone, now: req.now });
  const { start, capped } = savingsReadRange(date, settings);
  const composed = await composeMetering({ supabase: req.supabase, organizationId: req.organizationId });
  if (!composed.ok) return explainedAbove(composed) ? ready(buildSavingsModel({ state: "unavailable" })) : savingsRefusal(composed);
  try {
    const days = await composed.data.metering.getSiteDays({ microgrid_id: microgrid.id, start_date: start, end_date: date });
    if (!days.ok) return explainedAbove(days) ? ready(buildSavingsModel({ state: "unavailable" })) : savingsRefusal(days);
    return ready(
      buildSavingsModel({
        state: "ready",
        actions,
        // Only the summary goes into the model; the days and their per-bin flows stay here.
        summary: valueSiteDays({ days: days.data, tariffs, settings, date }),
        date,
        currency: microgrid.currency,
        locale: req.locale,
        fmt: req.fmt,
        solarFrom: settings.solar_savings_from,
        arbitrageFrom: settings.arbitrage_from,
        cappedFrom: capped ? start : null,
        solarEstimated: days.data.some((d) => d.solarEstimated),
        synthetic: days.data.some((d) => d.synthetic === true),
      }),
    );
  } finally {
    await composed.data.dispose();
  }
}

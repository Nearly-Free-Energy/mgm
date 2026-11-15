import "server-only";

/**
 * The loader of the `metering.site-day` view: one local day of a microgrid's
 * battery, grid and supply, read through the metering capability for the
 * request's organization.
 *
 * When the metering source cannot read the day, the view still loads: it
 * keeps the day navigation and shows the problem with the link to its fix,
 * or another try. Anything else that goes wrong refuses the view. Both carry
 * fixed copy chosen by status and code, never the capability's message,
 * which can carry text from an outside system.
 */
import type { LinkRef } from "@/lib/gui/contract";
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { timezoneNudge } from "@/lib/timezone/nudge";
import { resolveRequestedDay } from "@/lib/timezone/requested-day";
import { composeMetering } from "../compose";
import { buildNoSiteDevicesModel, buildSiteDayModel, buildSiteDayProblemModel, siteDayProblem } from "./site-day-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const SITE_DAY_REFUSALS = {
  forbidden: { ok: false, status: 403, message: "You do not have access to this microgrid's operations." },
  notFound: { ok: false, status: 404, message: "This microgrid could not be found." },
  disabled: {
    ok: false,
    status: 409,
    message: "Metering is disabled for this organization. Enable it in Settings → Plugins.",
  },
  failed: { ok: false, status: 500, message: "This day's operations could not be loaded." },
  unavailable: { ok: false, status: 503, message: "This day's operations could not be loaded right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/**
 * A capability failure that is not the metering source's as this view's
 * refusal. A 401 means the session ended after the host checked it, so it
 * reads as 403, and any other 4xx reads as 404.
 */
export function siteDayRefusal(failure: { status: number; code: string }): Refusal {
  const { status, code } = failure;
  if (code === "metering_disabled") return SITE_DAY_REFUSALS.disabled;
  if (status === 401 || status === 403) return SITE_DAY_REFUSALS.forbidden;
  if (status >= 400 && status < 500) return SITE_DAY_REFUSALS.notFound;
  if (status === 500) return SITE_DAY_REFUSALS.failed;
  return SITE_DAY_REFUSALS.unavailable;
}

/**
 * The day's link to a page that holds the microgrid's Edit button and time
 * zone nudge: the microgrid layout (src/app/(gui)/microgrids/[id]/layout.tsx)
 * shows both above the Setup pages. If they move off that layout, revisit.
 * A state whose own link already goes to a Setup page (the setup state's
 * Edges, a problem's fix) needs none.
 */
export function withSetupLink(model: LoadedModel<"metrics">, microgridId: string): LoadedModel<"metrics"> {
  const link: LinkRef = {
    id: "metering.microgrid-setup",
    label: "Microgrid setup",
    href: `/microgrids/${encodeURIComponent(microgridId)}/setup/edges`,
  };
  return { ...model, links: [...(model.links ?? []), link] };
}

type MicrogridRow = {
  id: string;
  name: string;
  timezone: string | null;
  address_country: string | null;
  lat: number | null;
  lng: number | null;
};

export async function loadSiteDay(req: SurfaceRequest): Promise<Loaded<LoadedModel<"metrics">>> {
  // Through row-level security. The host resolved this microgrid to
  // req.organizationId first (resolveSegments in dispatchView), and getSiteDay
  // checks the organization again; if both stop doing so, revisit. The
  // address columns are the time zone nudge's; all are in MICROGRID_PUBLIC_COLUMNS.
  const { data: microgrid, error } = await req.supabase
    .from("microgrids")
    .select("id, name, timezone, address_country, lat, lng")
    .eq("id", req.params.id)
    .maybeSingle<MicrogridRow>();
  if (error) return SITE_DAY_REFUSALS.unavailable;
  if (!microgrid) return SITE_DAY_REFUSALS.notFound;

  const { timezone, today, date } = resolveRequestedDay({
    requested: req.search.getAll("date"),
    stored: microgrid.timezone,
    now: req.now,
  });
  const nudge = timezoneNudge(microgrid, req.now);
  const composed = await composeMetering({ supabase: req.supabase, organizationId: req.organizationId });
  if (!composed.ok) return siteDayRefusal(composed);
  try {
    const day = await composed.data.metering.getSiteDay({ microgrid_id: microgrid.id, date });
    if (day.ok) {
      const model = buildSiteDayModel(day.data, { microgrid, today, locale: req.locale, fmt: req.fmt, nudge });
      return { ok: true, model: withSetupLink(model, microgrid.id) };
    }
    const base = { microgrid, date, today, timezone, locale: req.locale, fmt: req.fmt, nudge };
    if (day.code === "metering_no_site_devices") return { ok: true, model: buildNoSiteDevicesModel(base) };
    const problem = siteDayProblem(day);
    if (!problem) return siteDayRefusal(day);
    const model = buildSiteDayProblemModel({ ...base, problem });
    return { ok: true, model: problem.link ? model : withSetupLink(model, microgrid.id) };
  } finally {
    await composed.data.dispose();
  }
}

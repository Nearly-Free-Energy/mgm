/**
 * periods-model.ts — a microgrid's billing periods, as a `collection` view
 * model (`billing.periods`), with period creation and draft deletion.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here. The columns and empty-state copy are the legacy
 * periods list's (src/components/BillingPeriodList.tsx), which this view
 * replaced at the Billing path; the component stays until #201's Deletes
 * pull request. The host's catch-all serves this view outside the microgrid
 * layout, so the view repeats that layout's time zone nudge as its notice,
 * in the nudge's own copy (src/lib/timezone/nudge.ts). The host shows its
 * own notices (the gate's while billing is off) before this one, not in its
 * place (shownNotice in src/lib/gui/host/server/view.ts), so the nudge and
 * its Set timezone link stay together; if the host starts replacing a
 * loader's notice again, drop the link with it.
 */
import type { LinkRef } from "@/lib/gui/contract";
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import type { TimezoneNudgeCopy } from "@/lib/timezone/nudge";

/** Every cell key the view emits. */
export const PERIODS_KEYS = ["period", "status", "energy", "total"] as const;

export const PERIODS_TITLE = "Billing periods";

/** The billing actions the view offers; BILLING_SURFACE (../surface.ts) defines them. */
export const CREATE_PERIOD_ACTION = { id: "billing.create-period", title: "New billing period" } as const;
export const DELETE_PERIOD_ACTION = { id: "billing.delete-period", title: "Delete period" } as const;

/** The link beside the time zone notice. */
export const SET_TIMEZONE_LINK = "billing.set-timezone";
/** The longest notice text the view sends; the nudge's text holds the microgrid's free-text country. */
export const TIMEZONE_NOTICE_MAX = 600;

export type PeriodRowInput = {
  id: string;
  start_date: string;
  end_date: string;
  status: "draft" | "closed";
  /** Summed over the period's bills; null when it has none. */
  totalKwh: number | null;
  totalAmount: number | null;
};

export type PeriodsModelInput = {
  microgridId: string;
  currency: string;
  /** Newest first, as the loader reads them. */
  periods: readonly PeriodRowInput[];
  /** The new period form's starting dates (getDefaultDates in ../default-dates.ts). */
  defaults: { start: string; end: string };
  /** The time zone nudge (timezoneNudge in src/lib/timezone/nudge.ts), or null when there is none. */
  nudge: TimezoneNudgeCopy | null;
  fmt: Fmt;
};

type Row = LoadedModel<"collection">["body"]["rows"][number];

/**
 * The nudge as the view's notice, with the link to the page that holds the
 * microgrid's Edit button and the nudge's own Set timezone: billing's Rates
 * page, inside the microgrid layout (src/app/(gui)/microgrids/[id]/layout.tsx),
 * which the host's catch-all does not serve. If Rates comes to be served by
 * a view, or Edit leaves that layout, revisit.
 */
function timezoneNotice(microgridId: string, nudge: TimezoneNudgeCopy | null): Pick<LoadedModel<"collection">, "notice" | "links"> {
  if (!nudge) return {};
  const full = `${nudge.title}. ${nudge.text}`;
  const text = full.length > TIMEZONE_NOTICE_MAX ? `${full.slice(0, TIMEZONE_NOTICE_MAX - 1)}…` : full;
  const link: LinkRef = { id: SET_TIMEZONE_LINK, label: "Set timezone", href: `/microgrids/${microgridId}/setup/rates` };
  return { notice: { tone: "warning", text }, links: [link] };
}

export function buildPeriodsModel({ microgridId, currency, periods, defaults, nudge, fmt }: PeriodsModelInput): LoadedModel<"collection"> {
  // The form starts at the previous month in the microgrid's zone, as the
  // legacy list (BillingPeriodList) starts it. The host checks the prefill
  // against CreatePeriodBody's fields; the route checks start <= end.
  const create = {
    action: CREATE_PERIOD_ACTION.id,
    params: { microgrid_id: microgridId },
    prefill: { start_date: defaults.start, end_date: defaults.end },
  };
  const rows: Row[] = periods.map((p) => {
    // As the host labels a billing period (src/lib/gui/host/server/entities.ts).
    const label = `${fmt.date(p.start_date).text} – ${fmt.date(p.end_date).text}`;
    return {
      id: p.id,
      entity: { kind: "billingPeriod", id: p.id, label },
      href: `/microgrids/${microgridId}/billing/${p.id}`,
      cells: {
        // A one-day period shows its one date, as the legacy list does.
        period: fmt.text(p.start_date === p.end_date ? fmt.date(p.start_date).text : label),
        status: fmt.status("billingPeriod", p.status),
        // Energy Values take Wh; a period with no bills shows 0, as the legacy list does.
        energy: fmt.energy((p.totalKwh ?? 0) * 1000, { bare: true }),
        total: p.totalAmount === null ? fmt.empty() : fmt.money(p.totalAmount, currency, { bare: true }),
      },
      // Only a draft can be deleted; the database refuses a closed one anyway.
      actions: p.status === "draft" ? [{ action: DELETE_PERIOD_ACTION.id, params: { periodId: p.id } }] : [],
    };
  });
  return {
    title: PERIODS_TITLE,
    ...timezoneNotice(microgridId, nudge),
    actions: [create],
    body: {
      columns: [
        { key: "period", label: "Period", type: "text", priority: 1 },
        { key: "status", label: "Status", type: "status", priority: 1 },
        { key: "energy", label: "Total kWh", type: "energy", priority: 2 },
        // A bare money column names its currency in the header.
        { key: "total", label: `Total (${currency})`, type: "money", priority: 1, copy: "bare" },
      ],
      rows,
      empty: {
        title: "Create the first billing period",
        text: "A billing period defines the start and end dates you're invoicing for — typically one calendar month. When you close it, MGM snapshots meter readings and generates line items for every tenant.",
        action: create,
      },
    },
  };
}

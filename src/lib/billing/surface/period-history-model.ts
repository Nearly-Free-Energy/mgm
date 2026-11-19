/**
 * period-history-model.ts — one billing period's audit history, as a
 * `collection` view model (`billing.period-history`): what was done to the
 * period and its bills, newest first, a page at a time.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here. The labels, summaries, notes and empty states are
 * the legacy history page's (src/app/(gui)/microgrids/[id]/billing/[periodId]/history/page.tsx,
 * which renders src/components/billing/audit-log-list.tsx with the labels
 * of src/lib/billing/audit-humanize.tsx), as strings rather than JSX;
 * period-history-model.test.ts compares the labels with the legacy ones
 * while both are served.
 *
 * A collection rather than a feed: a feed has no empty state and no `next`,
 * and the host caps its entries at 200 (MODEL_CAPS.entries in
 * src/lib/gui/host/server/parse.ts), so a long history could not be paged.
 * A collection has an empty state, `next` (the kit's "More") and up to 500
 * rows.
 *
 * Paging is by keyset over (time, source, id), newest first, where the
 * source puts the audit log's entries before the payment events' at the
 * same instant: every row a single transaction writes shares one
 * timestamp (created_at and at default to now()), so a cursor on the time
 * alone would skip or repeat them. The loader reads each source with the
 * predicates cursorQueries gives and merges with mergePage.
 */
import type { LinkRef } from "@/lib/gui/contract";
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";
import { periodLabel } from "./period-label";

/** Every cell key the view emits. */
export const PERIOD_HISTORY_KEYS = ["at", "change", "detail", "revision", "by", "note"] as const;
export const PERIOD_HISTORY_TITLE = "Audit history";
/**
 * Entries on one page: under the host's row cap (MODEL_CAPS.rows, 500), and
 * a page's PAGE + 1 rows per read stay under PostgREST's max_rows
 * (supabase/config.toml sets 1000), which would cut a read silently.
 */
export const PERIOD_HISTORY_PAGE = 200;
/**
 * Notes and reasons are cut to this many characters. The host refuses a
 * model with any string over MODEL_CAPS.text (4000) and fails the whole
 * view; the routes cap a note at 500, the database does not.
 */
export const PERIOD_HISTORY_NOTE_MAX = 1000;

/**
 * The query names the view reads. HISTORY_TENANT_PARAM is also the one the
 * period review's View history links carry (./period-review-model.ts builds
 * them with periodHistoryHref).
 */
export const HISTORY_TENANT_PARAM = "tenant_id";
export const HISTORY_CURSOR_PARAM = "before";

/** The view's links. */
export const BACK_TO_PERIOD_LINK = "billing.back-to-period";
export const HISTORY_SHOW_ALL_LINK = "billing.history-show-all";
export const HISTORY_LATEST_LINK = "billing.history-latest";

/** As the host checks a core id (UUID_RE in src/lib/plugins/state.ts). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v);

/** The history page of a period, filtered to a tenant and from a cursor when given. */
export function periodHistoryHref(
  microgridId: string,
  periodId: string,
  o: { tenantId?: string | null; before?: string | null } = {},
): `/${string}` {
  const path = `/microgrids/${microgridId}/billing/${periodId}/history` as const;
  const search = new URLSearchParams();
  if (o.tenantId) search.set(HISTORY_TENANT_PARAM, o.tenantId);
  if (o.before) search.set(HISTORY_CURSOR_PARAM, o.before);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

// ── Ordering and the cursor ─────────────────────────────────────────────────

/** "a": the audit log (billing_audit_log); "p": a payment event (payment_events). */
export type HistorySource = "a" | "p";
/** What ordering needs of an entry: its source, its own id (unprefixed) and its time as the database returned it. */
export type HistoryKeyed = { source: HistorySource; id: string; at: string };
export type HistoryCursor = HistoryKeyed;

const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * A fixed-width UTC key for a timestamp, "YYYY-MM-DDTHH:MM:SS.ffffff",
 * which sorts as the database orders timestamptz. PostgREST trims trailing
 * zeros from the fraction and writes the session's offset, and a Date keeps
 * only milliseconds, so the fraction is taken from the text and padded.
 * Text that is not a timestamp keys as "", after every timestamp.
 */
export function instantKey(ts: string): string {
  const m = TIMESTAMP_RE.exec(ts);
  if (!m) return "";
  const [, y, mo, d, h, mi, s, frac = "", zone = "Z"] = m;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0"));
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMinutes * 60_000;
  if (!Number.isFinite(ms)) return "";
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac.padEnd(6, "0")}`;
}

/** Newest first; at one instant the audit log's entries before the payment events'; then by id, descending, as the reads order them. */
export function compareHistory(a: HistoryKeyed, b: HistoryKeyed): number {
  const ka = instantKey(a.at);
  const kb = instantKey(b.at);
  if (ka !== kb) return ka < kb ? 1 : -1;
  if (a.source !== b.source) return a.source === "a" ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/** "<a|p>~<uuid>~<timestamp as the database returned it>": the last entry of a page. */
export function encodeCursor(c: HistoryCursor): string {
  return `${c.source}~${c.id}~${c.at}`;
}

const CURSOR_RE = /^([ap])~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})~(.+)$/;

/**
 * Whether every field of a timestamp is in range, as Postgres requires of a
 * timestamptz: Date.parse rolls 30 February over into March and takes year
 * 0 and offsets past ±15:59, all of which Postgres refuses, so a cursor
 * carrying one would fail the read instead of giving the first page.
 */
function inRange(ts: string): boolean {
  const m = TIMESTAMP_RE.exec(ts);
  if (!m) return false;
  const [, y, mo, d, h, mi, s, , zone = "Z"] = m;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1 || days === undefined || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return false;
  if (zone === "Z") return true;
  const digits = zone.slice(1).replace(":", "");
  return Number(digits.slice(0, 2)) <= 15 && Number(digits.slice(2, 4) || "0") <= 59;
}

/** The cursor in a `before` parameter, or null (the first page) for anything malformed. */
export function parseCursor(raw: string | null | undefined): HistoryCursor | null {
  if (!raw) return null;
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  const [, source, id, at] = m;
  if (!inRange(at) || Number.isNaN(Date.parse(at)) || instantKey(at) === "") return null;
  return { source: source as HistorySource, id, at };
}

/**
 * One read of a source, newest first: every row ("all"), the rows at the
 * cursor's instant with a lower id ("tie"), or those before ("lt") or at
 * and before ("lte") it. The loader passes the timestamp exactly as the
 * database returned it, so equality holds to the microsecond.
 */
export type SideQuery = { kind: "all" } | { kind: "tie"; at: string; beforeId: string } | { kind: "lt"; at: string } | { kind: "lte"; at: string };

/**
 * The reads of each source for the page after `cursor`; concatenated in
 * order, each source's results stay newest first.
 */
export function cursorQueries(cursor: HistoryCursor | null): { audit: SideQuery[]; payment: SideQuery[] } {
  if (!cursor) return { audit: [{ kind: "all" }], payment: [{ kind: "all" }] };
  const tie: SideQuery = { kind: "tie", at: cursor.at, beforeId: cursor.id };
  const before: SideQuery = { kind: "lt", at: cursor.at };
  // At one instant the audit log comes first: after an audit entry, every
  // payment event at that instant is still to come; after a payment event,
  // every audit entry at that instant has been shown.
  return cursor.source === "a"
    ? { audit: [tie, before], payment: [{ kind: "lte", at: cursor.at }] }
    : { audit: [before], payment: [tie, before] };
}

/**
 * The first `page` entries of both sources, merged, and the cursor of the
 * next page when there are more. Each source must hold its first page + 1
 * rows after the cursor, newest first, so a source that has more shows it.
 */
export function mergePage<T extends HistoryKeyed>(
  audit: readonly T[],
  payments: readonly T[],
  page: number = PERIOD_HISTORY_PAGE,
): { entries: T[]; next: string | null } {
  const merged = [...audit, ...payments].sort(compareHistory);
  const entries = merged.slice(0, page);
  const last = entries[entries.length - 1];
  return { entries, next: merged.length > page && last ? encodeCursor(last) : null };
}

// ── Humanizing an entry ─────────────────────────────────────────────────────

/** "System" for no actor, "Restricted" for one the person may not see, else the name (audit-humanize.tsx's actorDisplayLabel). */
export function historyActorLabel(entry: Pick<BillingAuditLogEntry, "actorUserId" | "actorDisplayName">): string {
  if (entry.actorUserId === null) return "System";
  if (entry.actorDisplayName === null) return "Restricted";
  return entry.actorDisplayName;
}

/** At most PERIOD_HISTORY_NOTE_MAX characters. */
export function clipText(s: string, max: number = PERIOD_HISTORY_NOTE_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const getNumber = (v: unknown): number | null => (typeof v === "number" ? v : null);
const getString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Live name, then the snapshot written with the entry, then "Unknown tenant". */
function tenantNameOf(entry: BillingAuditLogEntry): string {
  if (entry.tenantName) return entry.tenantName;
  // `household_name`: rows written before the households → tenants rename.
  return getString(entry.details?.["tenant_name"]) ?? getString(entry.details?.["household_name"]) ?? "Unknown tenant";
}

export type HumanizedHistoryEntry = {
  change: string;
  /** The summary line, or null. */
  detail: string | null;
  /** A bill's manual reason, or the payment notes on a status change, or null. */
  note: string | null;
  postClose: boolean;
};

/** One entry as the legacy history page words it, with money and statuses formatted on the server. */
export function humanizeHistoryEntry(entry: BillingAuditLogEntry, fmt: Fmt, currency: string): HumanizedHistoryEntry {
  const d = entry.details ?? {};
  const postClose = d["period_was_closed"] === true;
  const money = (amount: number) => fmt.money(amount, currency).text;
  const paymentStatus = (s: string) => fmt.status("billingLineItemPaymentStatus", s).text;
  const out = (change: string, detail: string | null = null, note: string | null = null): HumanizedHistoryEntry => ({
    change: clipText(change),
    detail: detail === null ? null : clipText(detail),
    note: note === null ? null : clipText(note),
    postClose,
  });

  switch (entry.eventType) {
    case "period_created":
      return out("Period created");
    // The close's digest, acknowledgements and totals are not shown, as on the legacy page.
    case "period_closed":
      return out("Period closed");
    case "line_item_generated": {
      const total = getNumber(d["new_total_amount"]);
      return out(`Bill generated for ${tenantNameOf(entry)}`, total === null ? null : `Total: ${money(total)}`, getString(d["manual_reason"]));
    }
    case "line_item_regenerated": {
      const prev = getNumber(d["previous_total_amount"]);
      const next = getNumber(d["new_total_amount"]);
      const prevSrc = getString(d["previous_reading_source"]);
      const newSrc = getString(d["new_reading_source"]);
      let detail = prev === null || next === null || prev === next ? "Total unchanged" : `Total changed from ${money(prev)} to ${money(next)}`;
      // Only when both are known and differ: a first write has no previous source.
      if (prevSrc !== null && newSrc !== null && prevSrc !== newSrc) {
        const source = (s: string) => fmt.status("billingLineItemReadingSource", s).text;
        detail += ` · Source changed from ${source(prevSrc)} to ${source(newSrc)}`;
      }
      return out(`Bill regenerated for ${tenantNameOf(entry)}`, detail, getString(d["manual_reason"]));
    }
    case "payment_status_changed": {
      const from = getString(d["from"]);
      const to = getString(d["to"]);
      const detail = to === null ? null : from === null ? `Set to ${paymentStatus(to)}` : `${paymentStatus(from)} → ${paymentStatus(to)}`;
      // The bill's current notes, on every one of its status changes, as the legacy page shows them.
      return out(`Payment status for ${tenantNameOf(entry)}`, detail, getString(d["notes"]));
    }
    case "payment_link_generated":
      return out(`Payment link generated for ${tenantNameOf(entry)}`);
    case "billing_period_created":
      return out("Billing period created");
    // Organization-wide events (billing_period_id is null), so never on a period; kept for parity with the legacy labels.
    case "token_generated":
    case "token_revoked":
    case "token_regenerated": {
      const verb = { token_generated: "created", token_revoked: "revoked", token_regenerated: "regenerated" }[entry.eventType];
      const name = getString(d["name"]);
      return out(name ? `API token ${verb}: ${name}` : `API token ${verb}`);
    }
    case "tariff_reconciled": {
      const reference = getString(d["review_reference"]);
      return out(reference ? `Historical tariff reconciled (${reference})` : "Historical tariff reconciled");
    }
    default: {
      // An event type added later shows as itself, as the legacy page shows it.
      const raw: string = entry.eventType;
      return out(raw || "unknown_event");
    }
  }
}

// ── The model ───────────────────────────────────────────────────────────────

export type PeriodHistoryInput = {
  microgrid: { id: string; currency: string };
  period: { id: string; start_date: string; end_date: string; timezone: string };
  /** One page, in order (mergePage). */
  entries: readonly BillingAuditLogEntry[];
  /**
   * The tenant filter, when the request names one: its id when it is a
   * UUID (null when it is not, so nothing echoes it), its name when it is a
   * tenant of this period's microgrid, and whether it can match any entry
   * at all: false when it names no tenant of this microgrid with a bill in
   * this period, so that no page of it, whatever its cursor, has entries.
   */
  filter: null | { tenantId: string | null; tenantName: string | null; canMatch: boolean };
  /** This page's cursor, when it is not the first. */
  before: string | null;
  /** The next page's cursor, when there are more. */
  next: string | null;
  fmt: Fmt;
};

type Row = LoadedModel<"collection">["body"]["rows"][number];
type Column = LoadedModel<"collection">["body"]["columns"][number];

const COLUMNS: Column[] = [
  { key: "at", label: "When", type: "datetime", priority: 1 },
  { key: "change", label: "Change", type: "text", priority: 1 },
  { key: "detail", label: "Details", type: "text", priority: 2 },
  { key: "revision", label: "Revision", type: "status", priority: 2 },
  { key: "by", label: "By", type: "text", priority: 3 },
  { key: "note", label: "Note", type: "text", priority: 3 },
];

export function buildPeriodHistoryModel(i: PeriodHistoryInput): LoadedModel<"collection"> {
  const { microgrid, period, fmt, filter } = i;
  const label = periodLabel(fmt, period.start_date, period.end_date);
  // A one-day period shows its one date, as the period review's title does.
  const shown = period.start_date === period.end_date ? fmt.date(period.start_date).text : label;
  // Never the raw parameter: only a tenant this microgrid has is named.
  // Clipped as the cells are: tenants.display_name has no length limit.
  const tenantLabel = filter ? clipText(filter.tenantName ?? "unknown tenant") : null;
  const tenantId = filter?.tenantId ?? null;
  // A filter that can match nothing (not a UUID, or no bill of this
  // microgrid's in this period) has no entries on any page: such a page is
  // the first, whatever its cursor, so it never says an earlier page had
  // entries and never offers Latest changes to a page as empty as itself
  // (nor, for a value that is not a UUID, echoes it).
  const later = i.before !== null && !(filter && !filter.canMatch);

  const rows: Row[] = i.entries.map((entry) => {
    const h = humanizeHistoryEntry(entry, fmt, microgrid.currency);
    // No entity on a row: a lineItem entity would have other plugins'
    // targeted actions on bills appended to log entries (appendTargetedActions).
    return {
      id: entry.id,
      cells: {
        at: fmt.datetime(entry.createdAt, period.timezone),
        change: fmt.text(h.change),
        detail: h.detail === null ? fmt.empty() : fmt.text(h.detail),
        revision: h.postClose ? fmt.status("billingAuditEntry", "post_close_revision") : fmt.empty(),
        by: fmt.text(clipText(historyActorLabel(entry))),
        note: h.note === null ? fmt.empty() : fmt.text(h.note),
      },
      actions: [],
    };
  });

  const links: LinkRef[] = [{ id: BACK_TO_PERIOD_LINK, label: "Back to period", href: `/microgrids/${microgrid.id}/billing/${period.id}` }];
  if (filter) links.push({ id: HISTORY_SHOW_ALL_LINK, label: "Show all", href: periodHistoryHref(microgrid.id, period.id) });
  // Not on the legacy page, which has one page: "More" replaces the page, so this leads back to the newest entries.
  if (later) links.push({ id: HISTORY_LATEST_LINK, label: "Latest changes", href: periodHistoryHref(microgrid.id, period.id, { tenantId }) });

  // A later page that comes back empty has shown its entries already, filtered or not.
  const empty: LoadedModel<"collection">["body"]["empty"] = later
    ? { title: tenantLabel === null ? "No earlier changes recorded" : `No earlier changes recorded for ${tenantLabel}` }
    : filter
      ? { title: `No changes recorded for ${tenantLabel}`, text: "Other tenants on this period may have entries." }
      : {
          title: "No changes recorded yet",
          text: "This period has no events. As you generate bills, close the period, or take payments, entries will appear here.",
        };

  return {
    title: PERIOD_HISTORY_TITLE,
    subtitle: tenantLabel === null ? shown : `${shown} · Showing changes for ${tenantLabel}`,
    entity: { kind: "billingPeriod", id: period.id, label },
    actions: [],
    links,
    body: {
      columns: COLUMNS,
      rows,
      ...(i.next ? { next: periodHistoryHref(microgrid.id, period.id, { tenantId, before: i.next }) } : {}),
      empty,
    },
  };
}

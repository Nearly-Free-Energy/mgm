import "server-only";

/**
 * The model of Today (`org.today`), the home page: the organization's
 * signals, most urgent first, one row each, linking to where the signal is
 * resolved. The host collects the signals before the loader runs, because
 * the view declares `takesSignals` (organizationSignals in
 * src/lib/gui/host/server/signals.ts), and they arrive here already ordered
 * and cut to the host's MAX_TOP, with `count` saying how many there were.
 * Tiles other plugins attach to this view are listed by the host
 * (attachedViews in src/lib/gui/host/server/view.ts), not here.
 *
 * Fixed copy: the empty and unchecked states say what the shell's tray
 * says (NeedsYou in src/gui/gridtop/shell/tray.tsx), so the two never
 * disagree; if one changes, change the other. A signal's own title and
 * facts are already fixed copy with no tenant's name (ADR-006 decision 9).
 *
 * Rows carry no entity, so the host appends no other plugin's targeted
 * action to a signal (resolveActions appends to a row's entity). A
 * proposal's action, which the host resolved for the person when it
 * collected the signal, is handed back as a link and resolved again with
 * the view's own actions, so it is offered here as it would be anywhere.
 */
import type { ActionRef, Column, Signal, Signals, Tone, Value } from "@/lib/gui/contract";
import type { ActionLink, Fmt, LoadedModel } from "@/lib/gui/surface";

export const TODAY_VIEW = "org.today";
export const TODAY_TITLE = "Today";

export const TODAY_COPY = {
  nothing: "Nothing needs you right now.",
  unchecked: "Some sources did not answer in time.",
  failed: "What needs you could not be checked right now. Try again shortly.",
  // The host's order (order() in src/lib/gui/host/server/signals.ts): most
  // severe first, alarms first within a severity, then the soonest due. If
  // that order changes, revisit this sentence.
  more: (shown: number, count: number) => `${shown} of ${count} are shown: the most severe first, alarms first, then the soonest due.`,
} as const;

export const TODAY_KEYS = ["title", "severity", "due", "details"] as const;

const COLUMNS: Column[] = [
  { key: "title", label: "What needs you", type: "text", priority: 1 },
  { key: "severity", label: "Severity", type: "status", priority: 1 },
  { key: "due", label: "Due", type: "date", priority: 2 },
  { key: "details", label: "Details", type: "text", priority: 3 },
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When the signal is due. Every watcher contributed today sends a date
 * (billing.period-due); a time, which the contract allows, is shown in UTC,
 * since the host hands the loader no organization time zone. If a watcher
 * starts sending times, show them in the organization's zone.
 */
function due(fmt: Fmt, at: string | undefined): Value {
  if (at === undefined) return fmt.empty();
  return DATE_ONLY.test(at) ? fmt.date(at) : fmt.datetime(at, "UTC");
}

/** The signal's facts as one line; marked synthetic if any fact is. */
function details(fmt: Fmt, facts: readonly Value[] | undefined): Value {
  if (!facts || facts.length === 0) return fmt.empty();
  const value = fmt.text(facts.map((f) => f.text).join(" · "));
  return facts.some((f) => f.synthetic) ? { ...value, synthetic: true } : value;
}

/** A resolved ActionRef handed back as the link a loader gives. */
function linkOf(ref: ActionRef): ActionLink {
  return {
    action: ref.action,
    params: { ...ref.params },
    label: ref.label,
    ...(ref.prefill !== undefined ? { prefill: ref.prefill } : {}),
    ...(ref.provenance ? { provenance: { ...ref.provenance } } : {}),
  };
}

function row(fmt: Fmt, signal: Signal) {
  return {
    id: signal.id,
    href: signal.href,
    cells: {
      title: fmt.text(signal.title),
      severity: fmt.status("signalSeverity", signal.severity),
      due: due(fmt, signal.due),
      details: details(fmt, signal.facts),
    },
    actions: signal.kind === "proposal" ? [linkOf(signal.action)] : [],
  };
}

/** What the notice says: that a source did not answer, and that not every signal is shown. */
function notice(signals: Signals): { tone: Tone; text: string } | undefined {
  const parts: string[] = [];
  if (signals.unchecked.length > 0) parts.push(TODAY_COPY.unchecked);
  if (signals.count > signals.top.length) parts.push(TODAY_COPY.more(signals.top.length, signals.count));
  if (parts.length === 0) return undefined;
  // Signals left out, like a source that did not answer, are something the
  // person cannot see here, so both are a warning.
  return { tone: "warning", text: parts.join(" ") };
}

/**
 * Today for `signals`, or for signals that could not be collected (null):
 * then the empty state says so, rather than that nothing needs the person.
 */
export function buildTodayModel(fmt: Fmt, signals: Signals | null): LoadedModel<"collection"> {
  const shown = signals ? notice(signals) : undefined;
  return {
    title: TODAY_TITLE,
    actions: [],
    body: {
      columns: COLUMNS.map((c) => ({ ...c })),
      rows: signals ? signals.top.map((s) => row(fmt, s)) : [],
      empty: { title: signals ? TODAY_COPY.nothing : TODAY_COPY.failed },
    },
    ...(shown ? { notice: shown } : {}),
  };
}

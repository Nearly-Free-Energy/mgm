import "server-only";

/**
 * Signals and status items for the signed-in person's organization: what
 * contributed watchers report (GET /api/gui/signals, fetched after the first
 * paint) and the status items the manifest carries (./manifest.ts).
 *
 * Each watcher and status loader runs only while its plugin is enabled for
 * the organization (./gate-state.ts), on its own request and client of the
 * person's session (./access.ts), and within its own time budget
 * (./budget.ts). What it returns is strictly parsed, its page hrefs must be
 * released pages, and a proposal's action is resolved for the person as a
 * view's own action is (./merge.ts). A watcher that is late, throws, returns
 * anything the parse refuses, or whose plugin state cannot be read is listed
 * as unchecked; only its id and the kind of miss are logged, never its error
 * or its output.
 */
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { ActionRef, Id, Signal, Signals, StatusItem } from "../../contract";
import type { GateState } from "../shared/merge-actions";
import { requireIssued, surfaceRequest, type HostContext } from "./access";
import { withinBudget } from "./budget";
import { pluginGate, type PluginGate } from "./gate-state";
import { isPageHref } from "./hrefs";
import { checkAvailability, resolveOwnAndTargeted } from "./merge";
import { actionLinkSchema, signalSchema, signalsSchema, statusItemSchema } from "./model-schema";
import { selectOrganization } from "./organization";
import { parseOrFail } from "./parse";
import { surfaceSnapshot } from "./snapshot";
import type { RegisteredSignal, RegisteredStatus, SurfaceSnapshot } from "./surface-registry";
import type { HostOutcome } from "./view";

/** A watcher's budget unless it sets its own `budgetMs`. */
export const SIGNAL_BUDGET_MS = 1_500;
/** How long one status loader may take before its item is left out. */
export const STATUS_BUDGET_MS = 800;
export const MAX_SIGNALS_PER_SOURCE = 50;
/** How many signals the answer carries; `count` says how many there were. */
export const MAX_TOP = 20;
/** The longest one signal may be, as JSON. */
const MAX_SIGNAL_CHARS = 4_000;
const SEVERITY = { critical: 0, warn: 1, info: 2 } as const;

type Miss = "late" | "threw" | "invalid" | "gate";
type Watched = { ok: true; signals: Signal[] } | { ok: false; miss: Miss };

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether every href in `v` is a released page. Params and prefill are data, not hrefs. */
function pageHrefsOnly(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(pageHrefsOnly);
  if (!isPlain(v)) return true;
  return Object.entries(v).every(([key, child]) =>
    key === "href" ? typeof child === "string" && isPageHref(child) : key === "params" || key === "prefill" || pageHrefsOnly(child),
  );
}

function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Infinity;
  }
}

/**
 * A proposal's action as an ActionRef, or null when it is left out: an
 * unknown or human-only action, params that do not fit, an unreleased route,
 * or another plugin that is off. `undefined`: the link breaks its schema.
 */
async function proposed(link: unknown, entry: RegisteredSignal, snapshot: SurfaceSnapshot, gate: PluginGate) {
  const parsed = actionLinkSchema.safeParse(link);
  // The host says who proposed it, as it sets `source`: a watcher may not claim the assistant or a proposal id.
  if (!parsed.success) return undefined;
  const provenance = parsed.data.provenance;
  if (!provenance || provenance.by !== "watcher" || provenance.proposal !== undefined) return undefined;
  const registered = snapshot.actions.get(parsed.data.action);
  if (!registered || registered.def.humanOnly) return null;
  const states = new Map<MgmPluginName, GateState>();
  const state = await gate(registered.plugin).catch(() => null);
  if (state) states.set(registered.plugin, state);
  const input = { plugin: entry.plugin, actions: [...snapshot.actions.values()], scope: {}, gate: states, isReleased: isReleasedRoute };
  const { model } = resolveOwnAndTargeted({ kind: "record", body: { sections: [] }, actions: [parsed.data] }, input, snapshot.actions);
  return model.actions[0] ?? null;
}

/** One watcher's signals, each with its source and a proposal's action resolved, or why it has none. */
async function watch(ctx: HostContext, organizationId: string, entry: RegisteredSignal, snapshot: SurfaceSnapshot, gate: PluginGate): Promise<Watched> {
  const out = await withinBudget(
    async () => entry.load(await surfaceRequest(ctx, organizationId, {}, new URLSearchParams())),
    entry.budgetMs ?? SIGNAL_BUDGET_MS,
  );
  if (!out.ok) return out;
  const raw: unknown = out.value;
  if (!Array.isArray(raw) || raw.length > MAX_SIGNALS_PER_SOURCE) return { ok: false, miss: "invalid" };
  const signals: Signal[] = [];
  for (const item of raw) {
    if (!isPlain(item) || Object.hasOwn(item, "source") || jsonLength(item) > MAX_SIGNAL_CHARS) return { ok: false, miss: "invalid" };
    const signal: Record<string, unknown> = { ...item, source: entry.id };
    if (item.kind === "proposal") {
      const action = await proposed(item.action, entry, snapshot, gate);
      if (action === undefined) return { ok: false, miss: "invalid" };
      if (action === null) {
        console.warn(`[gui] signals ${entry.id}: a proposal was left out`);
        continue;
      }
      signal.action = action;
    }
    const parsed = parseOrFail(signalSchema, signal, `signals ${entry.id}`);
    if (!parsed.ok || !pageHrefsOnly(parsed.value)) return { ok: false, miss: "invalid" };
    signals.push(parsed.value);
  }
  return { ok: true, signals };
}

/** An ISO date or time as an instant, whatever its offset; a date alone is UTC midnight. */
const instant = (iso: string | undefined, otherwise: number) => {
  const t = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(t) ? otherwise : t;
};
/** Most severe first; then the earliest due, undated last; then the newest. */
function order(a: Signal, b: Signal): number {
  const cmp = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    SEVERITY[a.severity] - SEVERITY[b.severity] ||
    cmp(instant(a.due, Infinity), instant(b.due, Infinity)) ||
    cmp(instant(b.at, -Infinity), instant(a.at, -Infinity))
  );
}

/** Each proposal's action with its own available() asked, within one shared budget. */
async function checkProposals(ctx: HostContext, organizationId: string, snapshot: SurfaceSnapshot, signals: Signal[]): Promise<Signal[]> {
  const refs: ActionRef[] = signals.flatMap((s) => (s.kind === "proposal" ? [s.action] : []));
  if (refs.length === 0) return signals;
  const { actions } = await checkAvailability(
    { kind: "record", body: { sections: [] }, actions: refs },
    { actions: snapshot.actions, request: () => surfaceRequest(ctx, organizationId, {}, new URLSearchParams()) },
  );
  let i = 0;
  return signals.map((s) => (s.kind === "proposal" ? { ...s, action: actions[i++] } : s));
}

/**
 * The signals of the organization `requested` names when the person can see
 * it, otherwise of the first one they can (./organization.ts). A disabled
 * plugin's watchers are skipped; one whose plugin state cannot be read is
 * unchecked.
 */
export async function collectSignals(ctx: HostContext, o: { requested?: string | null }): Promise<HostOutcome<Signals>> {
  requireIssued(ctx);
  const snapshot = await surfaceSnapshot();
  let organizationId: string | null;
  try {
    organizationId = (await selectOrganization(ctx, { requested: o.requested })).organizationId;
  } catch {
    return { ok: false, status: 503, code: "gui_unavailable", message: "Signals could not be checked right now." };
  }
  if (organizationId === null) return { ok: false, status: 403, code: "gui_no_access", message: "Your account has no organization yet." };
  const org = organizationId;

  const gate = pluginGate(ctx, org);
  const results = await Promise.all(
    snapshot.signals.map(async (entry): Promise<Watched | "off"> => {
      const state = await gate(entry.plugin).catch(() => null);
      if (state && !state.ok && state.status === 409) return "off";
      if (!state?.ok) return { ok: false, miss: "gate" };
      return watch(ctx, org, entry, snapshot, gate);
    }),
  );
  const checked: Id[] = [];
  const unchecked: Id[] = [];
  const found: Signal[] = [];
  snapshot.signals.forEach((entry, i) => {
    const r = results[i];
    if (r === "off") return;
    if (r.ok) {
      checked.push(entry.id);
      found.push(...r.signals);
    } else {
      unchecked.push(entry.id);
      console.warn(`[gui] signals ${entry.id}: not checked (${r.miss})`);
    }
  });
  const all = (await checkProposals(ctx, org, snapshot, found)).sort(order);
  const signals = { type: "signals", org, count: all.length, top: all.slice(0, MAX_TOP), checked, unchecked };
  const parsed = parseOrFail(signalsSchema, signals, "signals");
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, status: 500, code: "gui_output_invalid", message: "Signals could not be shown." };
}

/**
 * The status item of each entry, in order, or null where its loader returns
 * none, is late, throws or breaks the schema. The caller passes only entries
 * whose plugin is enabled for `organizationId`.
 */
export async function collectStatus(
  ctx: HostContext,
  organizationId: string,
  entries: readonly RegisteredStatus[],
): Promise<(StatusItem | null)[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const out = await withinBudget(
        async () => entry.load(await surfaceRequest(ctx, organizationId, {}, new URLSearchParams())),
        STATUS_BUDGET_MS,
      );
      if (!out.ok) {
        if (out.miss === "threw") console.error(`[gui] ${entry.id}: status loader failed`);
        return null;
      }
      const loaded = out.value;
      if (!isPlain(loaded)) return null;
      // `ask` needs its action resolved for this person, which the action merge adds; until then it is left out.
      const parsed = parseOrFail(statusItemSchema, { id: entry.id, label: loaded.label, state: loaded.state, open: loaded.open }, entry.id);
      return parsed.ok && isPageHref(parsed.value.open) ? parsed.value : null;
    }),
  );
}

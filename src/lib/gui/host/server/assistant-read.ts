import "server-only";

/**
 * The assistant read interface (#133 A1-1, ADR-007 decisions 6 to 8): what
 * an assistant may read of an organization, served through the same host
 * functions a person's pages use, so it gains no read path a person lacks.
 *
 * - A view is served through dispatchView (./view.ts), only when it is
 *   marked `agent: "read"`, on the code-owned list
 *   (src/lib/gui/assistant-reads.ts) as a view, and about an organization.
 *   Any other is refused as `assistant_not_listed` before its loader runs.
 *   A feed's embed of a view that is not is withheld unloaded (dispatchView's
 *   `admit`); so is every view attached to it, listed in `withheld` from the
 *   surface whatever its plugin state, so the answer does not tell another
 *   plugin's state. An attached view that is admitted is read as the view
 *   itself is; one the model leaves out (attachedViews in ./view.ts: its
 *   plugin off or its gate unreadable, or its path unfilled here) is given
 *   with the gate's refusal or as not found, never just left out. While
 *   ASSISTANT_READS lists no attached view, no answer has one.
 * - Signals come from assistantSignals (./signals.ts): only marked and
 *   listed watchers run, and the counts are over them alone.
 * - Every action, proposal and composer is removed (a proposal is not
 *   authority, ADR-007 decision 4), as are the attached-view list, the
 *   signals and the polling hints the shell uses.
 * - Each view's model, and each view model embedded in it, keeps only the
 *   links its list entry names (`links`), and each ext path the entry
 *   withholds (`withhold.ext`) is set to null or removed and named in
 *   `withheld` on every read, whatever it held; the ext must then still
 *   parse with the view's own schema. A dropped link is logged by id.
 * - A model, attached view or signal carrying a reference
 *   assistant-references.ts refuses is refused whole, as
 *   `assistant_reference_refused`: a listed view that emits one is a review
 *   failure, so the answer is never shown as empty. Only the path and kind
 *   are logged.
 * - An answer longer than ASSISTANT_READ_MAX_CHARS as JSON is refused.
 *
 * Every refusal the host gives (gui_bad_request, gui_not_found,
 * gui_no_access, gui_unavailable, gui_view_refused, gui_view_failed,
 * gui_output_invalid, `<plugin>_disabled`, `<plugin>_gate_unavailable`) is
 * passed on with its status and fixed copy, so an unavailable, disabled or
 * unsupported read is never shown as zero or healthy. A vendor view whose
 * plugin is off is refused without a load, as on a page; a db view loads
 * with the gate's notice.
 *
 * Precondition: the caller has asked the assistant plugin's own gate for the
 * organization with `access: "write"` (ADR-007 decision 5) and holds a
 * HostContext, which hostContext issues only after a getUser()-backed access
 * read. Nothing calls this module yet: A3's harness adapter will, in the
 * operator's own session, and gui-boundary.test.ts lets only modules on its
 * allow-list import it. If a caller is added without that gate, or runs in
 * a session other than the person's, revisit. It opens no Cordis scope,
 * provides no service, has no route and never uses the service role.
 *
 * Scope disposal: a view's loader composes and disposes in its own
 * `finally`, and dispatchView awaits the loader, so its scope is disposed
 * before the answer. Watchers and actions' available() run within a time
 * budget that does not cancel them (./budget.ts), so a late one may finish,
 * and dispose, after the answer.
 */
import { isDeepStrictEqual } from "node:util";
import { rolesIncludeStaff } from "@/lib/auth/access";
import type { GateDecision } from "@/lib/runtime/gate";
import { ASSISTANT_READS, type AssistantRead } from "../../assistant-reads";
import type { Id, Signal, ViewModel } from "../../contract";
import { requireIssued, type HostContext } from "./access";
import { findRefusedReference } from "./assistant-references";
import { withholdMode } from "./contribution-schema";
import { pluginGate } from "./gate-state";
import { isPageHref, parseHref } from "./hrefs";
import { matchView } from "./match-view";
import { selectOrganization } from "./organization";
import { DATA_KEYS, RECORD_KEYS } from "./parse";
import { assistantSignals } from "./signals";
import { surfaceSnapshot } from "./snapshot";
import type { RegisteredSignal, RegisteredView, SurfaceSnapshot } from "./surface-registry";
import {
  NOT_LISTED,
  WITHHELD_EMBED,
  attachmentCandidates,
  attachmentTitle,
  dispatchView,
  type Admit,
  type HostFailure,
} from "./view";

/** The longest answer, in characters of JSON, an assistant is given. */
export const ASSISTANT_READ_MAX_CHARS = 200_000;

export type AssistantReadRequest =
  | { type: "view"; href: string; org?: string | null }
  | { type: "signals"; org?: string | null };

export type AssistantOutcome<T> = { ok: true; value: T } | HostFailure;

/** Omit over each member of a union, so a discriminated union stays one. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What was left out of an answer, and why: on every read, whatever it held. */
export type AssistantWithheld =
  | { what: "view"; view: Id; title: string; hint: "section" | "tab" | "tile"; note: string }
  | { what: "embed"; entry: string; note: string }
  | { what: "field"; path: string; note: string };

/**
 * dispatchView's model with every `actions` emptied, every other action,
 * proposal and composer removed, embeds an assistant may not read withheld,
 * and `attached`, `signals` and `live` removed.
 */
export type AssistantViewModel = OmitEach<ViewModel, "attached" | "signals" | "live">;

export type AssistantView = {
  type: "assistant-view";
  view: Id;
  org: string;
  cost: "db" | "vendor";
  /** The ext's schema and version (`<id>@<n>`), or null for a view with none. */
  ext: `${Id}@${number}` | null;
  model: AssistantViewModel;
  /** Attached views an assistant may read, each read as the view itself is. */
  attached: { view: Id; title: string; hint: "section" | "tab" | "tile"; outcome: AssistantOutcome<AssistantView> }[];
  withheld: AssistantWithheld[];
};

/** A signal without a proposal's action. */
export type AssistantSignal = OmitEach<Signal, "action">;

export type AssistantSignals = {
  type: "assistant-signals";
  org: string;
  count: number;
  attention: number;
  top: AssistantSignal[];
  checked: Id[];
  unchecked: Id[];
  /** Watchers an assistant may read that did not run because their plugin is off. */
  off: Id[];
};

const fail = (status: number, code: string, message: string): HostFailure => ({ ok: false, status, code, message });
const NOT_FOUND = fail(404, "gui_not_found", "This page could not be found.");
const REFERENCE_REFUSED = fail(500, "assistant_reference_refused", "This view could not be given to an assistant.");
const TOO_LARGE = fail(500, "assistant_output_too_large", "This answer is too large to give to an assistant.");
const VIEW_FAILED = fail(500, "gui_view_failed", "This view could not be loaded.");
const NOT_ATTACHED = fail(404, "gui_not_found", "This view is not available for this page.");
const OUTPUT_INVALID = fail(500, "gui_output_invalid", "This view could not be shown.");

export const WITHHELD_NOTE = "Withheld: an assistant may not read this.";

const listed = (kind: "view" | "watcher", id: string) => ASSISTANT_READS.some((r) => r.kind === kind && r.id === id);

/**
 * Whether an assistant may read `view`: marked, listed as a view, and about
 * an organization. A tenant view is never one: ADR-007 decision 10's
 * exception (a tenant view for an agent client signed in as that tenant) is
 * #259 D2's, and would be decided here.
 */
function readableView({ def }: RegisteredView): boolean {
  return def.agent === "read" && listed("view", def.id) && (def.scope ?? "organization") === "organization";
}

const readableWatcher = (s: RegisteredSignal) => s.agent === "read" && listed("watcher", s.id);

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `node` without what an assistant may not act on: each `actions` array
 * emptied, so the model keeps its shape, and each `action`, `stop` and
 * `compose`, and each action embed, removed. Data subtrees (DATA_KEYS) are
 * copied as they are, and a record's keys are a view's declared keys.
 * __tests__/assistant-read.test.ts walks the view model schema and fails
 * if an ActionRef sits under any other name.
 */
function stripActions(node: unknown, keysAreData = false): unknown {
  if (Array.isArray(node)) return node.map((item) => stripActions(item));
  if (!isPlain(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    if (!keysAreData) {
      if (DATA_KEYS.has(key)) {
        out[key] = child;
        continue;
      }
      if (key === "actions" && Array.isArray(child)) {
        out[key] = [];
        continue;
      }
      if (key === "action" || key === "stop" || key === "compose") continue;
      if (key === "embed" && isPlain(child) && child.type === "action") continue;
    }
    out[key] = stripActions(child, !keysAreData && RECORD_KEYS.has(key));
  }
  return out;
}

type ViewEntry = Extract<AssistantRead, { kind: "view" }>;
const entryOf = (id: unknown) => ASSISTANT_READS.find((r): r is ViewEntry => r.kind === "view" && r.id === id);

/**
 * `node` with each `links` list cut to the ids in `allowed`, the others'
 * ids pushed to `dropped`. Data subtrees (DATA_KEYS) are copied as they
 * are, as is an embedded view's model, which its own entry governs.
 */
function keepLinks(node: unknown, allowed: readonly string[], dropped: string[], keysAreData = false): unknown {
  if (Array.isArray(node)) return node.map((item) => keepLinks(item, allowed, dropped));
  if (!isPlain(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    if (!keysAreData) {
      if (DATA_KEYS.has(key) || (key === "embed" && isPlain(child) && child.type === "view")) {
        out[key] = child;
        continue;
      }
      if (key === "links" && Array.isArray(child)) {
        out[key] = child.filter((link) => {
          const id = isPlain(link) && typeof link.id === "string" ? link.id : null;
          if (id !== null && allowed.includes(id)) return true;
          dropped.push(id ?? "(no id)");
          return false;
        });
        continue;
      }
    }
    out[key] = keepLinks(child, allowed, dropped, !keysAreData && RECORD_KEYS.has(key));
  }
  return out;
}

/** `node` with the value at `keys` set to null ("null") or removed ("omit"), in every item of an array on the way. */
function withholdAt(node: unknown, keys: readonly string[], mode: "null" | "omit"): unknown {
  if (Array.isArray(node)) return node.map((item) => withholdAt(item, keys, mode));
  if (!isPlain(node) || !Object.hasOwn(node, keys[0])) return node;
  const [key, ...rest] = keys;
  if (rest.length > 0) return { ...node, [key]: withholdAt(node[key], rest, mode) };
  if (mode === "null") return { ...node, [key]: null };
  const { [key]: _gone, ...kept } = node;
  void _gone;
  return kept;
}

/**
 * `model`, and each view model embedded in it, as its list entry allows
 * (ViewEntry in ../../assistant-reads.ts): only the entry's link ids, and
 * each of its `withhold.ext` paths set to null or removed (withholdMode in
 * ./contribution-schema.ts) and recorded in `withheld` at its path in the
 * answer, after which the ext must still parse with the view's schema. The
 * contribution check refuses an entry whose paths do not allow this, so a
 * failure here is the host's (gui_output_invalid), never shown as empty.
 */
function applyEntry(
  model: Record<string, unknown>,
  snapshot: SurfaceSnapshot,
  at: string,
  withheld: AssistantWithheld[],
): { ok: true; model: Record<string, unknown> } | HostFailure {
  const entry = entryOf(model.view);
  const def = snapshot.views.find((v) => v.def.id === model.view)?.def;
  if (!entry || !def) return VIEW_FAILED;
  const dropped: string[] = [];
  let out = keepLinks(model, entry.links, dropped) as Record<string, unknown>;
  // Logged by id, never recorded in the answer: whether a link is there can depend on the data.
  for (const id of dropped) console.warn(`[gui] assistant read ${entry.id}: left out the link ${id}`);

  const paths = entry.withhold?.ext ?? [];
  for (const path of paths) {
    withheld.push({ what: "field", path: `${at}ext.data.${path}`, note: WITHHELD_NOTE });
    const ext = out.ext;
    if (!isPlain(ext) || !Object.hasOwn(ext, "data")) continue;
    const mode = def.ext ? withholdMode(def.ext.zod, path) : null;
    if (mode === null) return OUTPUT_INVALID;
    out = { ...out, ext: { ...ext, data: withholdAt(ext.data, path.split("."), mode) } };
  }
  if (paths.length > 0 && isPlain(out.ext) && Object.hasOwn(out.ext, "data")) {
    let parsed: { success: boolean; data?: unknown } = { success: false };
    try {
      if (def.ext) parsed = def.ext.zod.safeParse(out.ext.data);
    } catch {
      // An ext schema that cannot be checked synchronously is refused at registration.
    }
    if (!parsed.success) {
      console.error(`[gui] assistant read ${entry.id}: its ext does not parse once withheld`);
      return OUTPUT_INVALID;
    }
    out = { ...out, ext: { ...out.ext, data: parsed.data } };
  }

  if (out.kind === "feed" && isPlain(out.body) && Array.isArray(out.body.entries)) {
    const entries: unknown[] = [];
    for (const [i, item] of out.body.entries.entries()) {
      const embed = isPlain(item) ? item.embed : undefined;
      if (!isPlain(item) || !isPlain(embed) || embed.type !== "view" || !isPlain(embed.model)) {
        entries.push(item);
        continue;
      }
      const inner = applyEntry(embed.model, snapshot, `${at}body.entries.${i}.embed.model.`, withheld);
      if (!inner.ok) return inner;
      entries.push({ ...item, embed: { ...embed, model: inner.model } });
    }
    out = { ...out, body: { ...out.body, entries } };
  }
  return { ok: true, model: out };
}

/** The feed entries, at any depth of embedded models, whose embed was withheld. */
function withheldEmbeds(model: ViewModel): AssistantWithheld[] {
  if (model.kind !== "feed") return [];
  return model.body.entries.flatMap((entry): AssistantWithheld[] => {
    const embed = entry.embed;
    if (isDeepStrictEqual(embed, WITHHELD_EMBED)) return [{ what: "embed", entry: entry.id, note: WITHHELD_NOTE }];
    return embed?.type === "view" ? withheldEmbeds(embed.model) : [];
  });
}

/**
 * Why an attached view an assistant may read is not in the model's list
 * (attachedViews in ./view.ts leaves one out when its plugin's gate refuses
 * it or cannot be read, or when its path cannot be filled here): the gate's
 * own refusal, else NOT_ATTACHED. So an assistant can tell a view that could
 * not be read from one that is not there. If attachedViews leaves a view out
 * for another reason, revisit.
 */
async function whyNotAttached(ctx: HostContext, org: string, candidate: RegisteredView): Promise<HostFailure> {
  let decision: GateDecision;
  try {
    decision = await pluginGate(ctx, org)(candidate.plugin);
  } catch {
    return fail(503, `${candidate.plugin}_gate_unavailable`, "Could not check whether this part of MGM is enabled.");
  }
  if (!decision.ok) return { ok: false, status: decision.status, code: decision.code, message: decision.message };
  return NOT_ATTACHED;
}

/** `href`'s view read for an assistant, with its attached views at depth 0. */
async function readView(
  ctx: HostContext,
  snapshot: SurfaceSnapshot,
  href: string,
  o: { within?: string; depth: 0 | 1; admit: Admit },
): Promise<AssistantOutcome<AssistantView>> {
  const out = await dispatchView(ctx, href, { depth: o.depth, admit: o.admit, ...(o.within === undefined ? {} : { within: o.within }) });
  if (!out.ok) return out;
  const loaded = out.value;
  const view = snapshot.views.find((v) => v.def.id === loaded.view);
  if (!view || loaded.org === null) return VIEW_FAILED;
  const org = loaded.org;

  const withheld: AssistantWithheld[] = [];
  const attached: AssistantView["attached"] = [];
  if (o.depth === 0) {
    // From the surface, not from the model's list, which leaves out a
    // disabled plugin's tabs (attachedViews in ./view.ts) and would tell
    // that plugin's state.
    const candidates = attachmentCandidates(snapshot.views, view.def).sort(
      (a, b) => a.def.attach!.order - b.def.attach!.order || a.def.id.localeCompare(b.def.id),
    );
    for (const candidate of candidates) {
      const hint = candidate.def.attach!.hint;
      const title = attachmentTitle(snapshot, candidate);
      if (!o.admit(candidate.def.id)) {
        withheld.push({ what: "view", view: candidate.def.id, title, hint, note: WITHHELD_NOTE });
        continue;
      }
      const shown = loaded.attached.find((a) => a.view === candidate.def.id);
      const outcome = shown
        ? await readView(ctx, snapshot, shown.href, { within: org, depth: 1, admit: o.admit })
        : await whyNotAttached(ctx, org, candidate);
      attached.push({ view: candidate.def.id, title: shown?.title ?? title, hint, outcome });
    }
  }
  withheld.push(...withheldEmbeds(loaded));

  const { attached: _attached, signals: _signals, live: _live, ...rest } = loaded;
  void [_attached, _signals, _live];
  const stripped = stripActions(rest) as Record<string, unknown>;
  // Before the entry drops any link, so an unlisted link with a refused
  // reference refuses the read as a review failure rather than being
  // dropped with a log line. applyEntry only drops and withholds, so it
  // cannot add a reference this check would refuse.
  const refusal = findRefusedReference(stripped, snapshot.views);
  if (refusal) {
    console.error(`[gui] assistant read ${view.def.id}: a ${refusal.kind} reference at ${refusal.path}`);
    return REFERENCE_REFUSED;
  }
  const applied = applyEntry(stripped, snapshot, "", withheld);
  if (!applied.ok) return applied;
  const model = applied.model as AssistantViewModel;
  return {
    ok: true,
    value: {
      type: "assistant-view",
      view: view.def.id,
      org,
      cost: view.def.cost,
      ext: model.ext?.schema ?? null,
      model,
      attached,
      withheld,
    },
  };
}

/**
 * `value` as an answer, unless it is too large. It is not copied: every
 * object in it is built here or comes out of the host's strict parse of the
 * model or signals (parseOrFail, ./parse.ts), which builds new objects, so
 * it shares nothing a loader, watcher or cache holds. If dispatchView or
 * assistantSignals starts returning a cached or unparsed value, copy it here.
 */
function bounded<T>(value: T): AssistantOutcome<T> {
  let length: number;
  try {
    length = JSON.stringify(value).length;
  } catch {
    return TOO_LARGE;
  }
  return length > ASSISTANT_READ_MAX_CHARS ? TOO_LARGE : { ok: true, value };
}

async function readSignals(ctx: HostContext, requested: string | null | undefined): Promise<AssistantOutcome<AssistantSignals>> {
  let org: string | null;
  try {
    org = (await selectOrganization(ctx, { requested })).organizationId;
  } catch {
    return fail(503, "gui_unavailable", "Signals could not be checked right now.");
  }
  if (org === null) return fail(403, "gui_no_access", "Your account has no organization yet.");
  const out = await assistantSignals(ctx, org, readableWatcher);
  if (!out.ok) return out;
  const { signals, off } = out.value;
  const top = signals.top.map((s): AssistantSignal => {
    if (s.kind !== "proposal") return s;
    const { action: _action, ...rest } = s;
    void _action;
    return rest;
  });
  return {
    ok: true,
    value: {
      type: "assistant-signals",
      org: signals.org,
      count: signals.count,
      attention: signals.attention ?? signals.count,
      top,
      checked: signals.checked,
      unchecked: signals.unchecked,
      off,
    },
  };
}

/**
 * What an assistant may read for `ctx`'s person: a view, by its page href,
 * or the organization's signals. `org` chooses among the organizations the
 * person can see, as `?org=` does; for a view it must also be the view's
 * own, or the answer is a 404.
 */
export async function readForAssistant(ctx: HostContext, request: { type: "view"; href: string; org?: string | null }): Promise<AssistantOutcome<AssistantView>>;
export async function readForAssistant(ctx: HostContext, request: { type: "signals"; org?: string | null }): Promise<AssistantOutcome<AssistantSignals>>;
export async function readForAssistant(ctx: HostContext, request: AssistantReadRequest): Promise<AssistantOutcome<AssistantView | AssistantSignals>>;
export async function readForAssistant(
  ctx: HostContext,
  request: AssistantReadRequest,
): Promise<AssistantOutcome<AssistantView | AssistantSignals>> {
  requireIssued(ctx);
  // A person whose rows are all tenant rows reaches no organization (RFC
  // mgm#197), and decision 10's own-tenant reading is not built: they get
  // the host's own answers, before any read.
  if (!rolesIncludeStaff(ctx.access.roles)) {
    return request.type === "view" ? NOT_FOUND : fail(403, "gui_no_access", "Your account has no organization yet.");
  }
  if (request.type === "signals") {
    // Bounded, though no answer can reach the bound today: the host gives at
    // most MAX_TOP (20) signals of at most 4,000 characters each
    // (./signals.ts), about 80,000, so no test reaches it. If those caps grow
    // past ASSISTANT_READ_MAX_CHARS, test this refusal too.
    const out = await readSignals(ctx, request.org);
    return out.ok ? bounded(out.value) : out;
  }

  const parsed = parseHref(request.href);
  if (!parsed) return fail(400, "gui_bad_request", "The link is not valid.");
  if (!isPageHref(request.href)) return NOT_FOUND;
  const snapshot = await surfaceSnapshot();
  const match = matchView(snapshot.views, parsed.path);
  if (!match) return NOT_FOUND;
  const readable = new Set(snapshot.views.filter(readableView).map((v) => v.def.id));
  // Checked before dispatch, so an unlisted view's loader never runs;
  // dispatchView's admit refuses it again.
  if (!readable.has(match.view.def.id)) return NOT_LISTED;
  const out = await readView(ctx, snapshot, request.href, {
    depth: 0,
    admit: (id) => readable.has(id),
    ...(request.org == null ? {} : { within: request.org }),
  });
  return out.ok ? bounded(out.value) : out;
}

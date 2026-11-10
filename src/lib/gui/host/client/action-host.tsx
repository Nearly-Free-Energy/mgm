"use client";

/**
 * The only write path a GUI has. kit.act(ref) reaches the mounted host, which
 * prepares the action (POST /api/gui/prepare), shows its form, runs the
 * host-owned confirmation step (decision 5 on #115), sends the write with
 * ./invoke.ts and refreshes the view. One action runs at a time. A failure is
 * shown as the route's message, or resolved as an ActionResult, never thrown.
 *
 * The level the host runs is the prepared action's top-level `confirm`, which
 * prepare raises for a proposal; `spec.confirm` is the action's own level.
 *
 * A GUI's Overlay frames the step but never holds it. Its one child is
 * HostSlot, an element with no props that only places a node the host owns,
 * and the host renders the step into that node through a portal. So nothing
 * the Overlay is handed or can reach through React (props, children, what
 * HostSlot reads when called) carries the step or a function that confirms
 * or sends; onDismiss, which cancels, is the one thing it can call. The
 * kit's frame (kit/overlay.tsx), used when the GUI brings none, gets the same
 * slot. A form's `submit` only hands a copy of its values to the host.
 *
 * Without a bespoke form that reads the action's input version, the kit's
 * form (kit/action-form.tsx) is used. At level confirm with the kit's form,
 * the confirmation is that form's footer, one step (spec 9.2): the host
 * renders the footer, and its Confirm reaches `send` with the same checks as
 * the separate step's. A bespoke form, or a ceremony with facts, warnings or
 * acknowledgements, gets the separate step.
 *
 * `send` is the one call that writes, and it makes its checks itself, when
 * it is called. After a confirmation step: this flow's step is on screen and
 * not busy, the event is the person's own click on the host's Confirm button
 * while the browser dispatches it, and the host's own record of ticks and
 * typing, kept from real input on the step's own controls, meets what the
 * prepared action requires; the confirmation sent is built from the prepared
 * action. Without a step: the level is none and the person's gesture started
 * the action. A flow and its prepared action are frozen once made. The routes
 * stay the authority for every write (ADR-006, decision 3).
 */
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  ActionRef,
  ActionResult,
  Confirm,
  Confirmation,
  FormProps,
  GuiPlugin,
  Json,
  OverlayProps,
  SyncComponent,
  ViewModel,
} from "../../contract";
import type { PreparedAction } from "../server/prepare";
import { failureOf, invoke } from "./invoke";
import { mountActionHost, useKitRuntime, type KitRuntime } from "./kit-runtime";
import {
  hasUserActivation,
  isClickOn,
  isLiveEventOn,
  isTrusted,
  readInput,
  TICK_EVENTS,
  TYPING_EVENTS,
} from "./trusted";

// Loaded on first use, so pages that never write do not carry them.
const ConfirmStep = lazy(() => import("./confirm-step").then((m) => ({ default: m.ConfirmStep })));
const ConfirmFooter = lazy(() => import("./confirm-step").then((m) => ({ default: m.ConfirmFooter })));
const KitOverlay = lazy(() => import("../../kit/overlay").then((m) => ({ default: m.Overlay })));
const KitForm = lazy(() => import("../../kit/action-form").then((m) => ({ default: m.ActionForm })));

/** What the active GUI may bring: its frame and its bespoke forms. */
export interface ActionHostSlots {
  Overlay?: SyncComponent<OverlayProps>;
  forms?: GuiPlugin["forms"];
}

type Failure = ActionResult & { ok: false };
const refusal = (code: string, message: string): Failure => ({ type: "result", ok: false, status: 0, code, message });
const CANCELLED = refusal("cancelled", "Cancelled.");
const BUSY = refusal("busy", "Another action is still open.");

/** One act() call, frozen when made; only `state` changes. */
type Flow = Readonly<{
  ref: ActionRef;
  prepared: PreparedAction;
  level: Confirm;
  hasForm: boolean;
  /** The GUI's bespoke form, when one applies; otherwise the kit's. */
  Form: SyncComponent<FormProps> | null;
  /** The kit's form with the confirmation as its footer. */
  oneStep: boolean;
  /** Keys never handed back to a form. */
  writeOnly: readonly string[];
  /** `shown` is set once the form or the confirmation step is on screen. */
  state: { shown: boolean; sending: boolean };
  resolve(result: ActionResult): void;
}>;
type Shown = {
  flow: Flow;
  step: "form" | "confirm";
  busy: boolean;
  error: { message: string; field?: string } | null;
  values: Json | null;
  /** Changes whenever a different flow or step comes on screen, which remounts the step. */
  round: number;
};
/** The host's record of a confirmation step's ticks and typing, for the round it was shown in. */
type Progress = { round: number; acknowledged: Set<string>; typed: string };
/** What lets `send` write: the person's click on Confirm, or a gesture for a none-level action. */
type Proof =
  | { kind: "click"; event: MouseEvent<HTMLButtonElement>; values?: Json }
  | { kind: "gesture"; values: Json | null; activated: boolean };

const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Freezes `value` and everything in it. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) frozen(member);
  }
  return value;
}

/** The node the host renders a GUI-framed step into; only HostSlot reads it. */
const SlotContext = createContext<HTMLElement | null>(null);

/**
 * The one child a GUI's Overlay receives. It has no props, and rendering or
 * calling it yields an empty element with a ref object: it only places the
 * host's node where the Overlay puts it.
 */
function HostSlot() {
  const slot = useContext(SlotContext);
  const holder = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const at = holder.current;
    if (!slot || !at) return;
    at.appendChild(slot);
    return () => {
      if (slot.parentNode === at) at.removeChild(slot);
    };
  }, [slot]);
  return <div ref={holder} className="contents" />;
}

/** A copy of a form's values, so a later change to the form's object changes nothing sent; undefined when not JSON. */
function copyOf(values: Json): Json | undefined {
  try {
    const text = JSON.stringify(values);
    return text === undefined ? undefined : (JSON.parse(text) as Json);
  } catch {
    return undefined;
  }
}

/**
 * The confirmation to send, built from the prepared action, or null when the
 * host's record does not tick every acknowledgement or type the exact name
 * the action's level asks for.
 */
function required(prepared: PreparedAction, level: Confirm, progress: Progress): Confirmation | null {
  const { ceremony } = prepared;
  const acknowledgements = (ceremony?.acknowledgements ?? []).map((a) => a.id);
  const ticked = progress.acknowledged;
  if (ticked.size !== acknowledgements.length || acknowledgements.some((id) => !ticked.has(id))) return null;
  const expected = level === "typed" || level === "ceremony" ? ceremony?.typed : undefined;
  if (expected !== undefined && progress.typed.trim() !== expected) return null;
  return {
    ...(ceremony?.digest === undefined ? {} : { digest: ceremony.digest }),
    acknowledged: acknowledgements,
    ...(expected === undefined ? {} : { typed: expected }),
  };
}

/** Keys an input schema may carry and still have no person-entered field. */
const EMPTY_KEYS = new Set(["$schema", "type", "properties", "required", "additionalProperties", "title", "description"]);

/**
 * Whether the input has person-entered fields, and which keys are secrets.
 * Only an object schema with no properties and nothing else that admits a
 * field counts as empty; any other shape (a union, an intersection, a record)
 * gets the form step, which falls back to Cancel only when nothing renders it.
 */
function fieldsOf(input: Json): { any: boolean; writeOnly: string[] } {
  const writeOnly: string[] = [];
  const collect = (node: Json, depth: number) => {
    if (!isObject(node) || depth > 8) return;
    if (isObject(node.properties)) {
      for (const [key, field] of Object.entries(node.properties)) {
        if (isObject(field) && field.writeOnly === true) writeOnly.push(key);
      }
    }
    for (const branch of ["anyOf", "oneOf", "allOf"]) {
      const members = node[branch];
      if (Array.isArray(members)) for (const member of members) collect(member, depth + 1);
    }
  };
  collect(input, 0);
  const empty =
    isObject(input) &&
    input.type === "object" &&
    isObject(input.properties) &&
    Object.keys(input.properties).length === 0 &&
    (input.additionalProperties === undefined || input.additionalProperties === false) &&
    Object.keys(input).every((key) => EMPTY_KEYS.has(key));
  return { any: !empty, writeOnly };
}

const withoutKeys = (values: Json | null, keys: readonly string[]): Json | null =>
  isObject(values) ? Object.fromEntries(Object.entries(values).filter(([k]) => !keys.includes(k))) : values;

/** A write needs a step unless its level is none and the person's own gesture started it. */
const needsStep = (level: Confirm, activated: boolean) => level !== "none" || !activated;

async function prepare(runtime: KitRuntime, ref: ActionRef, initial: Json | undefined): Promise<PreparedAction | Failure> {
  const start =
    isObject(ref.prefill) && isObject(initial) ? { ...ref.prefill, ...initial } : (initial ?? ref.prefill);
  const body = {
    action: ref.action,
    params: ref.params,
    ...(start === undefined ? {} : { body: start }),
    ...(ref.provenance ? { provenance: ref.provenance } : {}),
  };
  let response: Response;
  try {
    response = await runtime.fetch("/api/gui/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return refusal("network", "The action could not be prepared. Check your connection.");
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok && isObject(json) && json.type === "prepared") return frozen(json) as unknown as PreparedAction;
  return failureOf(response.ok ? 500 : response.status, json);
}

export function ActionHost({ Overlay, forms, model = null }: ActionHostSlots & { model?: ViewModel | null }) {
  const runtime = useKitRuntime();
  const flow = useRef<Flow | null>(null);
  /** Taken before prepare is sent, so a second act() waits for nothing. */
  const claimed = useRef(false);
  const mounted = useRef(false);
  const [shown, setShown] = useState<Shown | null>(null);
  /** The step on screen, read when a form submits or Confirm is clicked; `show` keeps it and `shown` together. */
  const step = useRef<Shown | null>(null);
  const rounds = useRef(0);
  const progress = useRef<Progress | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  /** Reads the kit form's values for a one-step confirm; set by the form. */
  const reader = useRef<(() => Json | null) | null>(null);
  const bind = useCallback((read: (() => Json | null) | null) => void (reader.current = read), []);
  const statementId = useId();
  /** Where a GUI-framed step is rendered; created in the browser only. */
  const [slot] = useState(() =>
    typeof document === "undefined" ? null : Object.assign(document.createElement("div"), { className: "contents" }),
  );
  /** `fresh` shows the same step again as a new round, which remounts it. */
  const show = useCallback((next: Omit<Shown, "round"> | null, fresh = false) => {
    const prev = step.current;
    const same = !fresh && next !== null && prev !== null && prev.flow === next.flow && prev.step === next.step;
    const round = same ? prev.round : (rounds.current += 1);
    if (!same && (next?.step === "confirm" || next?.flow.oneStep)) progress.current = { round, acknowledged: new Set(), typed: "" };
    step.current = next && { ...next, round };
    setShown(step.current);
  }, []);

  /** Ends `target`'s flow; a call for a flow that has already ended does nothing. */
  const finish = useCallback(
    (target: Flow, result: ActionResult) => {
      if (flow.current !== target) return;
      flow.current = null;
      claimed.current = false;
      show(null);
      target.resolve(result);
    },
    [show],
  );

  /** The one call that writes; it checks `proof` itself and sends nothing when it falls short. */
  const send = useCallback(
    async (current: Flow, proof: Proof) => {
      if (flow.current !== current || current.state.sending) return;
      let values: Json | null;
      let confirmation: Confirmation | undefined;
      if (proof.kind === "click") {
        const open = step.current;
        const record = progress.current;
        if (!open || open.flow !== current || open.busy) return;
        // On the form step only as the one-step footer, with the form's values.
        if (open.step === "form" && (!current.oneStep || proof.values === undefined)) return;
        if (!isTrusted(proof.event) || !isClickOn(proof.event, confirmButton.current)) return;
        const made = record?.round === open.round ? required(current.prepared, current.level, record) : null;
        if (!made) return;
        values = open.step === "form" ? proof.values! : open.values;
        confirmation = made;
      } else {
        if (current.level !== "none" || !proof.activated) return;
        values = proof.values;
      }
      current.state.sending = true;
      const now = step.current;
      if (now && now.flow === current) show({ ...now, busy: true, error: null });
      const result = await invoke(
        current.prepared,
        values,
        { level: current.level, confirmation, proposal: current.ref.provenance?.proposal },
        runtime.fetch,
      );
      current.state.sending = false;
      // Unmounted mid-write: report what the route answered, and do nothing else.
      if (!mounted.current) return finish(current, result);
      if (result.ok) {
        finish(current, result);
        if (result.href) runtime.navigate(result.href);
        else runtime.refresh();
      } else if (result.status === 401) {
        finish(current, result);
        window.location.assign("/login");
      } else if (!current.state.shown) {
        finish(current, result);
      } else if (flow.current === current) {
        const error = { message: result.message, ...(result.field ? { field: result.field } : {}) };
        const again = withoutKeys(values, current.writeOnly);
        // A one-step form starts again from what was sent, without its secrets.
        show({ flow: current, step: current.hasForm ? "form" : "confirm", busy: false, error, values: again }, current.oneStep);
      }
    },
    [runtime, finish, show],
  );

  const act = useCallback(
    async (ref: ActionRef, options?: { initial?: Json }): Promise<ActionResult> => {
      // Read before any await: a gesture's activation does not outlast a slow request.
      const activated = hasUserActivation();
      if (!ref.enabled) return refusal("disabled", ref.reason ?? "This action is not available.");
      if (claimed.current) return BUSY;
      claimed.current = true;
      const prepared = await prepare(runtime, ref, options?.initial);
      if (prepared.type !== "prepared" || !mounted.current) {
        claimed.current = false;
        if (prepared.type === "prepared") return CANCELLED;
        if (prepared.status === 401) window.location.assign("/login");
        return prepared;
      }
      const { any, writeOnly } = fieldsOf(prepared.spec.input);
      const values = isObject(prepared.prefill) ? withoutKeys(prepared.prefill, writeOnly) : null;
      const level = prepared.confirm;
      const bespoke = forms?.[prepared.spec.id];
      const Form =
        bespoke && bespoke.reads.includes(prepared.spec.inputVersion) && (level === "none" || level === "confirm")
          ? bespoke.Component
          : null;
      const { ceremony } = prepared;
      const plain = !ceremony || ceremony.facts.length + ceremony.warnings.length + ceremony.acknowledgements.length === 0;
      return new Promise<ActionResult>((resolve) => {
        const current: Flow = Object.freeze({
          ref,
          prepared,
          level,
          hasForm: any,
          Form,
          oneStep: any && !Form && level === "confirm" && plain,
          writeOnly: Object.freeze(writeOnly),
          state: { shown: false, sending: false },
          resolve,
        });
        flow.current = current;
        if (!any && !needsStep(current.level, activated)) return void send(current, { kind: "gesture", values, activated });
        current.state.shown = true;
        show({ flow: current, step: any ? "form" : "confirm", busy: false, error: null, values });
      });
    },
    [runtime, send, show, forms],
  );

  const latest = useRef(act);
  useLayoutEffect(() => {
    latest.current = act;
  }, [act]);
  useLayoutEffect(() => {
    mounted.current = true;
    const unmount = mountActionHost((ref, options) => latest.current(ref, options));
    return () => {
      mounted.current = false;
      unmount();
      // A write in flight settles with the route's answer, never as cancelled.
      const open = flow.current;
      if (open && !open.state.sending) finish(open, CANCELLED);
    };
  }, [finish]);

  if (!shown) return null;
  const current = shown.flow;
  const { spec } = current.prepared;
  const level = current.level;
  // Each callback acts only for its own flow and step: a late call does nothing.
  const onScreen = (which: Shown["step"]) => {
    const open = step.current;
    return (
      flow.current === current && !current.state.sending && open?.flow === current && open.step === which && !open.busy
    );
  };
  const cancel = () => {
    if (flow.current === current && !current.state.sending) finish(current, CANCELLED);
  };
  /** Hands a copy of the form's values to the host; only a none-level action with a fresh gesture is sent without a step. */
  const submit = (values: Json) => {
    if (!onScreen("form")) return;
    const copy = copyOf(values);
    const activated = hasUserActivation();
    if (copy === undefined) {
      show({ ...step.current!, error: { message: "The form's values could not be read." } });
    } else if (needsStep(level, activated)) {
      show({ flow: current, step: "confirm", busy: false, error: null, values: copy });
    } else {
      void send(current, { kind: "gesture", values: copy, activated });
    }
  };
  const confirmed = (event: MouseEvent<HTMLButtonElement>) => void send(current, { kind: "click", event });
  /** The one-step footer's Confirm: reads the kit form's values, then sends with the click as proof. */
  const confirmedWithForm = (event: MouseEvent<HTMLButtonElement>) => {
    if (!isTrusted(event) || !onScreen("form")) return;
    const read = reader.current?.() ?? null;
    const copy = read === null ? undefined : copyOf(read);
    if (copy !== undefined) void send(current, { kind: "click", event, values: copy });
  };
  /** The host's record for this round, when `event` is real input the browser is dispatching at `input`. */
  const recordFor = (event: ChangeEvent<HTMLInputElement>, input: HTMLInputElement, types: readonly string[]) => {
    const record = progress.current;
    if (!onScreen("confirm") || record?.round !== step.current?.round) return null;
    if (!(input instanceof HTMLInputElement) || !isTrusted(event) || !isLiveEventOn(event, input, types)) return null;
    return record;
  };
  const acknowledgementIds = (current.prepared.ceremony?.acknowledgements ?? []).map((a) => a.id);
  const ticked = (id: string, event: ChangeEvent<HTMLInputElement>, input: HTMLInputElement) => {
    const record = recordFor(event, input, TICK_EVENTS);
    if (!record || !acknowledgementIds.includes(id)) return;
    if (readInput(input).checked) record.acknowledged.add(id);
    else record.acknowledged.delete(id);
  };
  const typed = (event: ChangeEvent<HTMLInputElement>, input: HTMLInputElement) => {
    const record = recordFor(event, input, TYPING_EVENTS);
    if (record) record.typed = readInput(input).value;
  };
  const tone = current.ref.tone === "danger" || level === "typed" || level === "ceremony" ? "danger" : "neutral";
  const formProps: FormProps = {
    spec,
    actionRef: current.ref,
    model,
    initial: shown.values,
    busy: shown.busy,
    error: shown.error,
    submit,
    cancel,
  };
  const Bespoke = current.Form;
  const statement = current.prepared.ceremony?.statement;
  const footer = current.oneStep ? (
    <>
      {statement && (
        <p id={statementId} className="px-6">
          {statement}
        </p>
      )}
      <ConfirmFooter
        title={spec.title}
        tone={tone}
        ready={!shown.busy}
        describedBy={statement ? statementId : undefined}
        onConfirm={confirmedWithForm}
        onCancel={cancel}
        confirmRef={confirmButton}
      />
    </>
  ) : undefined;

  const content = (
    <Suspense fallback={null}>
      {shown.step === "form" ? (
        Bespoke ? (
          <Bespoke key={shown.round} {...formProps} />
        ) : (
          <KitForm key={shown.round} {...formProps} footer={footer} bind={bind} />
        )
      ) : (
        <ConfirmStep
          key={shown.round}
          level={level === "none" ? "confirm" : level}
          title={spec.title}
          tone={tone}
          ceremony={current.prepared.ceremony}
          busy={shown.busy}
          error={shown.error?.message ?? null}
          onConfirm={confirmed}
          onTick={ticked}
          onType={typed}
          onCancel={cancel}
          confirmRef={confirmButton}
        />
      )}
    </Suspense>
  );
  const frame = { title: spec.title, tone, role: shown.step, onDismiss: cancel } as const;

  return (
    <Suspense fallback={null}>
      <SlotContext.Provider value={slot}>
        {Overlay ? (
          <Overlay {...frame}>
            <HostSlot />
          </Overlay>
        ) : (
          <KitOverlay {...frame}>
            <HostSlot />
          </KitOverlay>
        )}
      </SlotContext.Provider>
      {slot && createPortal(content, slot)}
    </Suspense>
  );
}

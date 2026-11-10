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
 */
import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
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
import { hasUserActivation } from "./trusted";

const ConfirmStep = lazy(() => import("./confirm-step").then((m) => ({ default: m.ConfirmStep })));
const HostOverlay = lazy(() => import("./action-frame").then((m) => ({ default: m.HostOverlay })));
const NoForm = lazy(() => import("./action-frame").then((m) => ({ default: m.NoForm })));

/** What the active GUI may bring: its frame, its bespoke forms, and the kit's form. */
export interface ActionHostSlots {
  Overlay?: SyncComponent<OverlayProps>;
  forms?: GuiPlugin["forms"];
  /** The kit's form for any supported input; without one, an action with fields offers Cancel only. */
  Form?: SyncComponent<FormProps>;
}

type Failure = ActionResult & { ok: false };
const refusal = (code: string, message: string): Failure => ({ type: "result", ok: false, status: 0, code, message });
const CANCELLED = refusal("cancelled", "Cancelled.");
const BUSY = refusal("busy", "Another action is still open.");

type Flow = {
  ref: ActionRef;
  prepared: PreparedAction;
  level: Confirm;
  hasForm: boolean;
  /** Keys never handed back to a form. */
  writeOnly: readonly string[];
  /** Set once the form or the confirmation step is on screen. */
  shown: boolean;
  sending: boolean;
  resolve(result: ActionResult): void;
};
type Shown = {
  flow: Flow;
  step: "form" | "confirm";
  busy: boolean;
  error: { message: string; field?: string } | null;
  values: Json | null;
};

const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

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
  if (response.ok && isObject(json) && json.type === "prepared") return json as unknown as PreparedAction;
  return failureOf(response.ok ? 500 : response.status, json);
}

export function ActionHost({ Overlay, forms, Form, model = null }: ActionHostSlots & { model?: ViewModel | null }) {
  const runtime = useKitRuntime();
  const flow = useRef<Flow | null>(null);
  /** Taken before prepare is sent, so a second act() waits for nothing. */
  const claimed = useRef(false);
  const mounted = useRef(false);
  const [shown, setShown] = useState<Shown | null>(null);

  /** Ends `target`'s flow; a call for a flow that has already ended does nothing. */
  const finish = useCallback((target: Flow, result: ActionResult) => {
    if (flow.current !== target) return;
    flow.current = null;
    claimed.current = false;
    setShown(null);
    target.resolve(result);
  }, []);

  const send = useCallback(
    async (current: Flow, values: Json | null, confirmation?: Confirmation) => {
      if (flow.current !== current || current.sending) return;
      current.sending = true;
      setShown((s) => (s && s.flow === current ? { ...s, busy: true, error: null } : s));
      const result = await invoke(
        current.prepared,
        values,
        { level: current.level, confirmation, proposal: current.ref.provenance?.proposal },
        runtime.fetch,
      );
      current.sending = false;
      // Unmounted mid-write: report what the route answered, and do nothing else.
      if (!mounted.current) return finish(current, result);
      if (result.ok) {
        finish(current, result);
        if (result.href) runtime.navigate(result.href);
        else runtime.refresh();
      } else if (result.status === 401) {
        finish(current, result);
        window.location.assign("/login");
      } else if (!current.shown) {
        finish(current, result);
      } else if (flow.current === current) {
        const error = { message: result.message, ...(result.field ? { field: result.field } : {}) };
        const again = withoutKeys(values, current.writeOnly);
        setShown({ flow: current, step: current.hasForm ? "form" : "confirm", busy: false, error, values: again });
      }
    },
    [runtime, finish],
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
      return new Promise<ActionResult>((resolve) => {
        const current: Flow = {
          ref,
          prepared,
          level: prepared.confirm,
          hasForm: any,
          writeOnly,
          shown: false,
          sending: false,
          resolve,
        };
        flow.current = current;
        if (!any && !needsStep(current.level, activated)) return void send(current, values);
        current.shown = true;
        setShown({ flow: current, step: any ? "form" : "confirm", busy: false, error: null, values });
      });
    },
    [runtime, send],
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
      if (open && !open.sending) finish(open, CANCELLED);
    };
  }, [finish]);

  if (!shown) return null;
  const current = shown.flow;
  const { spec } = current.prepared;
  const level = current.level;
  // Each callback acts only for its own flow: a late call from an ended one does nothing.
  const cancel = () => {
    if (flow.current === current && !current.sending) finish(current, CANCELLED);
  };
  const submit = (values: Json) => {
    if (flow.current !== current || current.sending) return;
    if (needsStep(level, hasUserActivation())) setShown({ flow: current, step: "confirm", busy: false, error: null, values });
    else void send(current, values);
  };
  const bespoke = forms?.[spec.id];
  const FormView =
    bespoke && bespoke.reads.includes(spec.inputVersion) && (level === "none" || level === "confirm")
      ? bespoke.Component
      : (Form ?? NoForm);
  const Frame = Overlay ?? HostOverlay;
  const tone = current.ref.tone === "danger" || level === "typed" || level === "ceremony" ? "danger" : "neutral";

  return (
    <Suspense fallback={null}>
      <Frame title={spec.title} tone={tone} role={shown.step} onDismiss={cancel}>
        <Suspense fallback={null}>
          {shown.step === "form" ? (
            <FormView
              spec={spec}
              actionRef={current.ref}
              model={model}
              initial={shown.values}
              busy={shown.busy}
              error={shown.error}
              submit={submit}
              cancel={cancel}
            />
          ) : (
            <ConfirmStep
              level={level === "none" ? "confirm" : level}
              title={spec.title}
              tone={tone}
              ceremony={current.prepared.ceremony}
              busy={shown.busy}
              error={shown.error?.message ?? null}
              onConfirm={(confirmation) => void send(current, shown.values, confirmation)}
              onCancel={cancel}
            />
          )}
        </Suspense>
      </Frame>
    </Suspense>
  );
}

import { act as flush, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Children, cloneElement, isValidElement, useEffect, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRef, ActionResult, FormProps, Json, OverlayProps } from "../../../contract";
import type { PreparedAction } from "../../server/prepare";
import { KitProvider } from "../kit-provider";
import { act, hostAct, KitRuntimeProvider } from "../kit-runtime";
import { initial, manifest, MG, recordingRuntime } from "./kit-test-utils";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null }));
// jsdom creates only untrusted events and has no userActivation: both stand in
// here. isClickOn stays real, so the host's check of the click itself runs.
const input = vi.hoisted(() => ({ trusted: true, active: true }));
vi.mock("../trusted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../trusted")>()),
  isTrusted: () => input.trusted,
  hasUserActivation: () => input.active,
}));

const PATH = `/api/microgrids/${MG}/name`;
const PROPOSAL = "00000000-0000-4000-8000-0000000000f1";
const realLocation = window.location;
const assign = vi.fn();

// The host loads its steps and frame lazily. Importing them once here keeps
// the first cold import out of a test's 1 s wait for the step to appear; the
// list matches the lazy() calls in action-host.tsx, so a new one goes here too.
beforeAll(async () => {
  await Promise.all([import("../confirm-step"), import("../../../kit/overlay"), import("../../../kit/action-form")]);
});

beforeEach(() => {
  input.trusted = true;
  input.active = true;
  assign.mockReset();
  Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign } });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

const ref = (over: Partial<ActionRef> = {}): ActionRef => ({
  action: "metering.rename",
  params: { microgrid_id: MG },
  label: "Rename",
  enabled: true,
  ...over,
});

const FIELDS = {
  type: "object",
  properties: { name: { type: "string" }, pin: { type: "string", writeOnly: true } },
  required: ["name"],
};

type PreparedOver = Partial<PreparedAction> & {
  specConfirm?: PreparedAction["confirm"];
  fields?: boolean;
  input?: Json;
  inputVersion?: number;
};

function prepared(over: PreparedOver = {}) {
  const { specConfirm, fields = true, input: schema, inputVersion = 1, ...rest } = over;
  return {
    type: "prepared",
    spec: {
      type: "spec",
      id: "metering.rename",
      title: "Rename site",
      confirm: specConfirm ?? rest.confirm ?? "confirm",
      inputVersion,
      input: schema ?? (fields ? FIELDS : { type: "object", properties: {} }),
    },
    confirm: "confirm",
    method: "PATCH",
    path: PATH,
    bound: { microgrid_id: MG },
    ceremony: null,
    ...rest,
  } as PreparedAction;
}

/** A route's answer; `wait` holds it back until the test releases it, `fail` rejects as a network error. */
type Reply = { status?: number; body?: unknown; wait?: Promise<unknown>; fail?: boolean };

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Mounts a KitProvider (which mounts the ActionHost) on a runtime whose fetch answers prepare and the write. */
function mount(prepare: Reply, write: Reply = { body: {} }, slots: Parameters<typeof KitProvider>[0]["actions"] = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    const reply = url === "/api/gui/prepare" ? prepare : write;
    await reply.wait;
    if (reply.fail) throw new TypeError("Failed to fetch");
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  });
  const runtime = recordingRuntime({ fetch, act: hostAct });
  const { unmount } = render(
    <KitRuntimeProvider runtime={runtime}>
      <KitProvider manifest={manifest()} initial={initial} actions={slots}>
        {null}
      </KitProvider>
    </KitRuntimeProvider>,
  );
  const writes = () => fetch.mock.calls.filter(([url]) => url !== "/api/gui/prepare");
  const sent = (i = 0) => JSON.parse(String(writes()[i][1]!.body));
  return { fetch, runtime, writes, sent, unmount };
}

/** A bespoke form: shows its initial values and error, and submits `values`. */
function formSubmitting(values: Json) {
  return function TestForm({ initial: start, error, submit, cancel, busy }: FormProps) {
    return (
      <div>
        <output data-testid="initial">{JSON.stringify(start)}</output>
        {error && <p data-testid="error">{`${error.field}: ${error.message}`}</p>}
        <button type="button" disabled={busy} onClick={() => submit(values)}>
          Submit form
        </button>
        <button type="button" onClick={cancel}>
          Cancel form
        </button>
      </div>
    );
  };
}
const TestForm = formSubmitting({ name: "Kasenge", microgrid_id: "spoofed", confirmation: {} } as Json);
const forms = { "metering.rename": { reads: [1], Component: TestForm } };
const NO_FORM = "This action needs a form this interface does not offer.";

const confirmButton = (name = "Rename site") => screen.findByRole("button", { name });

describe("ActionHost", () => {
  it("refuses with no host mounted", async () => {
    await expect(hostAct(ref())).resolves.toMatchObject({ ok: false, code: "no_action_host" });
  });

  it("sends nothing for a disabled ref", async () => {
    const { fetch } = mount({ body: prepared() });
    await expect(act(ref({ enabled: false, reason: "Billing is off" }))).resolves.toMatchObject({
      ok: false,
      code: "disabled",
      message: "Billing is off",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prepares, shows the form, confirms, writes to the prepared route and refreshes", async () => {
    const { fetch, runtime, writes, sent } = mount(
      { body: prepared({ prefill: { name: "Old", pin: "1234" } }) },
      { body: { ok: true } },
      { forms },
    );
    const proposal = { by: "watcher" as const, at: "2026-11-10T12:00:00.000Z" };
    const done = act(ref({ prefill: { name: "Old" }, provenance: proposal }), { initial: { name: "Older" } });

    await screen.findByRole("button", { name: "Submit form" });
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).toEqual({
      action: "metering.rename",
      params: { microgrid_id: MG },
      body: { name: "Older" },
      provenance: proposal,
    });
    // writeOnly values are never handed to a form, whatever prepare returned.
    expect(screen.getByTestId("initial").textContent).toBe('{"name":"Old"}');

    fireEvent.click(screen.getByRole("button", { name: "Submit form" }));
    fireEvent.click(await confirmButton());
    await expect(done).resolves.toEqual({ type: "result", ok: true });

    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0];
    expect(url).toBe(PATH);
    expect(init).toMatchObject({ method: "PATCH", cache: "no-store", credentials: "same-origin", redirect: "error" });
    expect(init!.headers).toEqual({ "content-type": "application/json" });
    // Bound fields win over the form's, and no confirmation goes to a confirm-level route.
    expect(sent()).toEqual({ name: "Kasenge", microgrid_id: MG });
    expect(runtime.refresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Rename site" })).toBeNull());
  });

  it("sends the person's confirmation to a typed route, never through a bespoke form", async () => {
    const ceremony = { type: "ceremony" as const, statement: "Rename?", facts: [], warnings: [], acknowledgements: [{ id: "a", label: "Sure" }], typed: "Kasenge", digest: "d9" };
    const { sent, writes } = mount({ body: prepared({ confirm: "typed", fields: false, ceremony }) }, { body: {} }, { forms });
    const done = act(ref());
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Kasenge" } });
    fireEvent.click(await confirmButton());
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ microgrid_id: MG, confirmation: { digest: "d9", acknowledged: ["a"], typed: "Kasenge" } });
  });

  it("uses the kit's form, not a bespoke one, for a ceremony action", async () => {
    mount({ body: prepared({ confirm: "ceremony", ceremony: { type: "ceremony", statement: "x", facts: [], warnings: [], acknowledgements: [] } }) }, undefined, { forms });
    const done = act(ref());
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit form" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(done).resolves.toMatchObject({ ok: false, code: "cancelled" });
  });

  it("resolves a prepare refusal as its ActionResult, writing nothing", async () => {
    const refusal = { type: "result", ok: false, status: 409, code: "gui_action_unavailable", message: "The period is closed." };
    const { writes } = mount({ status: 409, body: refusal });
    await expect(act(ref())).resolves.toEqual(refusal);
    expect(writes()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses a human-only action proposed by something else", async () => {
    const refusal = { type: "result", ok: false, status: 403, code: "gui_human_only", message: "Only a person can start this action." };
    const { fetch, writes } = mount({ status: 403, body: refusal });
    const provenance = { by: "assistant" as const, proposal: PROPOSAL, at: "2026-11-10T12:00:00.000Z" };
    await expect(act(ref({ provenance }))).resolves.toMatchObject({ ok: false, code: "gui_human_only" });
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body)).provenance).toEqual(provenance);
    expect(writes()).toHaveLength(0);
  });

  it("shows the route's message at its field and keeps the form open", async () => {
    const { writes } = mount({ body: prepared({ confirm: "none" }) }, { status: 422, body: { error: "That name is taken.", field: "name" } }, { forms });
    let settled = false;
    const done = act(ref()).then((r) => ((settled = true), r));
    fireEvent.click(await screen.findByRole("button", { name: "Submit form" }));
    expect((await screen.findByTestId("error")).textContent).toBe("name: That name is taken.");
    expect(writes()).toHaveLength(1);
    expect(settled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel form" }));
    await expect(done).resolves.toMatchObject({ ok: false, code: "cancelled" });
  });

  it("goes to /login when the route answers 401", async () => {
    mount({ body: prepared({ fields: false }) }, { status: 401, body: {} });
    const done = act(ref());
    fireEvent.click(await confirmButton());
    await expect(done).resolves.toMatchObject({ ok: false, status: 401 });
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("runs one action at a time and writes once on a double click", async () => {
    const { writes } = mount({ body: prepared({ fields: false }) });
    const done = act(ref());
    const confirm = await confirmButton();
    await expect(act(ref())).resolves.toMatchObject({ ok: false, code: "busy" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("honours a raised top-level level when the action's own is none", async () => {
    const provenance = { by: "watcher" as const, proposal: PROPOSAL, at: "2026-11-10T12:00:00.000Z" };
    const { writes, fetch } = mount({ body: prepared({ specConfirm: "none", confirm: "confirm", fields: false }) });
    const done = act(ref({ provenance }));
    const confirm = await confirmButton();
    expect(writes()).toHaveLength(0);
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(fetch.mock.calls.at(-1)![1]!.headers).toEqual({ "content-type": "application/json", "x-mgm-proposal": PROPOSAL });
  });

  it("writes a none-level action at once after a gesture, and navigates to the route's href", async () => {
    const { writes, runtime, sent } = mount(
      { body: prepared({ confirm: "none", fields: false, prefill: { source: "list" } }) },
      { body: { href: "/microgrids/x" } },
    );
    await expect(act(ref())).resolves.toEqual({ type: "result", ok: true, href: "/microgrids/x" });
    expect(writes()).toHaveLength(1);
    // The same starting values a confirm step would send.
    expect(sent()).toEqual({ source: "list", microgrid_id: MG });
    expect(runtime.navigate).toHaveBeenCalledWith("/microgrids/x");
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("shows a confirm step for a none-level action started without a gesture", async () => {
    input.active = false;
    const { writes } = mount({ body: prepared({ confirm: "none", fields: false }) });
    const done = act(ref());
    const confirm = await confirmButton();
    expect(writes()).toHaveLength(0);
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
  });

  it("ignores an untrusted click on the host's Confirm", async () => {
    input.trusted = false;
    const { writes } = mount({ body: prepared({ fields: false }) });
    void act(ref());
    fireEvent.click(await confirmButton());
    await flush(async () => {});
    expect(writes()).toHaveLength(0);
  });

  it("refuses a prepared route that is not an API path", async () => {
    const { writes } = mount({ body: prepared({ confirm: "none", fields: false, path: "//evil.example/api/x" }) });
    const result: ActionResult = await act(ref());
    expect(result).toMatchObject({ ok: false, code: "gui_bad_action" });
    expect(writes()).toHaveLength(0);
  });

  it("does not use a bespoke form for an input version it does not read, or for a typed action", async () => {
    const first = mount({ body: prepared({ confirm: "confirm", inputVersion: 2 }) }, undefined, { forms });
    const done = act(ref());
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit form" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(done).resolves.toMatchObject({ code: "cancelled" });
    first.unmount();

    const ceremony = { type: "ceremony" as const, statement: "x", facts: [], warnings: [], acknowledgements: [], typed: "Kasenge" };
    mount({ body: prepared({ confirm: "typed", ceremony }) }, undefined, { forms });
    void act(ref());
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit form" })).toBeNull();
  });

  it("shows the form step for an input that is not a plain object, even at level none", async () => {
    const union: Json = { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] };
    const { writes } = mount({ body: prepared({ confirm: "none", input: union }) });
    void act(ref());
    expect(await screen.findByText(NO_FORM)).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it("frames a bespoke form and then the separate confirm step in the GUI's Overlay", async () => {
    const roles: string[] = [];
    function TestOverlay({ role, children }: OverlayProps) {
      roles.push(role);
      return <section data-testid="overlay">{children}</section>;
    }
    const { sent, writes } = mount({ body: prepared() }, undefined, { Overlay: TestOverlay, forms });
    const done = act(ref());
    fireEvent.click(await screen.findByRole("button", { name: "Submit form" }));
    const confirm = await confirmButton();
    expect(writes()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Submit form" })).toBeNull();
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(roles).toContain("form");
    expect(roles).toContain("confirm");
    expect(sent()).toEqual({ name: "Kasenge", microgrid_id: MG });
  });

  it("shows a confirm step when a none-level form submits without a gesture", async () => {
    const { writes } = mount({ body: prepared({ confirm: "none" }) }, undefined, { forms });
    const done = act(ref());
    const submit = await screen.findByRole("button", { name: "Submit form" });
    input.active = false;
    fireEvent.click(submit);
    const confirm = await confirmButton();
    expect(writes()).toHaveLength(0);
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("writes once when a form submits twice in one tick", async () => {
    function Twice({ submit }: FormProps) {
      return (
        <button type="button" onClick={() => (submit({ name: "A" }), submit({ name: "B" }))}>
          Submit twice
        </button>
      );
    }
    const { writes } = mount({ body: prepared({ confirm: "none" }) }, undefined, { forms: { "metering.rename": { reads: [1], Component: Twice } } });
    const done = act(ref());
    fireEvent.click(await screen.findByRole("button", { name: "Submit twice" }));
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("sends nothing for a submit that arrives after Cancel", async () => {
    const late = gate();
    function Slow({ submit, cancel }: FormProps) {
      return (
        <>
          <button type="button" onClick={() => void late.wait.then(() => submit({ name: "Late" }))}>
            Submit later
          </button>
          <button type="button" onClick={cancel}>
            Cancel form
          </button>
        </>
      );
    }
    const { writes } = mount({ body: prepared({ confirm: "none" }) }, undefined, { forms: { "metering.rename": { reads: [1], Component: Slow } } });
    const done = act(ref());
    fireEvent.click(await screen.findByRole("button", { name: "Submit later" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel form" }));
    await expect(done).resolves.toMatchObject({ code: "cancelled" });
    await flush(async () => late.open());
    expect(writes()).toHaveLength(0);
  });

  it("never hands a submitted secret back to the form after a failed write", async () => {
    const PinForm = formSubmitting({ name: "Kasenge", pin: "9999" });
    mount({ body: prepared() }, { status: 422, body: { error: "Wrong PIN.", field: "pin" } }, { forms: { "metering.rename": { reads: [1], Component: PinForm } } });
    void act(ref());
    fireEvent.click(await screen.findByRole("button", { name: "Submit form" }));
    fireEvent.click(await confirmButton());
    expect((await screen.findByTestId("error")).textContent).toBe("pin: Wrong PIN.");
    expect(screen.getByTestId("initial").textContent).toBe('{"name":"Kasenge"}');
  });

  it("reports the write's own result, not a cancel, when Cancel is pressed while it is in flight", async () => {
    const write = gate();
    const { writes } = mount({ body: prepared({ fields: false }) }, { body: {}, wait: write.wait });
    const done = act(ref());
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    write.open();
    await expect(done).resolves.toMatchObject({ ok: true });
  });

  it("resolves cancelled when the host unmounts with a step on screen", async () => {
    const { unmount } = mount({ body: prepared({ fields: false }) });
    const done = act(ref());
    await confirmButton();
    unmount();
    await expect(done).resolves.toMatchObject({ code: "cancelled" });
  });

  it("resolves cancelled, writing nothing, when the host unmounts during prepare", async () => {
    const ready = gate();
    const { unmount, writes } = mount({ body: prepared({ confirm: "none", fields: false }), wait: ready.wait });
    const done = act(ref());
    unmount();
    ready.open();
    await expect(done).resolves.toMatchObject({ code: "cancelled" });
    expect(writes()).toHaveLength(0);
  });

  it("settles a write in flight at unmount with the route's answer, and does not navigate", async () => {
    const write = gate();
    const { unmount, runtime, writes } = mount({ body: prepared({ confirm: "none", fields: false }) }, { body: { href: "/microgrids/x" }, wait: write.wait });
    const done = act(ref());
    await waitFor(() => expect(writes()).toHaveLength(1));
    unmount();
    write.open();
    await expect(done).resolves.toEqual({ type: "result", ok: true, href: "/microgrids/x" });
    expect(runtime.navigate).not.toHaveBeenCalled();
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("goes to /login when prepare answers 401, writing nothing", async () => {
    const { writes } = mount({ status: 401, body: {} });
    await expect(act(ref())).resolves.toMatchObject({ ok: false, status: 401 });
    expect(assign).toHaveBeenCalledWith("/login");
    expect(writes()).toHaveLength(0);
  });

  it("resolves network failures and an unprepared answer, never throwing", async () => {
    const first = mount({ fail: true });
    await expect(act(ref())).resolves.toMatchObject({ ok: false, code: "network" });
    first.unmount();
    const second = mount({ body: prepared({ confirm: "none", fields: false }) }, { fail: true });
    await expect(act(ref())).resolves.toMatchObject({ ok: false, code: "network" });
    second.unmount();
    mount({ body: { type: "result", ok: true } });
    await expect(act(ref())).resolves.toMatchObject({ ok: false, status: 500 });
  });

  it("refuses a prepared method that does not write", async () => {
    const { writes } = mount({ body: prepared({ confirm: "none", fields: false, method: "GET" as never }) });
    await expect(act(ref())).resolves.toMatchObject({ ok: false, code: "gui_bad_action" });
    expect(writes()).toHaveLength(0);
  });

  it("sends no proposal header for a proposal that is not a UUID", async () => {
    const { fetch } = mount({ body: prepared({ confirm: "none", fields: false }) });
    await act(ref({ provenance: { by: "watcher", proposal: "x\r\ny", at: "2026-11-10T12:00:00.000Z" } }));
    expect(fetch.mock.calls.at(-1)![1]!.headers).toEqual({ "content-type": "application/json" });
  });

  it("drops an off-origin href from the route and refreshes instead", async () => {
    const { runtime } = mount({ body: prepared({ confirm: "none", fields: false }) }, { body: { href: "//evil.example/x" } });
    await expect(act(ref())).resolves.toEqual({ type: "result", ok: true });
    expect(runtime.navigate).not.toHaveBeenCalled();
    expect(runtime.refresh).toHaveBeenCalledOnce();
  });

  it("caps the route's message at 300 characters", async () => {
    mount({ body: prepared({ confirm: "none", fields: false }) }, { status: 422, body: { error: "x".repeat(400) } });
    const result = await act(ref());
    expect(result.ok === false && result.message).toHaveLength(300);
  });
});

describe("ActionHost with a GUI's own Overlay and forms", () => {
  const ceremony = {
    type: "ceremony" as const,
    statement: "Rename?",
    facts: [],
    warnings: [],
    acknowledgements: [{ id: "a", label: "Sure" }],
    typed: "Kasenge",
    digest: "d9",
  };
  const typedAction = () => prepared({ confirm: "typed", fields: false, ceremony });
  const forged = { digest: "d9", acknowledged: ["a"], typed: "Kasenge" };
  const forgedEvent = { type: "click", nativeEvent: { isTrusted: true, type: "click", eventPhase: 2 } };

  /** What the person does to confirm the typed action: tick, type the name, click Confirm. */
  async function personConfirms() {
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Kasenge" } });
    fireEvent.click(await confirmButton());
  }

  /** Every function an element's props reach, nested children included, by path. */
  function functionsIn(node: unknown, at = "", found: [string, (...args: unknown[]) => unknown][] = []) {
    if (isValidElement(node)) return functionsIn(node.props, at, found);
    if (node === null || typeof node !== "object" || node instanceof Node) return found;
    for (const [key, value] of Object.entries(node)) {
      const path = at ? `${at}.${key}` : key;
      if (typeof value === "function") found.push([path, value as (...args: unknown[]) => unknown]);
      else functionsIn(value, path, found);
    }
    return found;
  }

  type Handlers = { onClick?: (event: unknown) => void; onChange?: (event: unknown) => void };
  /** The props React keeps on a rendered DOM node, as script on the page could read them. */
  function domProps(node: Element): Handlers {
    const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
    return key ? (node as unknown as Record<string, Handlers>)[key] : {};
  }

  /**
   * A callback the host hands ConfirmStep, reached through React's internals
   * from a node inside it: a probe for the checks the host makes itself,
   * which no GUI-reachable prop leads to.
   */
  function stepProp(node: Element, name: "onConfirm" | "onTick" | "onType"): (...args: unknown[]) => void {
    const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"))!;
    type Fiber = { memoizedProps?: Record<string, unknown>; return: Fiber | null };
    let fiber: Fiber | null = (node as unknown as Record<string, Fiber>)[key];
    while (fiber && typeof fiber.memoizedProps?.[name] !== "function") fiber = fiber.return;
    return fiber!.memoizedProps![name] as (...args: unknown[]) => void;
  }

  /** Enables Confirm in the DOM and has a click on it reach ConfirmStep's onConfirm directly, bypassing its own check. */
  function forwardClicks(confirm: HTMLButtonElement) {
    const onConfirm = stepProp(confirm, "onConfirm");
    const forward = (event: Event) => onConfirm({ nativeEvent: event, target: confirm, currentTarget: confirm });
    confirm.disabled = false;
    confirm.addEventListener("click", forward);
    return () => confirm.removeEventListener("click", forward);
  }

  it("writes nothing when an Overlay calls children.props.onConfirm, walking nested children", async () => {
    const found: string[] = [];
    function Forging({ children }: OverlayProps) {
      useEffect(() => {
        const visit = (node: ReactNode) => {
          if (!isValidElement(node)) return;
          const props = node.props as { onConfirm?: unknown; children?: ReactNode };
          if (typeof props.onConfirm === "function") {
            found.push("onConfirm");
            props.onConfirm(forged, forgedEvent);
          }
          Children.forEach(props.children, visit);
        };
        visit(children);
      });
      return <section>{children}</section>;
    }
    const { writes, sent } = mount({ body: typedAction() }, undefined, { Overlay: Forging });
    const done = act(ref());
    await confirmButton();
    await flush(async () => {});
    expect(found).toEqual([]);
    expect(writes()).toHaveLength(0);

    await personConfirms();
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ microgrid_id: MG, confirmation: forged });
  });

  it("keeps the action's level when an Overlay clones its children with a weaker one", async () => {
    /** Clones every element it reaches, setting a weaker level on each. */
    const weaken = (node: ReactNode): ReactNode =>
      isValidElement(node)
        ? cloneElement(node as ReactElement<{ children?: ReactNode }>, {
            level: "confirm",
            ceremony: null,
            busy: false,
            children: Children.map((node.props as { children?: ReactNode }).children, weaken),
          } as Record<string, unknown>)
        : node;
    function Weakening({ children }: OverlayProps) {
      return <section>{weaken(children)}</section>;
    }
    const { writes } = mount({ body: typedAction() }, undefined, { Overlay: Weakening });
    const done = act(ref());
    const confirm = (await confirmButton()) as HTMLButtonElement;
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    await flush(async () => {});
    expect(writes()).toHaveLength(0);

    await personConfirms();
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("writes nothing when an Overlay calls every function its props reach", async () => {
    let paths: string[] = [];
    function CallsEverything(props: OverlayProps) {
      useEffect(() => {
        const found = functionsIn(props);
        paths = found.map(([path]) => path);
        for (const [, fn] of found) fn(forged, forgedEvent);
      });
      return <section>{props.children}</section>;
    }
    const { writes } = mount({ body: typedAction() }, undefined, { Overlay: CallsEverything });
    const done = act(ref());
    // Dismissing is the only thing an Overlay is handed to call.
    await expect(done).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(paths).toEqual(["onDismiss"]);
    expect(writes()).toHaveLength(0);
  });

  it("hands an Overlay that calls its child's component nothing of the step", async () => {
    const reached: string[] = [];
    const keys = new Set<string>();
    function Peeks({ children }: OverlayProps) {
      // Calls HostSlot itself, inside the host's providers, as script could.
      const made = isValidElement(children) && typeof children.type === "function" ? (children.type as (p: object) => ReactNode)({}) : null;
      reached.push(...functionsIn(made).map(([path]) => path));
      if (isValidElement(made)) for (const key of Object.keys(made.props as object)) keys.add(key);
      useEffect(() => {
        for (const [, fn] of functionsIn(made)) fn(forged, forgedEvent);
      });
      return (
        <section data-testid="overlay">
          {made}
          {children}
        </section>
      );
    }
    const { writes, sent } = mount({ body: typedAction() }, undefined, { Overlay: Peeks });
    const done = act(ref());
    const confirm = (await confirmButton()) as HTMLButtonElement;
    await flush(async () => {});
    expect(reached).toEqual([]);
    expect([...keys].sort()).toEqual(["className", "ref"]);
    // The step is the host's, at its own level, inside the Overlay's frame.
    expect(screen.getByTestId("overlay").contains(confirm)).toBe(true);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    expect(writes()).toHaveLength(0);

    await personConfirms();
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(sent()).toEqual({ microgrid_id: MG, confirmation: forged });
  });

  it("counts no tick or typing that an Overlay hands to the step's controls from another event", async () => {
    function Ticks({ children }: OverlayProps) {
      useEffect(() => {
        const forward = (event: Event) => {
          const box = document.querySelector('input[type="checkbox"]');
          const text = document.querySelector('input[type="text"]');
          if (box) domProps(box).onChange?.({ nativeEvent: event, target: { checked: true }, currentTarget: box });
          if (text) domProps(text).onChange?.({ nativeEvent: event, target: { value: "Kasenge" }, currentTarget: text });
        };
        window.addEventListener("keydown", forward, true);
        window.addEventListener("click", forward, true);
        return () => {
          window.removeEventListener("keydown", forward, true);
          window.removeEventListener("click", forward, true);
        };
      }, []);
      return (
        <section>
          {children}
          <button type="button">Elsewhere</button>
        </section>
      );
    }
    const { writes } = mount({ body: typedAction() }, undefined, { Overlay: Ticks });
    const done = act(ref());
    const confirm = (await confirmButton()) as HTMLButtonElement;
    // The person presses a key and clicks elsewhere: live, trusted events, at other controls.
    fireEvent.keyDown(document.body, { key: "Shift" });
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(confirm.disabled).toBe(true);
    // The same events handed straight to the host's own callbacks, past ConfirmStep's check.
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    const text = screen.getByRole("textbox") as HTMLInputElement;
    const direct = (event: Event) => {
      stepProp(box, "onTick")("a", { nativeEvent: event }, box);
      stepProp(text, "onType")({ nativeEvent: event }, text);
    };
    window.addEventListener("keydown", direct, true);
    box.checked = true;
    text.value = "Kasenge";
    fireEvent.keyDown(document.body, { key: "Shift" });
    window.removeEventListener("keydown", direct, true);
    box.checked = false;
    text.value = "";
    // Nor has the host recorded either: a click reaching onConfirm directly sends nothing.
    const stop = forwardClicks(confirm);
    fireEvent.click(confirm);
    stop();
    await flush(async () => {});
    expect(writes()).toHaveLength(0);
    confirm.disabled = true;

    await personConfirms();
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("builds the confirmation from the host's own record of ticks and typing, at the send", async () => {
    const { writes, sent } = mount({ body: typedAction() });
    const done = act(ref());
    const confirm = (await confirmButton()) as HTMLButtonElement;
    const box = screen.getByRole("checkbox");
    const text = screen.getByRole("textbox");
    const stop = forwardClicks(confirm);
    // Nothing ticked or typed.
    fireEvent.click(confirm);
    // The name typed, the acknowledgement not ticked.
    fireEvent.change(text, { target: { value: "Kasenge" } });
    confirm.disabled = false;
    fireEvent.click(confirm);
    // Ticked, with the wrong name.
    fireEvent.click(box);
    fireEvent.change(text, { target: { value: "Kasenga" } });
    confirm.disabled = false;
    fireEvent.click(confirm);
    // Ticked, typed, then unticked again.
    fireEvent.change(text, { target: { value: "Kasenge" } });
    fireEvent.click(box);
    confirm.disabled = false;
    fireEvent.click(confirm);
    stop();
    await flush(async () => {});
    expect(writes()).toHaveLength(0);

    fireEvent.click(box);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ microgrid_id: MG, confirmation: forged });
  });

  it("records no tick or typing that is not the person's, even when it reaches the host directly", async () => {
    const { writes } = mount({ body: typedAction() });
    void act(ref());
    const confirm = (await confirmButton()) as HTMLButtonElement;
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    const text = screen.getByRole("textbox") as HTMLInputElement;
    const onTick = (event: Event) => stepProp(box, "onTick")("a", { nativeEvent: event }, box);
    const onType = (event: Event) => stepProp(text, "onType")({ nativeEvent: event }, text);
    box.addEventListener("click", onTick);
    text.addEventListener("change", onType);
    input.trusted = false;
    fireEvent.click(box);
    fireEvent.change(text, { target: { value: "Kasenge" } });
    box.removeEventListener("click", onTick);
    text.removeEventListener("change", onType);
    input.trusted = true;
    const stop = forwardClicks(confirm);
    fireEvent.click(confirm);
    stop();
    await flush(async () => {});
    expect(writes()).toHaveLength(0);
  });

  it("checks at the send that the click on Confirm is the person's own", async () => {
    const { writes } = mount({ body: prepared({ fields: false }) });
    const done = act(ref());
    const confirm = (await confirmButton()) as HTMLButtonElement;
    input.trusted = false;
    const stop = forwardClicks(confirm);
    fireEvent.click(confirm);
    stop();
    await flush(async () => {});
    expect(writes()).toHaveLength(0);

    input.trusted = true;
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("checks the click itself at the send, even when script reaches Confirm's handler", async () => {
    function Elsewhere({ children }: OverlayProps) {
      const forward = (event: unknown) => {
        const confirm = document.querySelector("[aria-describedby]");
        if (confirm) domProps(confirm).onClick?.(event);
      };
      return (
        <section>
          {children}
          <button type="button" onClick={forward}>
            Elsewhere
          </button>
        </section>
      );
    }
    const { writes } = mount({ body: prepared({ fields: false }) }, undefined, { Overlay: Elsewhere });
    const done = act(ref());
    const confirm = await confirmButton();
    const handler = domProps(confirm).onClick;
    expect(handler).toBeTypeOf("function");

    await flush(async () => {
      // An object shaped like a click on Confirm.
      handler!({ ...forgedEvent, target: confirm, currentTarget: confirm, nativeEvent: { ...forgedEvent.nativeEvent, target: confirm } });
      // A real click event that is not being dispatched.
      handler!({ type: "click", nativeEvent: new MouseEvent("click") });
    });
    // The person's live click on another button, handed to Confirm's handler.
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    await flush(async () => {});
    expect(writes()).toHaveLength(0);

    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("confirms on the host's own Overlay with the person's click", async () => {
    const { writes, sent } = mount({ body: typedAction() });
    const done = act(ref());
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await personConfirms();
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ microgrid_id: MG, confirmation: forged });
  });

  it("lets a form only hand values over: later submits and changes to its object send nothing new", async () => {
    const kept: { submit?: FormProps["submit"] } = {};
    const values = { name: "First" };
    function Keeping({ submit }: FormProps) {
      useEffect(() => {
        kept.submit = submit;
      });
      return (
        <button type="button" onClick={() => submit(values)}>
          Submit form
        </button>
      );
    }
    const { writes, sent } = mount({ body: prepared() }, undefined, { forms: { "metering.rename": { reads: [1], Component: Keeping } } });
    const done = act(ref());
    fireEvent.click(await screen.findByRole("button", { name: "Submit form" }));
    const confirm = await confirmButton();
    values.name = "Changed";
    await flush(async () => {
      kept.submit!({ name: "Later" });
      kept.submit!({ name: "Later" });
    });
    expect(writes()).toHaveLength(0);
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ name: "First", microgrid_id: MG });
  });

  it("sends nothing, and says so, when a form's values cannot be copied", async () => {
    const circular: Record<string, unknown> = { name: "Loop" };
    circular.self = circular;
    const { writes } = mount({ body: prepared({ confirm: "none" }) }, undefined, {
      forms: { "metering.rename": { reads: [1], Component: formSubmitting(circular as Json) } },
    });
    void act(ref());
    fireEvent.click(await screen.findByRole("button", { name: "Submit form" }));
    expect((await screen.findByTestId("error")).textContent).toContain("The form's values could not be read.");
    await flush(async () => {});
    expect(writes()).toHaveLength(0);
  });

  it("shows the confirm step, writing nothing, whenever a form submits a confirm-level action", async () => {
    function SubmitsAtOnce({ submit }: FormProps) {
      useEffect(() => submit({ name: "Unasked" }), [submit]);
      return null;
    }
    const { writes } = mount({ body: prepared() }, undefined, { forms: { "metering.rename": { reads: [1], Component: SubmitsAtOnce } } });
    const done = act(ref());
    const confirm = await confirmButton();
    await flush(async () => {});
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(done).resolves.toMatchObject({ code: "cancelled" });
    expect(confirm.isConnected).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});

describe("ActionHost with the kit's form", () => {
  type Handlers = { onClick?: (event: unknown) => void };
  const domProps = (node: Element): Handlers => {
    const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
    return key ? (node as unknown as Record<string, Handlers>)[key] : {};
  };
  const name = () => screen.findByRole("textbox", { name: "Name" });

  it("confirms a confirm-level action in one step: the host's footer under the kit's form", async () => {
    const roles: string[] = [];
    function TestOverlay({ role, children }: OverlayProps) {
      roles.push(role);
      return <section>{children}</section>;
    }
    const { writes, sent } = mount({ body: prepared({ prefill: { name: "Old" } }) }, undefined, { Overlay: TestOverlay });
    const done = act(ref());
    fireEvent.change(await name(), { target: { value: "Kasenge" } });
    fireEvent.change(screen.getByLabelText(/Pin/), { target: { value: "1234" } });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(await confirmButton());
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ name: "Kasenge", pin: "1234", microgrid_id: MG });
    expect(new Set(roles)).toEqual(new Set(["form"]));
  });

  it("never sends from an untrusted click, a synthetic one, or a click on anything but the host's Confirm", async () => {
    function Elsewhere({ children }: OverlayProps) {
      const forward = (event: unknown) => {
        const confirm = screen.queryByRole("button", { name: "Rename site" });
        if (confirm) domProps(confirm).onClick?.(event);
      };
      return (
        <section>
          {children}
          <button type="button" onClick={forward}>
            Elsewhere
          </button>
        </section>
      );
    }
    const { writes } = mount({ body: prepared({ prefill: { name: "Kasenge" } }) }, undefined, { Overlay: Elsewhere });
    const done = act(ref());
    await name();
    const confirm = await confirmButton();
    // Script's click on Confirm.
    input.trusted = false;
    fireEvent.click(confirm);
    input.trusted = true;
    await flush(async () => {
      // Objects shaped like a click on Confirm, and a real event not being dispatched.
      domProps(confirm).onClick!({ type: "click", target: confirm, currentTarget: confirm, nativeEvent: { isTrusted: true, type: "click", eventPhase: 2, target: confirm } });
      domProps(confirm).onClick!({ type: "click", nativeEvent: new MouseEvent("click") });
    });
    // The person's click on another button, handed to Confirm's handler.
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    // Enter in a field submits nothing.
    fireEvent.submit((await name()).closest("form")!);
    await flush(async () => {});
    expect(writes()).toHaveLength(0);
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it("sends nothing while a required field is empty, and says where", async () => {
    const { writes } = mount({ body: prepared() });
    void act(ref());
    await name();
    fireEvent.click(await confirmButton());
    await flush(async () => {});
    expect(writes()).toHaveLength(0);
    expect(screen.getByText("Enter a value.")).toBeTruthy();
    expect((await name()).getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the route's field error at the field, keeping the name and dropping the secret", async () => {
    const { writes } = mount({ body: prepared() }, { status: 422, body: { error: "That name is taken.", field: "name" } });
    void act(ref());
    fireEvent.change(await name(), { target: { value: "Kasenge" } });
    fireEvent.change(screen.getByLabelText(/Pin/), { target: { value: "1234" } });
    fireEvent.click(await confirmButton());
    expect(await screen.findByText("That name is taken.")).toBeTruthy();
    expect(writes()).toHaveLength(1);
    expect(((await name()) as HTMLInputElement).value).toBe("Kasenge");
    expect((screen.getByLabelText(/Pin/) as HTMLInputElement).value).toBe("");
    expect((await confirmButton()).isConnected).toBe(true);
  });

  it("keeps the separate step for a typed action under the kit's form", async () => {
    const ceremony = { type: "ceremony" as const, statement: "Rename?", facts: [], warnings: [], acknowledgements: [], typed: "Kasenge" };
    const { writes, sent } = mount({ body: prepared({ confirm: "typed", ceremony }) });
    const done = act(ref());
    fireEvent.change(await name(), { target: { value: "Kasenge" } });
    expect(screen.queryByRole("button", { name: "Rename site" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const confirm = (await confirmButton()) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Kasenge" } });
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(sent()).toEqual({ name: "Kasenge", microgrid_id: MG, confirmation: { acknowledged: [], typed: "Kasenge" } });
  });

  it("keeps the separate step when a confirm-level ceremony asks for acknowledgements", async () => {
    const ceremony = { type: "ceremony" as const, statement: "Rename?", facts: [], warnings: [], acknowledgements: [{ id: "a", label: "Sure" }] };
    const { writes } = mount({ body: prepared({ ceremony }) });
    void act(ref());
    fireEvent.change(await name(), { target: { value: "Kasenge" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("checkbox", { name: "Sure" })).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ["warnings", { warnings: ["Households will see the new name."] }, "Households will see the new name."],
    ["facts", { facts: [{ label: "Site", value: { t: "text" as const, text: "Old" } }] }, "Old"],
  ])("keeps the separate step when a confirm-level ceremony has %s", async (_, over, shownText) => {
    const ceremony = { type: "ceremony" as const, statement: "Rename?", facts: [], warnings: [], acknowledgements: [], ...over };
    const { writes } = mount({ body: prepared({ ceremony }) });
    void act(ref());
    fireEvent.change(await name(), { target: { value: "Kasenge" } });
    expect(screen.queryByRole("button", { name: "Rename site" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await confirmButton();
    expect(screen.getByText(shownText)).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it("shows the ceremony's statement above the one-step footer, describes Confirm by it, and keeps the tone", async () => {
    const ceremony = { type: "ceremony" as const, statement: "Rename this site?", facts: [], warnings: [], acknowledgements: [] };
    mount({ body: prepared({ ceremony }) });
    void act(ref({ tone: "danger" }));
    await name();
    const statement = screen.getByText("Rename this site?");
    const confirm = await confirmButton();
    expect(statement.id).toBeTruthy();
    expect(confirm.getAttribute("aria-describedby")).toBe(statement.id);
    expect(confirm.className).toContain("bg-destructive");
  });

  it("gives the host's Cancel and Confirm 44 px targets on coarse pointers, in one step and in the separate step", async () => {
    const coarse = () => {
      for (const label of ["Cancel", "Rename site"]) {
        expect(screen.getByRole("button", { name: label }).className).toContain("pointer-coarse:min-h-11");
      }
    };
    mount({ body: prepared() });
    void act(ref());
    await confirmButton();
    coarse();
    cleanup();
    mount({ body: prepared({ fields: false }) });
    void act(ref());
    await confirmButton();
    coarse();
  });

  it("disables the one-step Confirm while the write is in flight", async () => {
    const hold = gate();
    const { writes } = mount({ body: prepared({ prefill: { name: "Kasenge" } }) }, { body: {}, wait: hold.wait });
    const done = act(ref());
    await name();
    const confirm = (await confirmButton()) as HTMLButtonElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(writes()).toHaveLength(1);
    hold.open();
    await expect(done).resolves.toMatchObject({ ok: true });
  });

  it("focuses the field the route names after a failed one-step write", async () => {
    mount({ body: prepared() }, { status: 422, body: { error: "That PIN is wrong.", field: "pin" } });
    void act(ref());
    fireEvent.change(await name(), { target: { value: "Kasenge" } });
    fireEvent.change(screen.getByLabelText(/Pin/), { target: { value: "1234" } });
    fireEvent.click(await confirmButton());
    expect(await screen.findByText("That PIN is wrong.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Pin/)));
  });

  /** A whole press, in the order a browser sends it: pointer and mouse down, focus, pointer and mouse up, click. */
  const press = (element: Element) => {
    fireEvent.pointerDown(element, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(element, { button: 0 });
    if (element instanceof HTMLElement) flush(() => element.focus());
    fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
    fireEvent.mouseUp(element, { button: 0 });
    fireEvent.click(element, { button: 0 });
  };
  /** The dialog listens for presses outside it only from the tick after it opens. */
  const settled = () => flush(() => new Promise((resolve) => setTimeout(resolve, 0)));

  it("keeps the default Overlay open through whole presses on the step's field and Confirm, and closes on its backdrop", async () => {
    const { writes, sent } = mount({ body: prepared() });
    const done = act(ref());
    const field = await name();
    await settled();
    press(field);
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Kasenge" } });
    fireEvent.change(screen.getByLabelText(/Pin/), { target: { value: "1234" } });
    press(await confirmButton());
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ name: "Kasenge", pin: "1234", microgrid_id: MG });

    const again = act(ref());
    const panel = await screen.findByRole("dialog");
    await settled();
    const backdrop = panel.previousElementSibling!;
    expect(panel.contains(backdrop)).toBe(false);
    press(backdrop);
    await expect(again).resolves.toMatchObject({ code: "cancelled" });
    expect(writes()).toHaveLength(1);
  });

  it("sends a none-level kit form at once on the person's submit", async () => {
    const { writes, sent } = mount({ body: prepared({ confirm: "none", specConfirm: "none" }) });
    const done = act(ref());
    fireEvent.change(await name(), { target: { value: "Kasenge" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename site" }));
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(writes()).toHaveLength(1);
    expect(sent()).toEqual({ name: "Kasenge", microgrid_id: MG });
  });
});

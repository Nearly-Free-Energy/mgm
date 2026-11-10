import { act as flush, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRef, ActionResult, FormProps, Json, OverlayProps } from "../../../contract";
import type { PreparedAction } from "../../server/prepare";
import { KitProvider } from "../kit-provider";
import { act, hostAct, KitRuntimeProvider } from "../kit-runtime";
import { initial, manifest, MG, recordingRuntime } from "./kit-test-utils";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null }));
// jsdom creates only untrusted events and has no userActivation: both stand in here.
const input = vi.hoisted(() => ({ trusted: true, active: true }));
vi.mock("../trusted", () => ({ isTrusted: () => input.trusted, hasUserActivation: () => input.active }));

const PATH = `/api/microgrids/${MG}/name`;
const PROPOSAL = "00000000-0000-4000-8000-0000000000f1";
const realLocation = window.location;
const assign = vi.fn();

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

  it("uses the host's form, not a bespoke one, for a ceremony action", async () => {
    mount({ body: prepared({ confirm: "ceremony", ceremony: { type: "ceremony", statement: "x", facts: [], warnings: [], acknowledgements: [] } }) }, undefined, { forms });
    const done = act(ref());
    expect(await screen.findByText(NO_FORM)).toBeTruthy();
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
    expect(await screen.findByText(NO_FORM)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit form" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(done).resolves.toMatchObject({ code: "cancelled" });
    first.unmount();

    const ceremony = { type: "ceremony" as const, statement: "x", facts: [], warnings: [], acknowledgements: [], typed: "Kasenge" };
    mount({ body: prepared({ confirm: "typed", ceremony }) }, undefined, { forms });
    void act(ref());
    expect(await screen.findByText(NO_FORM)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit form" })).toBeNull();
  });

  it("shows the form step for an input that is not a plain object, even at level none", async () => {
    const union: Json = { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] };
    const { writes } = mount({ body: prepared({ confirm: "none", input: union }) });
    void act(ref());
    expect(await screen.findByText(NO_FORM)).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it("frames the steps in the GUI's Overlay and renders the kit's Form slot", async () => {
    const roles: string[] = [];
    function TestOverlay({ role, children }: OverlayProps) {
      roles.push(role);
      return <section data-testid="overlay">{children}</section>;
    }
    const { sent } = mount({ body: prepared() }, undefined, { Overlay: TestOverlay, Form: formSubmitting({ name: "Kit" }) });
    const done = act(ref());
    fireEvent.click(await screen.findByRole("button", { name: "Submit form" }));
    fireEvent.click(await confirmButton());
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(roles).toContain("form");
    expect(roles).toContain("confirm");
    expect(sent()).toEqual({ name: "Kit", microgrid_id: MG });
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

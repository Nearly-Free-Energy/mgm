// @vitest-environment jsdom
/**
 * The savings view's two writes, pressed in Gridtop's savings renderer and
 * run by the action host: the kit's form with the right fields and starting
 * values, the host's confirmation where the action asks for one, and the
 * write sent to the action's route with a body its schema parses. The
 * prepare answer is built as prepareAction builds it, which
 * savings-actions.test.ts checks against the real one.
 */
import "@/test/gui-setup";
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import SavingsView from "@/gui/gridtop/renderers/savings/savings-view";
import type { Json, ModelOf } from "@/lib/gui/contract";
import { KitProvider } from "@/lib/gui/host/client/kit-provider";
import { hostAct, KitRuntimeProvider } from "@/lib/gui/host/client/kit-runtime";
import { initial, manifest, recordingRuntime } from "@/lib/gui/host/client/__tests__/kit-test-utils";
import { cleanPrefill } from "@/lib/gui/host/server/merge";
import { actionTone, fillPath } from "@/lib/gui/host/shared/merge-actions";
import type { ActionDef } from "@/lib/gui/surface";
import { kit } from "@/lib/gui/kit";
import { parseJsonBody } from "@/lib/validation/parse-body";
import { AddGridTariffBody, SaveSavingsSettingsBody } from "../../schemas";
import { BILLING_SURFACE } from "../../surface";
import { SAVINGS_EXAMPLES } from "../examples";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null }));
// jsdom creates only untrusted events and has no user activation: both stand
// in here, as in action-host.test.tsx. The host's check of the click target stays real.
vi.mock("@/lib/gui/host/client/trusted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gui/host/client/trusted")>()),
  isTrusted: () => true,
  hasUserActivation: () => true,
}));

const [READY, SETUP] = SAVINGS_EXAMPLES;
const MG = READY.entity!.id;
const defs = BILLING_SURFACE.actions as ActionDef[];

/** What /api/gui/prepare answers for a request, as prepareAction builds it. */
function prepared(request: { action: string; params: Record<string, string>; body?: Json }) {
  const def = defs.find((d) => d.id === request.action)!;
  const prefill = request.body === undefined ? undefined : cleanPrefill(def, request.body);
  return {
    type: "prepared",
    spec: {
      type: "spec",
      id: def.id,
      title: def.title,
      confirm: def.confirm,
      inputVersion: def.inputVersion,
      input: JSON.parse(JSON.stringify(z.toJSONSchema(def.input, { io: "input" }))),
    },
    confirm: def.confirm,
    method: def.method,
    path: fillPath(def.path, request.params),
    bound: {},
    ceremony: null,
    tone: actionTone(def),
    ...(prefill === undefined ? {} : { prefill }),
  };
}

type Reply = { status: number; body: unknown };

function mount(model: ModelOf<"metrics">, reply: (body: unknown) => Promise<Reply> | Reply = () => ({ status: 200, body: {} })) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body));
    const answer = url === "/api/gui/prepare" ? { status: 200, body: prepared(body as Parameters<typeof prepared>[0]) } : await reply(body);
    return Response.json(answer.body, { status: answer.status });
  });
  const runtime = recordingRuntime({ fetch, act: hostAct });
  render(
    <KitRuntimeProvider runtime={runtime}>
      <KitProvider manifest={manifest()} initial={initial}>
        <SavingsView model={model} kit={kit} />
      </KitProvider>
    </KitRuntimeProvider>,
  );
  const writes = () => fetch.mock.calls.filter(([url]) => url !== "/api/gui/prepare");
  const sent = (i = 0) => JSON.parse(String(writes()[i][1]!.body)) as Record<string, unknown>;
  const prepares = () => fetch.mock.calls.filter(([url]) => url === "/api/gui/prepare").map(([, init]) => JSON.parse(String(init!.body)));
  return { runtime, writes, sent, prepares };
}

/** Presses one of the view's own buttons and waits for the kit's form. */
async function open(label: string) {
  await flush(async () => fireEvent.click(screen.getByRole("button", { name: label })));
  return screen.findByRole("dialog", {}, { timeout: 5000 });
}
const field = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;
const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

// The host loads its form and frame on demand; load them once, so no test waits on a cold import.
beforeAll(async () => {
  await Promise.all([import("@/lib/gui/host/client/confirm-step"), import("@/lib/gui/kit/overlay"), import("@/lib/gui/kit/action-form")]);
});
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("editing the savings settings from the savings view", () => {
  it("opens the kit's form on the stored settings and saves them to the route at once", async () => {
    const { writes, sent, prepares, runtime } = mount(READY);
    const dialog = await open("Edit savings settings");
    expect(prepares()).toEqual([{ action: "billing.savings-settings", params: { id: MG }, body: READY.actions[0].prefill }]);
    expect(field(dialog, "Count solar savings from").value).toBe("2025-10-01");
    expect(field(dialog, "Count battery arbitrage from").value).toBe("2026-01-01");
    expect(field(dialog, "Battery round-trip efficiency").value).toBe("0.9");
    expect(within(dialog).getByText("A fraction: 0.9 is 90%.")).toBeTruthy();

    type(field(dialog, "Count battery arbitrage from"), "");
    type(field(dialog, "Battery round-trip efficiency"), "0.85");
    // Level none, pressed by the person: no confirmation step.
    await flush(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Edit savings settings" })));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe(`/api/microgrids/${MG}/savings-settings`);
    expect(writes()[0][1]).toMatchObject({ method: "PUT" });
    expect(sent()).toEqual({ solar_savings_from: "2025-10-01", arbitrage_from: null, round_trip_efficiency: 0.85 });
    expect(SaveSavingsSettingsBody.safeParse(sent()).success).toBe(true);
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the route's refusal at its field and keeps the form open", async () => {
    // The route's own parse: parseJsonBody with the action's input.
    const route = async (body: unknown): Promise<Reply> => {
      const parsed = await parseJsonBody(new Request("http://mgm.test/", { method: "PUT", body: JSON.stringify(body) }), SaveSavingsSettingsBody);
      return parsed.ok ? { status: 200, body: {} } : { status: parsed.response.status, body: await parsed.response.json() };
    };
    const { writes, runtime } = mount(READY, route);
    const dialog = await open("Edit savings settings");
    // The form checks the type; the schema refuses an efficiency of 0.
    type(field(dialog, "Battery round-trip efficiency"), "0");
    await flush(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Edit savings settings" })));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const input = field(await screen.findByRole("dialog"), "Battery round-trip efficiency");
    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("round_trip_efficiency must be a number greater than 0 and at most 1")).toBeTruthy();
    expect(runtime.refresh).not.toHaveBeenCalled();
  });
});

describe("adding a grid tariff version from the savings view", () => {
  it("renders the bands as rows, started from the newest version, and sends only after the host's Confirm", async () => {
    const { writes, sent, runtime } = mount(READY);
    const dialog = await open("Add a grid tariff version");
    expect(field(dialog, "Effective from").value).toBe("");
    const rows = within(dialog).getAllByRole("group", { name: /^Bands, row/ });
    expect(rows).toHaveLength(3);
    const cells = (row: HTMLElement) => ["From hour", "To hour", "Rate per kWh"].map((l) => field(row, l).value);
    expect(rows.map(cells)).toEqual([
      ["0", "6", "520"],
      ["6", "18", "780"],
      ["18", "24", "910"],
    ]);
    // A one-step confirm: the form's own submit button gives way to the host's Confirm.
    expect(within(dialog).queryByRole("button", { name: "Continue" })).toBeNull();
    expect(dialog.querySelector('button[type="submit"]')).toBeNull();
    const confirm = within(dialog).getByRole("button", { name: "Add a grid tariff version" });
    expect(confirm.getAttribute("type")).toBe("button");
    type(field(dialog, "Effective from"), "2026-12-01");
    type(field(rows[2], "Rate per kWh"), "950");
    // Submitting the form, as Enter would, sends nothing: only the host's Confirm does.
    await flush(async () => fireEvent.submit(dialog.querySelector("form")!));
    expect(writes()).toEqual([]);

    await flush(async () => fireEvent.click(confirm));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe(`/api/microgrids/${MG}/grid-tariffs`);
    expect(writes()[0][1]).toMatchObject({ method: "POST" });
    expect(sent()).toEqual({
      effective_from: "2026-12-01",
      bands: [
        { from_hour: 0, to_hour: 6, rate: 520 },
        { from_hour: 6, to_hour: 18, rate: 780 },
        { from_hour: 18, to_hour: 24, rate: 950 },
      ],
    });
    expect(AddGridTariffBody.safeParse(sent()).success).toBe(true);
    await waitFor(() => expect(runtime.refresh).toHaveBeenCalledOnce());
  });

  it("starts the setup note's form with one empty band, and allows 1 to 24 bands", async () => {
    const { writes } = mount(SETUP);
    expect(screen.getByRole("button", { name: "Edit savings settings" })).toBeTruthy();
    const dialog = await open("Add a grid tariff version");
    const rows = () => within(dialog).getAllByRole("group", { name: /^Bands, row/ });
    expect(rows()).toHaveLength(1);
    expect((within(dialog).getByRole("button", { name: "Remove Bands, row 1" }) as HTMLButtonElement).disabled).toBe(true);
    const add = within(dialog).getByRole("button", { name: "Add a row to Bands" }) as HTMLButtonElement;
    for (let i = 1; i < 24; i++) fireEvent.click(add);
    expect(rows()).toHaveLength(24);
    expect(add.disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("refuses a body the route would refuse before sending: the form needs every band's fields", async () => {
    const { writes } = mount(SETUP);
    const dialog = await open("Add a grid tariff version");
    type(field(dialog, "Effective from"), "2026-12-01");
    await flush(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Add a grid tariff version" })));
    await waitFor(() => expect(within(dialog).getAllByText("Enter a value.").length).toBeGreaterThan(0));
    expect(writes()).toEqual([]);
  });
});

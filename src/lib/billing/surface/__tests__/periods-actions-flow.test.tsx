// @vitest-environment jsdom
/**
 * Creating a period from the periods view, pressed in the kit's view (which
 * Gridtop draws billing.periods with: GridtopGui.View, and no bespoke
 * renderer or form for it) and run by the action host: the kit's form opens
 * on the view's starting dates, and the write goes to the create route with
 * a body CreatePeriodBody parses. The prepare answer is built as
 * prepareAction builds it, which periods-actions.test.ts checks against the
 * real one.
 */
import "@/test/gui-setup";
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Json, ModelOf } from "@/lib/gui/contract";
import { KitProvider } from "@/lib/gui/host/client/kit-provider";
import { hostAct, KitRuntimeProvider } from "@/lib/gui/host/client/kit-runtime";
import { initial, manifest, recordingRuntime } from "@/lib/gui/host/client/__tests__/kit-test-utils";
import { cleanPrefill } from "@/lib/gui/host/server/merge";
import { actionTone, fillPath } from "@/lib/gui/host/shared/merge-actions";
import type { ActionDef } from "@/lib/gui/surface";
import { kit } from "@/lib/gui/kit";
import { CreatePeriodBody } from "../../schemas";
import { BILLING_SURFACE } from "../../surface";
import { PERIODS_EXAMPLES } from "../periods-examples";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null }));
// jsdom creates only untrusted events and has no user activation: both stand
// in here, as in action-host.test.tsx. The host's check of the click target stays real.
vi.mock("@/lib/gui/host/client/trusted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gui/host/client/trusted")>()),
  isTrusted: () => true,
  hasUserActivation: () => true,
}));

const [LIST, EMPTY, , UTC] = PERIODS_EXAMPLES;
const defs = BILLING_SURFACE.actions as ActionDef[];

/** What /api/gui/prepare answers for a request, as prepareAction builds it. */
function prepared(request: { action: string; params: Record<string, string>; body?: Json }) {
  const def = defs.find((d) => d.id === request.action)!;
  const bound = Object.keys(def.bind.body ?? {});
  const input = JSON.parse(JSON.stringify(z.toJSONSchema(def.input, { io: "input" })));
  for (const name of bound) delete input.properties[name];
  input.required = (input.required as string[]).filter((k) => !bound.includes(k));
  const prefill = request.body === undefined ? undefined : cleanPrefill(def, request.body);
  return {
    type: "prepared",
    spec: { type: "spec", id: def.id, title: def.title, confirm: def.confirm, inputVersion: def.inputVersion, input },
    confirm: def.confirm,
    method: def.method,
    path: fillPath(def.path, request.params),
    bound: Object.fromEntries(bound.map((name) => [name, request.params[name]])),
    ceremony: null,
    tone: actionTone(def),
    ...(prefill === undefined ? {} : { prefill }),
  };
}

function mount(model: ModelOf<"collection">) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body));
    const answer = url === "/api/gui/prepare" ? prepared(body as Parameters<typeof prepared>[0]) : { id: "new-period" };
    return Response.json(answer, { status: url === "/api/gui/prepare" ? 200 : 201 });
  });
  const runtime = recordingRuntime({ fetch, act: hostAct });
  render(
    <KitRuntimeProvider runtime={runtime}>
      <KitProvider manifest={manifest()} initial={initial}>
        <kit.KitView model={model} />
      </KitProvider>
    </KitRuntimeProvider>,
  );
  const writes = () => fetch.mock.calls.filter(([url]) => url !== "/api/gui/prepare");
  const prepares = () => fetch.mock.calls.filter(([url]) => url === "/api/gui/prepare").map(([, init]) => JSON.parse(String(init!.body)));
  return { writes, prepares };
}

/** Presses the first of the view's buttons with this name and waits for the kit's form. */
async function open(label: string) {
  await flush(async () => fireEvent.click(screen.getAllByRole("button", { name: label })[0]));
  return screen.findByRole("dialog", {}, { timeout: 5000 });
}
const field = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;

beforeAll(async () => {
  await Promise.all([import("@/lib/gui/host/client/confirm-step"), import("@/lib/gui/kit/overlay"), import("@/lib/gui/kit/action-form")]);
});
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("creating a period from the periods view", () => {
  it.each([
    ["the list", LIST],
    ["the empty state", EMPTY],
  ])("opens the kit's form from %s on the previous month and creates it at once", async (_name, model) => {
    const microgrid = model.entity!.id;
    const { writes, prepares } = mount(model);
    const dialog = await open("New billing period");
    expect(prepares()).toEqual([
      { action: "billing.create-period", params: { microgrid_id: microgrid }, body: { start_date: "2026-11-01", end_date: "2026-11-30" } },
    ]);
    expect(field(dialog, "Start date").value).toBe("2026-11-01");
    expect(field(dialog, "End date").value).toBe("2026-11-30");
    // Level none, pressed by the person: no confirmation step.
    await flush(async () => fireEvent.click(within(dialog).getByRole("button", { name: "New billing period" })));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe("/api/billing-periods");
    expect(writes()[0][1]).toMatchObject({ method: "POST" });
    const sent = JSON.parse(String(writes()[0][1]!.body));
    expect(CreatePeriodBody.parse(sent)).toEqual({ microgrid_id: microgrid, start_date: "2026-11-01", end_date: "2026-11-30" });
  });

  it("shows the time zone notice above the list, with its link to set the zone", () => {
    mount(UTC);
    expect(screen.getByText(UTC.notice!.text)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Set timezone" });
    expect(link.getAttribute("href")).toBe(`/microgrids/${UTC.entity!.id}/setup/rates`);
  });
});

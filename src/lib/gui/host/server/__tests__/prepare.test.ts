import { inspect } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { ActionDef } from "../../../surface";
import type { HostContext } from "../access";
import type { RegisteredAction, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { UNCHECKED_REASON } from "../merge";
import { MAX_PREPARE_BYTES, prepareAction, readPrepareBody } from "../prepare";
import { ORG_A, ORG_B, contextFor, managerOf, tableClient } from "./host-fakes";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const HOUSE = "e7100000-0000-4000-8005-0000000000b1";
const CANARY = "CANARY-7f3a91";
const PATH = "/api/microgrids/[id]/openems-backend";

const Input = z.strictObject({
  microgrid_id: z.uuid(),
  url: z.string().max(200),
  password: z.string().meta({ writeOnly: true }).optional(),
  confirmation: z.unknown().optional(),
});

function action(over: Partial<Record<keyof ActionDef, unknown>> = {}, plugin: MgmPluginName = "metering"): RegisteredAction {
  const def = {
    id: "metering.backend",
    title: "Change the data source",
    target: "microgrid",
    input: Input,
    inputVersion: 2,
    path: PATH,
    method: "PUT",
    bind: { path: { id: "microgrid" }, body: { microgrid_id: "microgrid" } },
    risk: "write",
    confirm: "confirm",
    humanOnly: false,
    ...over,
  } as unknown as ActionDef;
  return { plugin, def };
}
const ceremony = (o: Record<string, unknown> = {}) => ({
  type: "ceremony",
  statement: "Delete the data source of Kiwumu",
  facts: [{ label: "Microgrid", value: { t: "text", text: "Kiwumu" } }],
  warnings: [],
  acknowledgements: [{ id: "readings", label: "Readings stop" }],
  ...o,
});
const guarded = (confirm: "typed" | "ceremony", prepare: unknown) =>
  action({ id: "metering.backend-delete", method: "DELETE", risk: "destructive", confirm, humanOnly: true, prepare });

let tables: Parameters<typeof tableClient>[0];
let callLists: ReturnType<typeof tableClient>["calls"][];
const calls = () => callLists.flat();
let roles: UserRoleRecord[];
let gates: Map<string, GateDecision>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

const use = (...actions: RegisteredAction[]) => {
  snapshot = {
    views: [],
    actions: new Map(actions.map((a) => [a.def.id, a])),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
};
function ctx(): HostContext {
  return contextFor(roles, async () => {
    const made = tableClient(tables);
    callLists.push(made.calls);
    return made.client as SupabaseClient;
  });
}
const prepare = (body: unknown) => prepareAction(ctx(), body);
const params = { id: MG, microgrid_id: MG };
const logged = () => inspect([vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls], { depth: 10 });

beforeEach(() => {
  callLists = [];
  roles = [managerOf(ORG_A)];
  gates = new Map();
  tables = { microgrids: { data: [{ id: MG, name: "Kiwumu", community_id: null }] } };
  use(action());
  checkGate.mockReset().mockImplementation(async (_s: unknown, r: { plugin: string }) => gates.get(r.plugin) ?? { ok: true, organizationId: ORG_A });
  resolveTargetOrganization.mockReset().mockResolvedValue(ORG_A);
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  // Preparing never calls the action's route, or anything else over the network.
  expect(fetchSpy).not.toHaveBeenCalled();
  // And it only reads: the fake client has no write methods, and every query is a select.
  for (const call of calls()) expect(call.ops[0]?.[0]).toBe("select");
  vi.restoreAllMocks();
});

describe("prepareAction", () => {
  it("prepares the form, route and method, writing nothing", async () => {
    const out = await prepare({ action: "metering.backend", params: { id: MG.toUpperCase(), microgrid_id: MG } });
    expect(out).toEqual({
      ok: true,
      value: {
        type: "prepared",
        spec: {
          type: "spec",
          id: "metering.backend",
          title: "Change the data source",
          confirm: "confirm",
          inputVersion: 2,
          input: expect.objectContaining({ type: "object", required: ["url"], additionalProperties: false }),
        },
        confirm: "confirm",
        method: "PUT",
        path: `/api/microgrids/${MG}/openems-backend`,
        bound: { microgrid_id: MG },
        ceremony: null,
      },
    });
    const input = out.ok ? (out.value.spec.input as { properties: Record<string, unknown> }) : null;
    // Bound fields and the host's confirmation are not the person's to enter; writeOnly stays marked.
    expect(Object.keys(input!.properties)).toEqual(["url", "password"]);
    expect(input!.properties.password).toMatchObject({ writeOnly: true });
    // The gate is asked as a write, as the action's route will ask it.
    expect(checkGate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ plugin: "metering", access: "write", target: { kind: "organization", id: ORG_A } }));
  });

  it.each([
    ["not an object", "metering.backend"],
    ["an unknown key", { action: "metering.backend", params, extra: 1 }],
    ["a bad action id", { action: "Metering", params }],
    ["a missing bound field", { action: "metering.backend", params: { id: MG } }],
    ["an extra param", { action: "metering.backend", params: { ...params, other: MG } }],
    ["an id that is not a UUID", { action: "metering.backend", params: { id: "kiwumu", microgrid_id: MG } }],
    ["a provenance with no proposer", { action: "metering.backend", params, provenance: { at: "2026-11-09T08:00:00Z" } }],
    ["a provenance with an unknown key", { action: "metering.backend", params, provenance: { by: "watcher", at: "2026-11-09T08:00:00Z", x: 1 } }],
    ["a body the input refuses", { action: "metering.backend", params, body: { url: 7 } }],
    ["a body with an undeclared key", { action: "metering.backend", params, body: { url: "x", other: 1 } }],
  ])("answers 400 for %s", async (_name, body) => {
    expect(await prepare(body)).toMatchObject({ ok: false, status: 400, code: "gui_bad_request" });
  });

  it("answers 404 for an action no plugin contributes", async () => {
    expect(await prepare({ action: "metering.nope", params })).toMatchObject({ status: 404, code: "gui_not_found" });
  });

  it("answers 404 for an action whose filled route is not released", async () => {
    use(action({ path: "/api/microgrids/[id]/unreleased" }));
    expect(await prepare({ action: "metering.backend", params })).toMatchObject({ status: 404, code: "gui_not_found" });
    expect(calls()).toEqual([]);
  });

  it.each([
    ["a released page", { path: "/microgrids/[id]/setup" }, params],
    // Released: /api/microgrids/{id} takes ".." as an id.
    ["a path with a .. segment", { path: "/api/microgrids/..", bind: { body: { microgrid_id: "microgrid" } } }, { microgrid_id: MG }],
  ])("answers 404 for an action whose route is %s, not an API route", async (_name, over, given) => {
    use(action(over));
    expect(await prepare({ action: "metering.backend", params: given })).toMatchObject({ status: 404, code: "gui_not_found" });
    expect(calls()).toEqual([]);
  });

  it("answers 404 for an entity the person cannot see, or in another organization", async () => {
    tables.microgrids = { data: [] };
    expect(await prepare({ action: "metering.backend", params })).toMatchObject({ status: 404, code: "gui_not_found" });
    tables.microgrids = { data: [{ id: MG, name: "Kiwumu", community_id: null }] };
    resolveTargetOrganization.mockResolvedValue(ORG_B);
    expect(await prepare({ action: "metering.backend", params })).toMatchObject({ status: 404, code: "gui_not_found" });
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("answers 404 when two bound entities belong to different organizations", async () => {
    use(action({ bind: { path: { id: "microgrid" }, body: { household_id: "household" } }, input: z.object({ household_id: z.uuid() }) }));
    tables.households = { data: [{ id: HOUSE, display_name: "House", microgrid_id: MG }] };
    resolveTargetOrganization.mockImplementation(async (_s: unknown, t: { kind: string }) => (t.kind === "household" ? ORG_B : ORG_A));
    roles = [managerOf(ORG_A), managerOf(ORG_B)];
    expect(await prepare({ action: "metering.backend", params: { id: MG, household_id: HOUSE } })).toMatchObject({ status: 404 });
  });

  it("answers 404 for an action with no bound entity", async () => {
    use(action({ path: "/api/microgrids", bind: {}, input: z.object({ url: z.string() }) }));
    expect(await prepare({ action: "metering.backend", params: {} })).toMatchObject({ status: 404, code: "gui_not_found" });
  });

  it("answers 503 when the entity cannot be looked up", async () => {
    tables.microgrids = { data: null, error: { message: `db said ${CANARY}` } };
    expect(await prepare({ action: "metering.backend", params })).toMatchObject({ status: 503, code: "gui_unavailable" });
    expect(logged()).not.toContain(CANARY);
  });

  it("passes the gate's 409 and copy through, before availability or prepare", async () => {
    const available = vi.fn();
    const prep = vi.fn();
    use(action({ available, prepare: prep }));
    gates.set("metering", { ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled." });
    expect(await prepare({ action: "metering.backend", params })).toEqual({ ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled." });
    expect(available).not.toHaveBeenCalled();
    expect(prep).not.toHaveBeenCalled();
  });

  it("answers 503 when the gate cannot be read", async () => {
    checkGate.mockRejectedValue(new Error(CANARY));
    expect(await prepare({ action: "metering.backend", params })).toMatchObject({ status: 503, code: "metering_gate_unavailable" });
  });

  it("answers 409 with available()'s reason, asked about the target on its own client", async () => {
    const available = vi.fn(async (req: { supabase: unknown; organizationId: string }, ids: string[]) => {
      expect(req.organizationId).toBe(ORG_A);
      return Object.fromEntries(ids.map((id) => [id, "Register an edge first"]));
    });
    use(action({ available }));
    expect(await prepare({ action: "metering.backend", params })).toMatchObject({ status: 409, code: "gui_action_unavailable", message: "Register an edge first" });
    expect(available).toHaveBeenCalledWith(expect.anything(), [MG]);
  });

  it("answers 409 without the error when available() throws", async () => {
    use(action({ available: async () => { throw new Error(CANARY); } }));
    const out = await prepare({ action: "metering.backend", params });
    expect(out).toMatchObject({ status: 409, code: "gui_action_unavailable", message: UNCHECKED_REASON });
    expect(JSON.stringify(out) + logged()).not.toContain(CANARY);
  });

  it("prepares when available() says yes", async () => {
    use(action({ available: async (_r: unknown, ids: string[]) => Object.fromEntries(ids.map((id) => [id, true])) }));
    expect(await prepare({ action: "metering.backend", params })).toMatchObject({ ok: true });
  });

  describe("human-only actions and proposals", () => {
    const at = "2026-11-09T08:00:00Z";
    const proposals = [
      ["an assistant's proposal", { by: "assistant", proposal: "e7100000-0000-4000-8009-0000000000c1", at }],
      ["a watcher's proposal with no id", { by: "watcher", at }],
    ] as const;

    it.each(proposals)("refuses %s of a human-only action", async (_name, provenance) => {
      use(action({ humanOnly: true }));
      expect(await prepare({ action: "metering.backend", params, provenance })).toMatchObject({ status: 403, code: "gui_human_only" });
      expect(await prepare({ action: "metering.backend", params })).toMatchObject({ ok: true });
      const prep = vi.fn(async () => ({ ok: true, model: ceremony({ typed: "Kiwumu" }) }));
      use(guarded("typed", prep));
      expect(await prepare({ action: "metering.backend-delete", params, provenance })).toMatchObject({ status: 403, code: "gui_human_only" });
      expect(prep).not.toHaveBeenCalled();
    });

    it.each(proposals)("raises %s at level none to a confirmation step, keeping the spec's level", async (_name, provenance) => {
      use(action({ confirm: "none" }));
      const out = await prepare({ action: "metering.backend", params, provenance });
      expect(out).toMatchObject({ ok: true, value: { confirm: "confirm", spec: { confirm: "none" } } });
      expect(await prepare({ action: "metering.backend", params })).toMatchObject({ ok: true, value: { confirm: "none" } });
    });

    it.each(["confirm", "typed", "ceremony"] as const)("keeps a proposal of a %s action at its own level", async (confirm) => {
      const prepare_ = async () => ({ ok: true, model: ceremony({ typed: "Kiwumu" }) });
      use(action({ confirm, ...(confirm === "confirm" ? {} : { prepare: prepare_ }) }));
      const out = await prepare({ action: "metering.backend", params, provenance: proposals[0][1] });
      expect(out).toMatchObject({ ok: true, value: { confirm, spec: { confirm } } });
    });
  });

  describe("prefill", () => {
    it("returns the body cleaned: writeOnly, bound and confirmation fields dropped", async () => {
      const prep = vi.fn(async () => ({ ok: true, model: ceremony() }));
      use(action({ prepare: prep }));
      const body = { url: "http://edge", password: CANARY, microgrid_id: MG, confirmation: { typed: "x" } };
      const out = await prepare({ action: "metering.backend", params, body });
      expect(out).toMatchObject({ ok: true, value: { prefill: { url: "http://edge" } } });
      // The action's own prepare sees the same cleaned values, never the secret.
      expect(prep).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A, params }), { params, body: { url: "http://edge" } });
      expect(JSON.stringify(out)).not.toContain(CANARY);
    });

    it("binds the resolved, lowercased id, whatever case was sent", async () => {
      const out = await prepare({ action: "metering.backend", params: { id: MG, microgrid_id: MG.toUpperCase() } });
      expect(out).toMatchObject({ ok: true, value: { bound: { microgrid_id: MG } } });
    });

    it("has no prefill when no body is sent", async () => {
      const out = await prepare({ action: "metering.backend", params });
      expect(out.ok && "prefill" in out.value).toBe(false);
    });
  });

  it("describes the input as a person enters it: a defaulted field is not required", async () => {
    use(action({ input: z.strictObject({ microgrid_id: z.uuid(), url: z.string().default("http://edge"), name: z.string() }) }));
    const out = await prepare({ action: "metering.backend", params });
    expect(out).toMatchObject({ ok: true, value: { spec: { input: { required: ["name"] } } } });
  });

  describe("the confirmation step", () => {
    it("returns a ceremony from the action's prepare, strictly parsed", async () => {
      use(guarded("ceremony", async () => ({ ok: true, model: ceremony({ digest: "d1" }) })));
      const out = await prepare({ action: "metering.backend-delete", params });
      expect(out).toMatchObject({ ok: true, value: { confirm: "ceremony", method: "DELETE", ceremony: ceremony({ digest: "d1" }) } });
    });

    it("refuses a ceremony with a key the contract does not name", async () => {
      use(guarded("ceremony", async () => ({ ok: true, model: { ...ceremony(), note: CANARY } })));
      const out = await prepare({ action: "metering.backend-delete", params });
      expect(out).toMatchObject({ ok: false, status: 500, code: "gui_output_invalid" });
      expect(JSON.stringify(out) + logged()).not.toContain(CANARY);
    });

    it("refuses a typed action whose ceremony names nothing to type", async () => {
      use(guarded("typed", async () => ({ ok: true, model: ceremony() })));
      expect(await prepare({ action: "metering.backend-delete", params })).toMatchObject({ status: 500, code: "gui_output_invalid" });
      use(guarded("typed", async () => ({ ok: true, model: ceremony({ typed: "Kiwumu" }) })));
      expect(await prepare({ action: "metering.backend-delete", params })).toMatchObject({ ok: true, value: { ceremony: { typed: "Kiwumu" } } });
    });

    it("refuses a typed or ceremony action with no prepare", async () => {
      use(guarded("ceremony", undefined));
      expect(await prepare({ action: "metering.backend-delete", params })).toMatchObject({ status: 500, code: "gui_output_invalid" });
    });

    it("answers 500 without the error when prepare throws", async () => {
      use(guarded("ceremony", async () => { throw new Error(CANARY); }));
      const out = await prepare({ action: "metering.backend-delete", params });
      expect(out).toMatchObject({ status: 500, code: "gui_prepare_failed" });
      expect(JSON.stringify(out) + logged()).not.toContain(CANARY);
    });

    it("passes prepare's own refusal through, cut to 300 characters", async () => {
      use(guarded("ceremony", async () => ({ ok: false, status: 409, message: "x".repeat(400) })));
      const out = await prepare({ action: "metering.backend-delete", params });
      expect(out).toMatchObject({ status: 409, code: "gui_action_refused" });
      expect(!out.ok && out.message.length).toBe(300);
      use(guarded("ceremony", async () => ({ ok: false, status: 404, message: "Gone" })));
      expect(await prepare({ action: "metering.backend-delete", params })).toEqual({ ok: false, status: 404, code: "gui_not_found", message: "Gone" });
      use(guarded("ceremony", async () => ({ ok: false, status: 418, message: "teapot" })));
      expect(await prepare({ action: "metering.backend-delete", params })).toMatchObject({ status: 500, code: "gui_output_invalid" });
    });

    it.each([
      ["nothing", null],
      ["a string", "fine"],
      ["a refusal whose message is not text", { ok: false, status: 409, message: 7 }],
      ["an ok that is not true", { ok: "yes", model: ceremony() }],
    ])("answers 500 when prepare returns %s", async (_name, result) => {
      use(guarded("ceremony", async () => result));
      expect(await prepare({ action: "metering.backend-delete", params })).toEqual(expect.objectContaining({ ok: false, status: 500, code: "gui_output_invalid" }));
    });
  });

  it.each([
    ["a valid request", { action: "metering.backend", params }],
    ["a body it would refuse", { nope: 1 }],
    ["an unknown action", { action: "metering.nope", params }],
  ])("refuses a context hostContext did not issue, before reading %s", async (_name, body) => {
    await expect(prepareAction({ ...ctx() }, body)).rejects.toThrow("did not issue");
  });
});

describe("readPrepareBody", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/gui/prepare", { method: "POST", body, headers });

  it("reads JSON up to the limit", async () => {
    const value = { action: "metering.backend", pad: "" };
    value.pad = "x".repeat(MAX_PREPARE_BYTES - JSON.stringify(value).length);
    expect(await readPrepareBody(post(JSON.stringify(value)))).toEqual({ ok: true, value });
  });

  it("answers 413 past the limit, whatever the declared length", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_PREPARE_BYTES) });
    expect(await readPrepareBody(post(big))).toMatchObject({ ok: false, status: 413, code: "gui_body_too_large" });
    expect(await readPrepareBody(post("{}", { "content-length": String(MAX_PREPARE_BYTES + 1) }))).toMatchObject({ status: 413 });
  });

  it("answers 400 for a body that is not JSON, or none", async () => {
    expect(await readPrepareBody(post("{"))).toMatchObject({ status: 400, code: "gui_bad_request" });
    expect(await readPrepareBody(new Request("http://localhost/api/gui/prepare", { method: "POST" }))).toMatchObject({ status: 400 });
  });
});

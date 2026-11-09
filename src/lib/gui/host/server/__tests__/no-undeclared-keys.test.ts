/**
 * No undeclared key leaves the server, and a refusal never repeats what was
 * refused. A view declares one key; its "loader" places a canary string in
 * one undeclared place at a time. Each case must fail the strict parse, and
 * neither the outcome nor anything logged may contain the canary.
 *
 * The host routes that serve views extend this to their responses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ViewDef } from "../../../surface";
import { strictParseModel } from "../parse";

const CANARY = "CANARY-7f3a91";

const canaryView: ViewDef = {
  id: "acme.canary",
  kind: "collection",
  path: "/organizations/[id]",
  params: { id: "organization" },
  cost: "db",
  declares: { keys: ["name"] },
  ext: { schema: "acme.canary@1", zod: z.strictObject({ count: z.number() }) },
  examples: [],
  load: async () => ({ ok: false, status: 503, message: "test" }),
};

type Model = {
  title: string;
  actions: unknown[];
  entity?: Record<string, unknown>;
  links?: unknown[];
  ext?: { schema: string; data: Record<string, unknown> };
  body: {
    columns: Record<string, unknown>[];
    rows: { id: string; cells: Record<string, Record<string, unknown>>; actions: unknown[]; [k: string]: unknown }[];
    empty: { title: string };
  };
  [k: string]: unknown;
};

function good(): Model {
  return {
    title: "Canary",
    actions: [{ action: "acme.rename", params: { id: "o1" } }],
    entity: { kind: "organization", id: "o1", label: "Demo" },
    ext: { schema: "acme.canary@1", data: { count: 1 } },
    body: {
      columns: [{ key: "name", label: "Name", type: "text", priority: 1 }],
      rows: [{ id: "r1", cells: { name: { t: "text", text: "Demo" } }, actions: [] }],
      empty: { title: "None" },
    },
  };
}

const CASES: Record<string, (m: Model) => void> = {
  "an extra top-level model field": (m) => (m.secret = CANARY),
  "an undeclared cell key": (m) => (m.body.rows[0].cells[CANARY] = { t: "text", text: "x" }),
  "an undeclared cell holding the canary": (m) => (m.body.rows[0].cells.phone = { t: "text", text: CANARY }),
  "an extra key inside a Value": (m) => (m.body.rows[0].cells.name.phone = CANARY),
  "an extra key named by the canary inside a Value": (m) => (m.body.rows[0].cells.name[CANARY] = 1),
  "an extra row field": (m) => (m.body.rows[0].phone = CANARY),
  "an undeclared column": (m) => m.body.columns.push({ key: CANARY, label: CANARY, type: "text", priority: 1 }),
  "an extra ActionLink field": (m) => (m.actions = [{ action: "acme.rename", params: { id: "o1" }, secret: CANARY }]),
  "a host-filled field on a row's ActionLink": (m) =>
    (m.body.rows[0].actions = [{ action: "acme.rename", params: { id: "o1" }, label: CANARY, enabled: true }]),
  "an extra LinkRef field": (m) => (m.links = [{ id: "acme.l", label: "L", href: "/organizations", secret: CANARY }]),
  "an extra ext envelope field": (m) => ((m.ext as Record<string, unknown>).secret = CANARY),
  "an extra ext field": (m) => (m.ext!.data.secret = CANARY),
  "an ext field of the wrong type": (m) => (m.ext!.data.count = CANARY),
  "an EntityRef extra": (m) => (m.entity!.email = CANARY),
  "a LinkRef with an external href": (m) =>
    (m.links = [{ id: "acme.out", label: "Out", href: `https://${CANARY}.example/x` }]),
  "an href to an unreleased page": (m) => (m.body.rows[0].href = `/organizations/${CANARY}/x`),
  "an action's params under a nested key": (m) => (m.actions = [{ action: "acme.rename", params: { id: { CANARY } } }]),
  "a string over the size cap": (m) => (m.title = `${CANARY}${"x".repeat(5_000)}`),
};

describe("no undeclared key leaves the server", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it("passes a model that carries only declared keys, unchanged", () => {
    const out = strictParseModel(canaryView, good());
    expect(out).toEqual({ ok: true, value: good() });
    if (out.ok) expect(Object.keys(out.value.body.rows[0].cells)).toEqual(["name"]);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(Object.entries(CASES))("refuses %s without repeating it", (_, plant) => {
    const model = good();
    plant(model);
    expect(JSON.stringify(model)).toContain(CANARY);
    const out = strictParseModel(canaryView, model);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).toContain("acme.canary");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(CANARY);
  });
});

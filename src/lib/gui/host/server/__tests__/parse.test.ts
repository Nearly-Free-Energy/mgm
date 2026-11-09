/**
 * The per-view strict parse in ../parse.ts, against the billing fixture and
 * small views written here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Value } from "../../../contract";
import type { ViewDef } from "../../../surface";
import { BILLING_SURFACE } from "../../../__tests__/fixtures/billing-surface";
import { hrefSchema, linkRefSchema, loadedModelSchemas } from "../model-schema";
import { DATA_KEYS, HREF_KEYS, MODEL_CAPS, RECORD_KEYS, loadedModelSchemaFor, parseOrFail, strictParseModel } from "../parse";

const MG = "00000000-0000-4000-8000-0000000000b1";
const views = Object.fromEntries((BILLING_SURFACE.views ?? []).map((v) => [v.id, v]));
const periods = views["billing.periods"];
const review = views["billing.period-review"];
const checklist = views["billing.close-checklist"];

/** A GUI's example turned back into what a loader returns: no host-filled fields, ActionLinks. */
function loaded(example: unknown): Record<string, unknown> {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.action === "string" && typeof o.enabled === "boolean")
      return { action: o.action, params: o.params, label: o.label };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, strip(x)]));
  };
  const { type, view, kind, org, trail, attached, notice, live, ...rest } = example as Record<string, unknown>;
  void [type, view, kind, org, trail, attached, notice, live];
  return strip(rest) as Record<string, unknown>;
}
const model = (def: ViewDef) => structuredClone(loaded(def.examples[0]));

function def(kind: ViewDef["kind"], extra: Partial<ViewDef> = {}): ViewDef {
  return {
    id: "acme.test",
    kind,
    path: "/microgrids/[id]",
    params: { id: "microgrid" },
    cost: "db",
    declares: { keys: ["a", "b"], prefixes: ["p."] },
    examples: [],
    load: async () => ({ ok: false, status: 503, message: "test" }),
    ...extra,
  } as ViewDef;
}
const text = (s: string): Value => ({ t: "text", text: s });
const collection = (keys: string[]) => ({
  title: "T",
  actions: [],
  body: {
    columns: keys.map((key) => ({ key, label: key, type: "text", priority: 1 })),
    rows: [{ id: "r1", cells: Object.fromEntries(keys.map((k) => [k, text(k)])), actions: [] }],
    empty: { title: "None" },
  },
});
const record = (values: Value[]) => ({
  title: "T",
  actions: [],
  body: { sections: [{ fields: values.map((value, i) => ({ key: i % 2 ? "a" : "b", label: "L", value })) }] },
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

function refused(d: ViewDef, m: unknown): string[] {
  const out = strictParseModel(d, m);
  expect(out.ok).toBe(false);
  return out.ok ? [] : out.paths;
}

describe("strictParseModel", () => {
  it("accepts the billing examples as their loaders would return them", () => {
    for (const d of [periods, review, checklist]) expect(strictParseModel(d, model(d)), d.id).toMatchObject({ ok: true });
    expect(errors).not.toHaveBeenCalled();
  });

  it("accepts every Value variant and refuses unknown types, extra keys and fractional money", () => {
    const all: Value[] = [
      text("x"),
      { t: "empty", text: "—" },
      { t: "number", v: 1.5, unit: "kWh", text: "1.5" },
      { t: "percent", v: 40, text: "40%" },
      { t: "money", v: 4216800, currency: "UGX", text: "4,216,800" },
      { t: "energy", v: 2, unit: "kWh", text: "2", derived: true },
      { t: "power", v: 3, unit: "W", text: "3", at: "2026-11-09T10:00:00Z" },
      { t: "date", v: "2026-11-09", text: "9 Nov" },
      { t: "datetime", v: "2026-11-09T10:00:00+03:00", tz: "Africa/Kampala", text: "10:00", synthetic: true },
      { t: "status", v: "draft", tone: "warning", text: "Draft" },
      { t: "ref", ref: { kind: "microgrid", id: MG, label: "M", href: `/microgrids/${MG}` }, text: "M" },
    ];
    expect(strictParseModel(def("record"), record(all)).ok).toBe(true);
    for (const bad of [
      { t: "colour", text: "x" },
      { t: "text", text: "x", extra: 1 },
      { t: "money", v: 1.5, currency: "UGX", text: "1.5" },
      { t: "money", v: 1, currency: "ugx", text: "1" },
    ])
      refused(def("record"), record([bad as Value]));
  });

  it("refuses undeclared keys in every kind and accepts declared prefixes", () => {
    const d = def("collection");
    expect(strictParseModel(d, collection(["a", "p.1"])).ok).toBe(true);
    expect(refused(d, collection(["a", "z"]))).toEqual(
      expect.arrayContaining(["body.columns.1.key undeclared", "body.rows.0.cells.* undeclared"]),
    );
    // A prefix matches the start of a key only.
    expect(refused(d, collection(["a", "xp.1"]))).toEqual(expect.arrayContaining(["body.columns.1.key undeclared"]));
    const totals = collection(["a"]);
    Object.assign(totals.body, { totals: { zz: text("1") } });
    expect(refused(d, totals)).toEqual(["body.totals.* undeclared"]);

    expect(refused(def("record"), { ...record([text("x")]), body: { sections: [{ fields: [{ key: "zz", label: "L", value: text("x") }] }] } }))
      .toEqual(["body.sections.0.fields.0.key undeclared"]);

    const metrics = (tile: string, series: string) => ({
      title: "T",
      actions: [],
      body: {
        tiles: [{ key: tile, label: "L", value: text("1") }],
        series: [{ key: series, label: "L", unit: "W", points: [["2026-11-09T10:00:00Z", 1], ["2026-11-09T10:05:00Z", null]] }],
      },
    });
    expect(strictParseModel(def("metrics"), metrics("a", "p.load")).ok).toBe(true);
    expect(refused(def("metrics"), metrics("zz", "yy"))).toEqual([
      "body.tiles.0 undeclared",
      "body.series.0 undeclared",
    ]);
    expect(refused(def("metrics"), metrics("a", "xp.load"))).toEqual(["body.series.0 undeclared"]);
  });

  it("refuses every field the host fills", () => {
    const host = { type: "view", view: "billing.periods", kind: "collection", org: null, trail: [], attached: [], notice: { tone: "info", text: "x" }, live: { refreshSeconds: 60, staleAfterSeconds: 120 } };
    for (const [key, value] of Object.entries(host))
      expect(refused(periods, { ...model(periods), [key]: value }), key).toEqual(["(model) unrecognized_keys"]);
  });

  it("checks ext against the view's own schema", () => {
    const ext = (data: unknown, schema = "billing.period-review@1") => ({ ...model(review), ext: { schema, data } });
    expect(strictParseModel(review, ext({ tariffVersion: 2, preflight: { readings: 1, missing: 0 } })).ok).toBe(true);
    expect(refused(periods, { ...model(periods), ext: { schema: "billing.periods@1", data: {} } })).toEqual(["ext invalid_type"]);
    expect(refused(review, ext({ tariffVersion: 1, preflight: { readings: 1, missing: 0 } }, "billing.period-review@2"))).toEqual(["ext.schema invalid_value"]);
    expect(refused(review, ext({ tariffVersion: 1, preflight: { readings: 1, missing: 0, more: 1 } }))).toEqual(["ext.data.preflight unrecognized_keys"]);
    expect(refused(review, ext({ tariffVersion: "1", preflight: { readings: 1, missing: 0 } }))).toEqual(["ext.data.tariffVersion invalid_type"]);
  });

  it("requires released pages for page hrefs and allows downloads and OutHrefs only in links", () => {
    const m = model(periods) as { body: { rows: { href?: string; links?: unknown[] }[]; filters: { href: string }[]; next?: string }; entity: { href?: string } };
    m.body.rows[0].href = `/microgrids/${MG}/nowhere`;
    m.body.filters[0].href = "/api/billing-periods";
    m.body.next = "/api/mgm/health";
    m.entity.href = `/microgrids/${MG}/nowhere`;
    m.body.rows[0].links = [
      { id: "billing.pdf", label: "PDF", href: `/api/billing-line-items/${MG}/pdf`, download: { mime: "application/pdf", filename: "bill.pdf" } },
      { id: "billing.call", label: "Call", href: "tel:+256700000000" },
      { id: "billing.bad", label: "Bad", href: "/api/gui/view" },
      { id: "billing.gone", label: "Gone", href: `/microgrids/${MG}/nowhere` },
    ];
    // A model's own links follow the link rule too.
    Object.assign(m, {
      links: [
        { id: "billing.pdf", label: "PDF", href: `/api/billing-line-items/${MG}/pdf` },
        { id: "billing.call", label: "Call", href: "tel:+256700000000" },
      ],
    });
    expect(refused(periods, m).sort()).toEqual([
      "body.filters.0.href href",
      "body.next href",
      "body.rows.0.href href",
      "body.rows.0.links.2.href href",
      "body.rows.0.links.3.href href",
      "entity.href href",
    ]);

    const feed = {
      title: "F",
      actions: [],
      body: {
        entries: [
          {
            id: "e1",
            at: "2026-11-09T10:00:00Z",
            author: { kind: "system", name: "MGM" },
            text: [{ p: ["See ", { link: "/settings/nowhere", text: "here" }] }],
            embed: { type: "view", href: "/organizations" },
          },
        ],
      },
    };
    expect(refused(def("feed"), feed)).toEqual(["body.entries.0.text.0.p.1.link href"]);
    // Inside ext and prefill the strings are data, not hrefs.
    const extDef = def("record", { ext: { schema: "acme.test@1", zod: z.strictObject({ href: z.string() }) } });
    expect(strictParseModel(extDef, { ...record([text("x")]), ext: { schema: "acme.test@1", data: { href: "anything" } } }).ok).toBe(true);
    const action = { action: "acme.go", params: { next: "anything", href: "x" }, prefill: { href: "anything", link: "x" } };
    expect(strictParseModel(def("record"), { ...record([text("x")]), actions: [action] }).ok).toBe(true);
  });

  it("never lets a declared cell or total key change the href rule", () => {
    const keys = ["params", "prefill", "ext", "links"];
    const d = def("collection", { declares: { keys } });
    const ref = (href: `/${string}`): Value => ({ t: "ref", text: "x", ref: { kind: "organization", id: "o", label: "L", href } });
    for (const key of keys) {
      const m = collection([key]);
      m.body.rows[0].cells[key] = ref(`/microgrids/${MG}/nowhere`);
      Object.assign(m.body, { totals: { [key]: ref(`/api/billing-line-items/${MG}/pdf`) } });
      expect(refused(d, m), key).toEqual([`body.rows.0.cells.${key}.ref.href href`, `body.totals.${key}.ref.href href`]);
    }
  });

  it("caps sizes", () => {
    const d = def("collection");
    const many = collection(["a"]);
    many.body.rows = Array.from({ length: MODEL_CAPS.rows + 1 }, (_, i) => ({ ...many.body.rows[0], id: `r${i}` }));
    expect(refused(d, many)).toEqual(["body.rows too_large"]);
    const wide = collection(Array.from({ length: MODEL_CAPS.columns + 1 }, (_, i) => `p.${i}`));
    expect(refused(d, wide)).toEqual(["body.columns too_large"]);
    expect(strictParseModel(d, { ...collection(["a"]), title: "x".repeat(MODEL_CAPS.text) }).ok).toBe(true);
    expect(refused(d, { ...collection(["a"]), title: "x".repeat(MODEL_CAPS.text + 1) })).toEqual(["title too_large"]);
    // The string cap holds inside data too.
    const long = "x".repeat(MODEL_CAPS.text + 1);
    const extDef = def("record", { ext: { schema: "acme.test@1", zod: z.strictObject({ href: z.string() }) } });
    expect(refused(extDef, { ...record([text("x")]), ext: { schema: "acme.test@1", data: { href: long } } })).toEqual(["ext.data.href too_large"]);
    expect(refused(def("record"), { ...record([text("x")]), actions: [{ action: "acme.go", params: {}, prefill: { note: long } }] }))
      .toEqual(["actions.0.prefill.* too_large"]);
    const series = (key: string, n: number) => ({
      key,
      label: key,
      unit: "W",
      points: Array.from({ length: n }, (_, i) => [new Date(i * 60_000).toISOString(), i]),
    });
    expect(refused(def("metrics"), { title: "M", actions: [], body: { tiles: [], series: [series("a", 2), series("b", MODEL_CAPS.points + 1)] } }))
      .toEqual(["body.series.1.points too_large"]);
    const entry = { id: "e", at: "2026-11-09T10:00:00Z", author: { kind: "system", name: "MGM" }, text: [] };
    expect(refused(def("feed"), { title: "F", actions: [], body: { entries: Array(MODEL_CAPS.entries + 1).fill(entry) } }))
      .toEqual(["body.entries too_large"]);
  });

  it("builds each view's schema once", () => {
    expect(loadedModelSchemaFor(periods)).toBe(loadedModelSchemaFor(periods));
    expect(loadedModelSchemaFor(periods)).not.toBe(loadedModelSchemaFor(review));
  });
});

describe("the walk's key sets", () => {
  type Def = {
    type: string;
    shape?: Record<string, z.ZodType>;
    element?: z.ZodType;
    items?: z.ZodType[];
    rest?: z.ZodType | null;
    options?: z.ZodType[];
    innerType?: z.ZodType;
    valueType?: z.ZodType;
  };
  const defOf = (s: z.ZodType) => s._zod.def as unknown as Def;
  const unwrap = (s: z.ZodType): z.ZodType =>
    ["optional", "nullable"].includes(defOf(s).type) ? unwrap(defOf(s).innerType!) : s;
  const LINK_HREF = linkRefSchema.shape.href;
  const LEAVES = new Set(["string", "number", "boolean", "literal", "enum", "template_literal", "null"]);

  /** Every href, LinkRef and record position in a schema, checked against the sets parse.ts walks by. */
  function audit(schema: z.ZodType) {
    const problems: string[] = [];
    const found = { hrefs: 0, linkRefs: 0, records: 0 };
    // `prop` is the nearest property holding this schema; `direct` is false once an array or record intervenes.
    const visit = (s: z.ZodType, prop: string, direct: boolean, at: string): void => {
      if (s === hrefSchema) {
        found.hrefs++;
        if (!direct || !HREF_KEYS.has(prop)) problems.push(`${at}: an href the walk would not check`);
        return;
      }
      if (s === linkRefSchema) {
        found.linkRefs++;
        if (prop !== "links") problems.push(`${at}: a LinkRef outside "links"`);
      }
      const d = defOf(s);
      switch (d.type) {
        case "object":
          for (const [key, child] of Object.entries(d.shape!)) {
            if (DATA_KEYS.has(key)) continue;
            const inner = unwrap(child);
            if (HREF_KEYS.has(key) && inner !== hrefSchema && inner !== LINK_HREF) problems.push(`${at}.${key}: not an href`);
            if (key === "links" && !(defOf(inner).type === "array" && defOf(inner).element === linkRefSchema))
              problems.push(`${at}.${key}: not LinkRefs`);
            visit(child, key, true, `${at}.${key}`);
          }
          return;
        case "optional":
        case "nullable":
          return visit(d.innerType!, prop, direct, at);
        case "union":
          return d.options!.forEach((o) => visit(o, prop, direct, at));
        case "array":
          return visit(d.element!, prop, false, `${at}[]`);
        case "tuple":
          return [...d.items!, ...(d.rest ? [d.rest] : [])].forEach((i) => visit(i, prop, false, `${at}[]`));
        case "record":
          found.records++;
          if (!RECORD_KEYS.has(prop)) problems.push(`${at}: a record whose keys the walk would read as names`);
          return visit(d.valueType!, prop, false, `${at}.*`);
        default:
          if (!LEAVES.has(d.type)) problems.push(`${at}: a ${d.type} the audit does not know`);
      }
    };
    visit(schema, "", true, "(model)");
    return { problems, found };
  }

  it("covers every href, LinkRef and record position in a loaded model", () => {
    const total = { hrefs: 0, linkRefs: 0, records: 0 };
    for (const [kind, schema] of Object.entries(loadedModelSchemas)) {
      const { problems, found } = audit(schema);
      expect(problems, kind).toEqual([]);
      for (const k of ["hrefs", "linkRefs", "records"] as const) total[k] += found[k];
    }
    expect(total.hrefs).toBeGreaterThan(5);
    expect(total.linkRefs).toBeGreaterThan(1);
    expect(total.records).toBeGreaterThan(1);
  });
});

describe("parseOrFail", () => {
  it("logs the label with paths and codes, and caps the list", () => {
    const schema = z.strictObject({ items: z.array(z.number()) });
    const out = parseOrFail(schema, { items: Array(25).fill("x") }, "acme.thing");
    expect(out).toEqual({ ok: false, paths: [...Array.from({ length: 20 }, (_, i) => `items.${i} invalid_type`), "and 5 more"] });
    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0][0])).toMatch(/^\[gui\] acme\.thing: output refused at items\.0 invalid_type; /);
  });

  it("fails closed when a schema cannot be parsed synchronously", () => {
    const schema = z.string().refine(async () => true);
    expect(parseOrFail(schema, "x", "acme.async")).toEqual({ ok: false, paths: ["(model) unparseable"] });
  });
});

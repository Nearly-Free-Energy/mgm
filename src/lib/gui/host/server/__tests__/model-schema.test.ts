/**
 * The strict schemas in ../model-schema.ts against the contract types.
 *
 * `npx tsc --noEmit` checks the first block: each schema's output type must
 * be identical to its contract type, so editing either one alone fails tsc.
 * Vitest runs the rest.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  ActionRef,
  ActionResult,
  ActionSpec,
  BodiesOf,
  Ceremony,
  EmbeddedView,
  EntityHit,
  EntityRef,
  GuiMeta,
  Href,
  Id,
  InitialView,
  Inline,
  Json,
  LinkRef,
  Manifest,
  ModelOf,
  OutHref,
  Rich,
  Signal,
  Signals,
  StatusItem,
  Trail,
  Value,
  ViewKind,
  ViewModel,
} from "../../../contract";
import type { ActionLink, LoadedModel } from "../../../surface";
import { BILLING_SURFACE } from "../../../__tests__/fixtures/billing-surface";
import {
  actionLinkSchema,
  actionRefSchema,
  actionResultSchema,
  actionSpecSchema,
  bodySchemas,
  ceremonySchema,
  entityHitSchema,
  entityRefSchema,
  guiMetaSchema,
  hrefSchema,
  idSchema,
  initialViewSchema,
  inlineSchema,
  jsonSchema,
  linkRefSchema,
  loadedModelSchemas,
  manifestSchema,
  modelSchema,
  modelSchemas,
  outHrefSchema,
  richSchema,
  signalSchema,
  signalsSchema,
  statusItemSchema,
  trailSchema,
  valueSchema,
  viewModelSchema,
} from "../model-schema";

/**
 * Rebuilds a type property by property, so an intersection such as Value's
 * meta fields compares equal to the same fields written out, as zod writes
 * them. toEqualTypeOf on the raw types refuses that pair.
 */
type Flat<T> = T extends object ? { [K in keyof T]: Inner<T[K]> } : T;
/** Json and ViewModel refer to themselves, so where they recur they are compared as they are. */
type Inner<T> = Assignable<T, Json> extends true ? T : Assignable<T, ViewModel> extends true ? T : Flat<T>;
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Identical, not merely assignable both ways: a missing optional key fails. */
type Same<A, B> =
  (<T>() => T extends Flat<A> ? 1 : 2) extends <T>() => T extends Flat<B> ? 1 : 2 ? true : false;
type Out<S extends z.ZodType> = z.output<S>;
type BodyOf<K extends ViewKind> = BodiesOf<ActionRef, EmbeddedView>[K];

describe("model schemas match the contract types", () => {
  it("has an output type equal to each contract type", () => {
    expectTypeOf<Same<Out<typeof idSchema>, Id>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof hrefSchema>, Href>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof outHrefSchema>, OutHref>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof jsonSchema>, Json>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof valueSchema>, Value>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof inlineSchema>, Inline>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof richSchema>, Rich>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof linkRefSchema>, LinkRef>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof actionRefSchema>, ActionRef>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof actionSpecSchema>, ActionSpec>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof actionResultSchema>, ActionResult>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof entityRefSchema>, EntityRef>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof entityHitSchema>, EntityHit>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof trailSchema>, Trail>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof bodySchemas.collection>, BodyOf<"collection">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof bodySchemas.record>, BodyOf<"record">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof bodySchemas.metrics>, BodyOf<"metrics">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof bodySchemas.feed>, BodyOf<"feed">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof bodySchemas.flow>, BodyOf<"flow">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof modelSchemas.collection>, ModelOf<"collection">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof modelSchemas.record>, ModelOf<"record">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof modelSchemas.metrics>, ModelOf<"metrics">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof modelSchemas.feed>, ModelOf<"feed">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof modelSchemas.flow>, ModelOf<"flow">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<ReturnType<typeof modelSchema<"metrics">>>, ModelOf<"metrics">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof viewModelSchema>, ViewModel>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof actionLinkSchema>, ActionLink>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof loadedModelSchemas.collection>, LoadedModel<"collection">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof loadedModelSchemas.record>, LoadedModel<"record">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof loadedModelSchemas.metrics>, LoadedModel<"metrics">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof loadedModelSchemas.feed>, LoadedModel<"feed">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof loadedModelSchemas.flow>, LoadedModel<"flow">>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof ceremonySchema>, Ceremony>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof signalSchema>, Signal>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof signalsSchema>, Signals>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof statusItemSchema>, StatusItem>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof manifestSchema>, Manifest>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof initialViewSchema>, InitialView>>().toEqualTypeOf<true>();
    expectTypeOf<Same<Out<typeof guiMetaSchema>, GuiMeta>>().toEqualTypeOf<true>();
    // The check itself tells types apart.
    expectTypeOf<Same<{ a: string }, { a: string; b?: true }>>().toEqualTypeOf<false>();
  });
});

// ── Fixtures: synthetic data ─────────────────────────────────────────────────

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MICROGRID = "00000000-0000-4000-8000-0000000000b1";
const AT = "2026-11-07T09:30:00+03:00";
const microgrid = { kind: "microgrid", id: MICROGRID, label: "Demo microgrid" } as const;
const kwh = (v: number): Value => ({ t: "energy", v, unit: "kWh", text: String(v), at: AT });
const poke: ActionRef = { action: "acme.poke", params: { id: MICROGRID }, label: "Poke", enabled: true };

function base<K extends ViewKind>(kind: K, body: BodyOf<K>): ModelOf<K> {
  return {
    type: "view",
    view: `acme.${kind}`,
    kind,
    body,
    title: "Demo",
    org: ORG,
    entity: microgrid,
    trail: [{ label: "Demo microgrid", href: `/microgrids/${MICROGRID}/operations` }],
    actions: [poke],
    links: [
      {
        id: "acme.export",
        label: "Export",
        icon: "download",
        href: "/api/acme/export",
        download: { mime: "text/csv", filename: "day.csv" },
      },
    ],
    attached: [],
  };
}

const metrics = base("metrics", {
  tiles: [{ key: "battery", label: "Battery", value: { t: "percent", v: 64, text: "64%", synthetic: true } }],
  series: [
    {
      key: "soc",
      label: "Charge",
      unit: "%",
      points: [["2026-11-07T00:00:00+03:00", 60], ["2026-11-07T00:05:00+03:00", null]],
    },
  ],
});

const MODELS: { [K in ViewKind]: ModelOf<K> } = {
  collection: base("collection", {
    columns: [{ key: "total", label: "Total (UGX)", type: "money", priority: 1, copy: "bare" }],
    rows: [
      {
        id: "row-1",
        href: `/microgrids/${MICROGRID}/billing`,
        cells: { total: { t: "money", v: 4216800, currency: "UGX", text: "4,216,800" } },
        actions: [poke],
      },
    ],
    totals: { total: { t: "money", v: 4216800, currency: "UGX", text: "4,216,800" } },
    empty: { title: "Nothing yet", action: poke },
  }),
  record: base("record", {
    sections: [
      {
        title: "Site",
        fields: [{ key: "opened", label: "Opened", value: { t: "date", v: "2026-01-31", text: "31 Jan 2026" } }],
      },
    ],
  }),
  metrics,
  feed: base("feed", {
    entries: [
      {
        id: "e1",
        at: AT,
        author: { kind: "system", name: "MGM" },
        text: [
          { p: ["Used ", { value: kwh(12.5) }, " today. "] },
          { li: [{ link: `/microgrids/${MICROGRID}/operations`, text: "Open the day" }, { unverified: "about 3 kWh" }] },
        ],
        embed: { type: "view", href: `/microgrids/${MICROGRID}/operations`, model: metrics },
      },
    ],
    compose: { action: poke, textField: "text", placeholder: "Ask" },
  }),
  flow: base("flow", {
    steps: [
      { id: "a", title: "Readings in", state: "done" },
      { id: "b", title: "Close", state: "todo", action: { ...poke, tone: "danger" } },
    ],
  }),
};

const KINDS = Object.keys(MODELS) as ViewKind[];

/** The issue codes and paths of a failed parse. */
function issues(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => ({ code: i.code, path: i.path.join(".") }));
}

describe("view model schemas", () => {
  it.each(KINDS)("accepts a %s model", (kind) => {
    expect(modelSchema(kind).parse(MODELS[kind])).toEqual(MODELS[kind]);
    expect(viewModelSchema.parse(MODELS[kind])).toEqual(MODELS[kind]);
  });

  it("accepts every example in the billing fixture", () => {
    const examples: unknown[] = (BILLING_SURFACE.views ?? []).flatMap((view): readonly unknown[] => view.examples);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(viewModelSchema.safeParse(example).success).toBe(true);
  });

  it("refuses a model of another kind", () => {
    expect(modelSchema("record").safeParse(MODELS.metrics).success).toBe(false);
  });

  it("refuses an unknown key at the top level, in a cell and inside an embedded model", () => {
    const unknownKey = (path: string) => ({ code: "unrecognized_keys", path });
    expect(issues(viewModelSchema, { ...MODELS.metrics, debug: 1 })).toContainEqual(unknownKey(""));

    const cell = structuredClone(MODELS.collection);
    Object.assign(cell.body.rows[0].cells.total, { raw: "4216800.00" });
    expect(issues(viewModelSchema, cell)).toContainEqual(unknownKey("body.rows.0.cells.total"));

    const embedded = structuredClone(MODELS.feed);
    Object.assign(embedded.body.entries[0].embed!, { model: { ...metrics, token: "x" } });
    expect(issues(viewModelSchema, embedded)).toContainEqual(unknownKey("body.entries.0.embed.model"));
  });

  it("refuses an unknown value type and a malformed date", () => {
    expect(valueSchema.safeParse({ t: "html", text: "<b>1</b>" }).success).toBe(false);
    expect(valueSchema.safeParse({ t: "date", v: "31/01/2026", text: "31 Jan" }).success).toBe(false);
  });

  it("refuses money that is not whole minor units or has no ISO currency", () => {
    const money = { t: "money", v: 1234, currency: "USD", text: "12.34" };
    expect(valueSchema.safeParse(money).success).toBe(true);
    expect(issues(valueSchema, { ...money, v: 12.34 })).toContainEqual({ code: "invalid_type", path: "v" });
    expect(valueSchema.safeParse({ ...money, v: Number.NaN }).success).toBe(false);
    expect(valueSchema.safeParse({ ...money, currency: "usd" }).success).toBe(false);
  });

  it("refuses an id that is not alias.name", () => {
    for (const id of ["acme.poke", "billing.period-review", "org.users.invite"]) {
      expect(idSchema.safeParse(id).success, id).toBe(true);
    }
    for (const id of ["acme", "Acme.poke", "acme.", ".poke", "acme.Poke", "acme poke.x"]) {
      expect(idSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

describe("hrefs", () => {
  it("accepts same-origin paths, queries and kind patterns", () => {
    for (const href of [
      "/",
      `/microgrids/${MICROGRID}/billing?status=draft`,
      "/microgrids/[microgrid]/operations",
      "/api/acme/export?day=2026-11-07",
      "/communities/Kamp%C3%A1la",
    ]) {
      expect(hrefSchema.safeParse(href).success, href).toBe(true);
    }
  });

  it.each([
    ["an absolute URL", "https://example.com/x"],
    ["a protocol-relative URL", "//example.com/x"],
    ["a script URL", "javascript:alert(1)"],
    ["a relative path", "microgrids"],
    ["a backslash", "/\\example.com"],
    ["a backslash later in the path", "/microgrids\\..\\x"],
    ["a dot-dot segment", "/microgrids/../api/x"],
    ["an encoded dot-dot segment", "/microgrids/%2e%2e/api/x"],
    ["an encoded slash", "/microgrids%2fx"],
    ["an encoded backslash", "/microgrids%5Cx"],
    ["a tab", "/micro\tgrids"],
    ["a newline in the query", "/x?a=1\nb"],
    ["a space", "/micro grids"],
    ["a character that is not percent-encoded", "/communities/Kampála"],
    ["more than 2,048 characters", `/${"a".repeat(2048)}`],
  ])("refuses %s", (_name, href) => {
    expect(hrefSchema.safeParse(href).success).toBe(false);
  });

  it("refuses an absolute or protocol-relative href nested in a model", () => {
    const row = structuredClone(MODELS.collection);
    Object.assign(row.body.rows[0], { href: "//example.com/x" });
    expect(issues(viewModelSchema, row).map((i) => i.path)).toContain("body.rows.0.href");

    const trail = { ...MODELS.metrics, trail: [{ label: "Out", href: "https://example.com/" }] };
    expect(issues(viewModelSchema, trail).map((i) => i.path)).toContain("trail.0.href");
  });

  it("lets a link go to WhatsApp, a call or an SMS, and nowhere else outside MGM", () => {
    const link = (href: string) => linkRefSchema.safeParse({ id: "acme.contact", label: "Contact", href }).success;
    expect(link("https://wa.me/256700000001")).toBe(true);
    expect(link("https://wa.me/256700000001?text=Your%20bill%20is%20ready")).toBe(true);
    expect(link("tel:+256700000001")).toBe(true);
    expect(link("sms:+256700000001?body=Hello")).toBe(true);
    expect(link("/api/acme/export")).toBe(true);

    for (const href of [
      "https://wa.me.example.com/256700000001",
      "https://wa.me/256700000001@example.com",
      "https://wa.me/256700000001/../x",
      "https://wa.me/256700000001?text=a b",
      "http://wa.me/256700000001",
      "tel:256700000001",
      "tel:+256-700",
      "sms:+256700000001?url=https://example.com",
      "https://example.com/",
      "mailto:a@example.com",
    ]) {
      expect(link(href), href).toBe(false);
    }
  });
});

describe("shell shapes", () => {
  const signal = {
    id: "s1",
    source: "billing.close",
    severity: "warn",
    title: "October is ready to close",
    href: `/microgrids/${MICROGRID}/billing`,
    at: AT,
    due: "2026-11-10",
  } as const;

  it("refuses a your-move signal that carries an action, and accepts a proposal that does", () => {
    expect(signalSchema.safeParse({ ...signal, kind: "your-move" }).success).toBe(true);
    expect(issues(signalSchema, { ...signal, kind: "your-move", action: poke })).toContainEqual({
      code: "unrecognized_keys",
      path: "",
    });
    expect(signalSchema.safeParse({ ...signal, kind: "proposal", action: poke }).success).toBe(true);
    expect(signalSchema.safeParse({ ...signal, kind: "proposal" }).success).toBe(false);
    const signals = { type: "signals", org: ORG, count: 1, top: [{ ...signal, kind: "alarm" }], checked: [], unchecked: [] };
    expect(signalsSchema.safeParse({ ...signals, checked: ["billing.close"] }).success).toBe(true);
    expect(signalsSchema.safeParse({ ...signals, count: -1 }).success).toBe(false);
  });

  const manifest: Manifest = {
    type: "manifest",
    contract: "0.1.0",
    release: null,
    locale: "en-UG",
    now: AT,
    gui: "gridtop",
    user: { name: "Demo Person", email: "demo@example.com" },
    org: {
      id: ORG,
      name: "Demo organization",
      href: `/organizations/${ORG}`,
      timezone: "Africa/Kampala",
      nav: [
        {
          id: "metering.operations",
          title: "Operations",
          icon: "today",
          group: "operate",
          order: 10,
          href: "/microgrids/[microgrid]/operations",
          needs: ["microgrid"],
          legacy: true,
        },
      ],
      status: [{ id: "acme.watch", label: "Watcher", state: "idle", open: "/acme/watch" }],
      places: [microgrid, { kind: "community", id: "c1", label: "Demo community" }],
    },
    orgs: [{ id: ORG, name: "Demo organization", href: `/organizations/${ORG}` }],
  };

  it("accepts a manifest and refuses anything more about the person", () => {
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
    const extra = { ...manifest, user: { ...manifest.user, roles: ["super_admin"] } };
    expect(issues(manifestSchema, extra)).toContainEqual({ code: "unrecognized_keys", path: "user" });
  });

  it("accepts an action result, and refuses one that mixes success and failure", () => {
    const done: ActionResult = { type: "result", ok: true, message: "Saved", href: "/microgrids", next: poke };
    expect(actionResultSchema.parse(done)).toEqual(done);
    const failed: ActionResult = { type: "result", ok: false, status: 409, code: "plugin_disabled", message: "Off" };
    expect(actionResultSchema.parse(failed)).toEqual(failed);
    expect(actionResultSchema.safeParse({ ...failed, status: 0, code: "cancelled" }).success).toBe(true);
    expect(issues(actionResultSchema, { ...done, status: 500 })).toContainEqual({ code: "unrecognized_keys", path: "" });
    expect(actionResultSchema.safeParse({ ...failed, href: "/microgrids" }).success).toBe(false);
    expect(actionResultSchema.safeParse({ ...failed, status: 40.9 }).success).toBe(false);
    expect(actionResultSchema.safeParse({ ...done, href: "https://example.com/" }).success).toBe(false);
  });

  it("accepts a ceremony, an action spec, a status item, a search hit and an initial view", () => {
    const ceremony: Ceremony = {
      type: "ceremony",
      statement: "Close October 2026 for Demo microgrid",
      facts: [{ label: "Bills", value: { t: "number", v: 12, text: "12" } }],
      warnings: [],
      acknowledgements: [{ id: "final", label: "Closed periods cannot be edited" }],
      typed: "Demo microgrid",
    };
    expect(ceremonySchema.parse(ceremony)).toEqual(ceremony);
    const spec = { type: "spec", id: "acme.poke", title: "Poke", confirm: "confirm", inputVersion: 1, input: { type: "object" } };
    expect(actionSpecSchema.safeParse(spec).success).toBe(true);
    expect(statusItemSchema.safeParse(manifest.org.status[0]).success).toBe(true);
    expect(entityHitSchema.safeParse({ ...microgrid, href: `/microgrids/${MICROGRID}` }).success).toBe(true);
    expect(entityHitSchema.safeParse(microgrid).success).toBe(false);
    const initial = { view: null, title: "Billing", trail: [], tabs: [] };
    expect(initialViewSchema.safeParse({ ...initial, scope: { microgrid } }).success).toBe(true);
    expect(initialViewSchema.safeParse({ ...initial, scope: { site: microgrid } }).success).toBe(false);
  });
});

describe("GUI metadata", () => {
  const meta: GuiMeta = {
    name: "probe",
    title: "Probe",
    version: "0.1.0",
    contract: "^0.1",
    styles: "./styles.css",
    dependencies: ["lucide-react"],
  };

  it("accepts caret ranges", () => {
    for (const contract of ["^0.1", "^0.1.2", "^1.2"]) {
      expect(guiMetaSchema.safeParse({ ...meta, contract }).success, contract).toBe(true);
    }
  });

  it("refuses other range syntax, a style outside the package and a repeated dependency", () => {
    for (const contract of [">=0.1", "~0.1", "0.1", "^0.x", "^0.1 || ^1", "*", "^1", "^0.1.2.3"]) {
      expect(guiMetaSchema.safeParse({ ...meta, contract }).success, contract).toBe(false);
    }
    expect(guiMetaSchema.safeParse({ ...meta, styles: "./../shared.css" }).success).toBe(false);
    expect(guiMetaSchema.safeParse({ ...meta, dependencies: ["cmdk", "cmdk"] }).success).toBe(false);
    expect(guiMetaSchema.safeParse({ ...meta, Shell: null }).success).toBe(false);
  });
});

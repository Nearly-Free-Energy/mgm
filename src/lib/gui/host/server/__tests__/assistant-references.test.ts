/**
 * The assistant reference rule in ../assistant-references.ts: which
 * positions it reads, and one refusal for each kind of reference and each
 * position, with what it lets through.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { ViewDef } from "../../../surface";
import { findRefusedReference, hrefRefusal, refusedKind } from "../assistant-references";
import { entityRefSchema, hrefSchema, linkRefSchema, loadedModelSchemas, outHrefSchema, signalsSchema, viewModelSchema } from "../model-schema";
import { DATA_KEYS, HREF_KEYS } from "../parse";
import type { RegisteredView } from "../surface-registry";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const ID = "e7100000-0000-4000-8009-000000000001";

const registered = (plugin: MgmPluginName, def: Partial<ViewDef>): RegisteredView => ({
  plugin,
  def: { kind: "metrics", params: {}, cost: "db", declares: { keys: [] }, examples: [], ...def } as unknown as ViewDef,
});
const VIEWS: RegisteredView[] = [
  registered("metering", { id: "metering.site-day", path: "/microgrids/[id]/operations", params: { id: "microgrid" }, query: ["date"] }),
  registered("billing", { id: "billing.period", path: "/microgrids/[id]/billing/[periodId]", params: { id: "microgrid", periodId: "billingPeriod" } }),
];
const refused = (value: unknown) => findRefusedReference(value, VIEWS);

const ref = (kind: string) => ({ kind, id: ID, label: "Label" });
const value = (kind: string) => ({ t: "ref", text: "Label", ref: ref(kind) });
const DAY = `/microgrids/${MG}/operations?date=2026-11-08`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each case reaches into a different position
type M = Record<string, any>;
/** A collection model an assistant may be given, with a place for each position. */
function model() {
  return {
    type: "view",
    view: "metering.site-day",
    kind: "collection",
    title: "Day",
    org: ID,
    entity: ref("microgrid"),
    trail: [{ label: "Site", href: `/microgrids/${MG}/operations` }],
    actions: [],
    links: [{ id: "metering.day-next", label: "Next", href: DAY }],
    attached: [],
    body: {
      columns: [],
      rows: [{ id: "r1", entity: ref("edge"), related: [ref("community")], href: DAY, cells: { a: value("microgrid") }, actions: [] }],
      filters: [{ label: "All", href: `${DAY}&org=${ID}`, current: true }],
      next: DAY,
      empty: { title: "None" },
    },
  } as M;
}
const signal = (entity = ref("microgrid")) => ({
  id: "metering.connection:x",
  source: "metering.connection",
  kind: "alarm",
  severity: "warn",
  title: "Kiwumu",
  facts: [{ t: "text", text: "fact" }],
  entity,
  href: `/microgrids/${MG}/setup/openems-backend`,
  at: "2026-11-09T07:00:00Z",
});

describe("the positions the rule reads", () => {
  type Def = {
    type: string;
    shape?: Record<string, z.ZodType>;
    element?: z.ZodType;
    items?: z.ZodType[];
    rest?: z.ZodType | null;
    options?: z.ZodType[];
    innerType?: z.ZodType;
    valueType?: z.ZodType;
    getter?: () => z.ZodType;
  };
  const defOf = (s: z.ZodType) => s._zod.def as unknown as Def;
  const LEAVES = new Set(["string", "number", "boolean", "literal", "enum", "template_literal", "null", "int"]);
  const REF_PROPS = new Set(["entity", "related", "ref"]);

  /** Every EntityRef and href position in a schema, checked against the names the rule reads them by. */
  function audit(schema: z.ZodType) {
    const problems: string[] = [];
    const found = { refs: 0, hrefs: 0 };
    const seen = new Set<z.ZodType>();
    // `prop` is the nearest property holding this schema; `direct` is false once an array or record intervenes.
    const visit = (s: z.ZodType, prop: string, direct: boolean, at: string): void => {
      if (s === entityRefSchema) {
        found.refs++;
        const fits = prop === "related" ? !direct : direct && REF_PROPS.has(prop);
        if (!fits) problems.push(`${at}: an EntityRef the rule would not read`);
      }
      if (s === hrefSchema || s === outHrefSchema) {
        found.hrefs++;
        if (!direct || !HREF_KEYS.has(prop)) problems.push(`${at}: an href the rule would not read`);
        return;
      }
      if (seen.has(s)) return;
      seen.add(s);
      const d = defOf(s);
      switch (d.type) {
        case "object": {
          const keys = Object.keys(d.shape!);
          if (s !== entityRefSchema && ["kind", "id", "label"].every((k) => keys.includes(k)))
            problems.push(`${at}: a copy of EntityRef the rule would not recognise`);
          for (const [key, child] of Object.entries(d.shape!)) {
            if (DATA_KEYS.has(key)) continue;
            visit(child, key, true, `${at}.${key}`);
          }
          return;
        }
        case "optional":
        case "nullable":
          return visit(d.innerType!, prop, direct, at);
        case "lazy":
          return visit(d.getter!(), prop, direct, at);
        case "union":
          return d.options!.forEach((o) => visit(o, prop, direct, at));
        case "array":
          return visit(d.element!, prop, false, `${at}[]`);
        case "tuple":
          return [...d.items!, ...(d.rest ? [d.rest] : [])].forEach((i) => visit(i, prop, false, `${at}[]`));
        case "record":
          return visit(d.valueType!, prop, false, `${at}.*`);
        default:
          if (!LEAVES.has(d.type)) problems.push(`${at}: a ${d.type} the audit does not know`);
      }
    };
    visit(schema, "", true, "(value)");
    return { problems, found };
  }

  const SCHEMAS: [string, z.ZodType][] = [
    ["a view model, with its embeds and signals", viewModelSchema],
    ["signals", signalsSchema],
    ...Object.entries(loadedModelSchemas).map(([kind, s]): [string, z.ZodType] => [`a loaded ${kind} model`, s]),
  ];
  it.each(SCHEMAS)("finds every EntityRef and href in %s under the names it reads", (_name, schema) => {
    const { problems, found } = audit(schema);
    expect(problems).toEqual([]);
    expect(found.refs).toBeGreaterThan(0);
    expect(found.hrefs).toBeGreaterThan(0);
  });

  it("finds LinkRef's share and download only on a LinkRef", () => {
    expect(Object.keys(linkRefSchema.shape)).toEqual(expect.arrayContaining(["share", "download"]));
  });
});

describe("findRefusedReference", () => {
  it("lets through a model of places, links to them and its own days", () => {
    expect(refused(model())).toBeNull();
    expect(refused(signal())).toBeNull();
  });

  it.each([
    ["the entity", (m: M) => (m.entity = ref("tenant")), "entity", "tenant"],
    ["a related entity", (m: M) => (m.body.rows[0].related = [ref("community"), ref("device")]), "body.rows.0.related.1", "device"],
    ["a row's entity", (m: M) => (m.body.rows[0].entity = ref("lineItem")), "body.rows.0.entity", "lineItem"],
    ["a ref value", (m: M) => (m.body.rows[0].cells.a = value("billingPeriod")), "body.rows.0.cells.a.ref", "billingPeriod"],
    ["a ref value in a total", (m: M) => (m.body.totals = { a: value("paymentAttempt") }), "body.totals.a.ref", "paymentAttempt"],
    ["a trail href", (m: M) => (m.trail[0].href = `/microgrids/${MG}/setup/tenants/${ID}`), "trail.0.href", "tenant"],
    ["a link", (m: M) => (m.links[0].href = `/microgrids/${MG}/billing/${ID}`), "links.0.href", "billingPeriod"],
    ["a row href", (m: M) => (m.body.rows[0].href = `/microgrids/${MG}/setup/tenants/${ID}`), "body.rows.0.href", "tenant"],
    ["a filter", (m: M) => (m.body.filters[0].href = `/microgrids/${MG}/setup/tenants?tenant=${ID}`), "body.filters.0.href", "search parameter"],
    ["an EntityRef's own href", (m: M) => (m.entity.href = `/microgrids/${MG}/billing/${ID}/payments`), "entity.href", "billingPeriod"],
    ["a row's LinkRef", (m: M) => (m.body.rows[0].links = [{ id: "metering.x", label: "x", href: "tel:+256700000000" }]), "body.rows.0.links.0.href", "outside link"],
    ["a LinkRef to a device's API route", (m: M) => (m.links[0].href = `/api/devices/${ID}`), "links.0.href", "api route"],
    ["a fragment", (m: M) => (m.links[0].href = `${DAY}#tenant-${ID}`), "links.0.href", "fragment"],
  ])("refuses a reference in %s", (_name, edit, path, kind) => {
    const m = model();
    edit(m);
    expect(refused(m)).toEqual({ path, kind });
  });

  it("refuses an inline link in a feed entry's text", () => {
    const feed = {
      ...model(),
      kind: "feed",
      body: { entries: [{ id: "e1", at: "2026-11-09T07:00:00Z", author: { kind: "system", name: "MGM" }, text: [{ p: [{ link: `/microgrids/${MG}/setup/tenants/${ID}`, text: "x" }] }] }] },
    };
    expect(refused(feed)).toEqual({ path: "body.entries.0.text.0.p.0.link", kind: "tenant" });
  });

  it("refuses a signal about a tenant, and one linking to a billing period", () => {
    expect(refused(signal(ref("tenant")))).toEqual({ path: "entity", kind: "tenant" });
    expect(refused({ ...signal(), href: `/microgrids/${MG}/billing/${ID}` })).toEqual({ path: "href", kind: "billingPeriod" });
    expect(refused({ ...signal(), facts: [value("device")] })).toEqual({ path: "facts.0.ref", kind: "device" });
  });

  it("refuses a plugin kind whose alias names no plugin, or a plugin whose reading is refused", () => {
    for (const kind of ["nope.thing", "billing.x", "pesapal.x", "tenant.unit", "metering"]) {
      const m = model();
      m.entity = ref(kind);
      expect(refused(m), kind).toEqual({ path: "entity", kind });
    }
    const m = model();
    m.entity = ref("metering.thing");
    expect(refused(m)).toBeNull();
  });

  it("refuses a LinkRef that shares or downloads", () => {
    const shared = model();
    shared.links[0].share = { title: "Day", text: "free text" };
    expect(refused(shared)).toEqual({ path: "links.0.share", kind: "share" });
    const downloaded = model();
    downloaded.links[0].download = { mime: "text/csv", filename: "day.csv" };
    expect(refused(downloaded)).toEqual({ path: "links.0.download", kind: "download" });
  });

  it("reads a declared key named like a position as a key, not a position", () => {
    const m = model();
    m.body.rows[0].cells = { entity: { t: "text", text: "x" }, href: { t: "text", text: "y" }, share: { t: "text", text: "z" } };
    expect(refused(m)).toBeNull();
  });

  it("does not read ext, params or prefill", () => {
    const m = model();
    m.ext = { schema: "metering.site-day@2", data: { entity: ref("tenant"), href: "tel:+256700000000" } };
    m.actions = [{ action: "metering.x", params: { tenant: ID }, label: "x", enabled: true, prefill: { entity: ref("tenant") } }];
    expect(refused(m)).toBeNull();
  });
});

describe("hrefRefusal", () => {
  it.each([
    ["a billing page with no segment", "/billing", null],
    ["a view with its declared query and org", `${DAY}&org=${ID}`, null],
    ["a catalog page no view serves", `/microgrids/${MG}/setup/edges`, null],
    ["a phone number", "tel:+256700000000", "outside link"],
    ["a WhatsApp number", "https://wa.me/256700000000", "outside link"],
    ["another origin", "//evil.example/x", "outside link"],
    ["a billing download", `/api/billing-line-items/${ID}/pdf`, "api route"],
    ["a route no plugin owns", "/api/nothing", "api route"],
    ["a metering route", "/api/metering/x", "api route"],
    ["a tenant's API route", `/api/tenants/${ID}`, "api route"],
    ["a tenant's access route", `/api/tenants/${ID}/access`, "api route"],
    ["a tenant's assignments route", `/api/tenants/${ID}/assignments`, "api route"],
    ["a device's API route", `/api/devices/${ID}`, "api route"],
    ["a fragment on a catalog page", `/microgrids/${MG}/setup/edges#tenant-${ID}`, "fragment"],
    ["a fragment on a view", `${DAY}#x`, "fragment"],
    ["an empty fragment", `/microgrids/${MG}/setup/edges#`, "fragment"],
    ["a released page no view or catalog page names", "/login", "unknown page"],
    ["?tenant= on a view", `/microgrids/${MG}/operations?tenant=${ID}`, "search parameter"],
    ["a query on a catalog page no view serves", `/microgrids/${MG}/setup/edges?x=1`, "search parameter"],
    ["a view segment of a refused kind", `/microgrids/${MG}/billing/${ID}`, "billingPeriod"],
    ["a catalog segment of a refused kind", `/microgrids/${MG}/setup/tenants/${ID}`, "tenant"],
  ])("answers %s", (_name, href, why) => {
    expect(hrefRefusal(href, VIEWS)).toBe(why);
  });
});

describe("refusedKind", () => {
  it("refuses the boundary's core kinds and allows the places", () => {
    expect(["tenant", "device", "rateSchedule", "billingPeriod", "lineItem", "paymentAttempt"].filter(refusedKind)).toHaveLength(6);
    expect(["organization", "community", "microgrid", "edge"].filter(refusedKind)).toEqual([]);
  });
});

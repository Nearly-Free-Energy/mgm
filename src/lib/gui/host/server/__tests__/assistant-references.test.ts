/**
 * The assistant reference rule in ../assistant-references.ts: which
 * positions it reads, and one refusal for each kind of reference and each
 * position, with what it lets through.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TENANT_ACCESS_KIND } from "@/lib/community-management/surface";
import { USER_KIND } from "@/lib/organization-directory/surface";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { getMgmRuntime } from "@/lib/runtime/root";
import type { ViewDef } from "../../../surface";
import { findRefusedReference, hrefRefusal, refusedKind } from "../assistant-references";
import { ASSISTANT_READING } from "../contribution-schema";
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
  // A refused plugin's view whose segments are all allowed and whose query
  // names a billing period, as a later billing view might.
  registered("billing", { id: "billing.periods", path: "/microgrids/[id]/billing", params: { id: "microgrid" }, query: ["period"] }),
  // A tenant view, contributed by a "per view" plugin, so only its scope refuses it.
  registered("metering", { id: "metering.my-day", path: "/my/day", scope: "tenant", params: {}, query: ["tenant"] } as Partial<ViewDef>),
  // A "per view" plugin's organization view with a declared parameter.
  registered("community-management", { id: "community.roster", path: "/microgrids/[id]/roster", params: { id: "microgrid" }, query: ["sort"] }),
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
    values?: unknown[];
  };
  const defOf = (s: z.ZodType) => s._zod.def as unknown as Def;
  const LEAVES = new Set(["string", "number", "boolean", "literal", "enum", "template_literal", "null", "int"]);

  /** Whether an object schema is the Value with `t: "ref"`, the only object whose `ref` the rule reads. */
  const isRefValue = (shape: Record<string, z.ZodType>) => {
    const t = shape.t === undefined ? undefined : defOf(shape.t);
    return t?.type === "literal" && t.values!.length === 1 && t.values![0] === "ref";
  };

  /** Every EntityRef and href position in a schema, checked against the names the rule reads them by. */
  function audit(schema: z.ZodType) {
    const problems: string[] = [];
    const found = { refs: 0, hrefs: 0 };
    const seen = new Set<string>();
    const ids = new Map<z.ZodType, number>();
    // `prop` is the nearest property holding this schema; `direct` is false once an array or record intervenes;
    // `onRefValue` is whether that property is `ref` on the `t: "ref"` Value; `inRelated` is whether this is
    // an element of an array (or tuple) held directly by `related`, the only elements of `related` the rule reads.
    const visit = (s: z.ZodType, prop: string, direct: boolean, onRefValue: boolean, inRelated: boolean, at: string): void => {
      if (s === entityRefSchema) {
        found.refs++;
        const fits = prop === "related" ? inRelated : direct && (prop === "entity" || (prop === "ref" && onRefValue));
        if (!fits) problems.push(`${at}: an EntityRef the rule would not read`);
      }
      if (s === hrefSchema || s === outHrefSchema) {
        found.hrefs++;
        if (!direct || !HREF_KEYS.has(prop)) problems.push(`${at}: an href the rule would not read`);
        return;
      }
      // A schema is visited once per position the rule could read it in, not once in all.
      if (!ids.has(s)) ids.set(s, ids.size);
      const state = `${ids.get(s)}:${prop}:${direct}:${onRefValue}:${inRelated}`;
      if (seen.has(state)) return;
      seen.add(state);
      const d = defOf(s);
      switch (d.type) {
        case "object": {
          const keys = Object.keys(d.shape!);
          if (s !== entityRefSchema && ["kind", "id", "label"].every((k) => keys.includes(k)))
            problems.push(`${at}: a copy of EntityRef the rule would not recognise`);
          const refValue = isRefValue(d.shape!);
          for (const [key, child] of Object.entries(d.shape!)) {
            if (DATA_KEYS.has(key)) continue;
            visit(child, key, true, key === "ref" && refValue, false, `${at}.${key}`);
          }
          return;
        }
        case "optional":
        case "nullable":
          return visit(d.innerType!, prop, direct, onRefValue, inRelated, at);
        case "lazy":
          return visit(d.getter!(), prop, direct, onRefValue, inRelated, at);
        case "union":
          return d.options!.forEach((o) => visit(o, prop, direct, onRefValue, inRelated, at));
        // The rule reads the direct elements of an array value under `related`; a tuple's value is an array too.
        case "array":
          return visit(d.element!, prop, false, false, direct && prop === "related", `${at}[]`);
        case "tuple":
          return [...d.items!, ...(d.rest ? [d.rest] : [])].forEach((i) => visit(i, prop, false, false, direct && prop === "related", `${at}[]`));
        case "record":
          return visit(d.valueType!, prop, false, false, false, `${at}.*`);
        default:
          if (!LEAVES.has(d.type)) problems.push(`${at}: a ${d.type} the audit does not know`);
      }
    };
    visit(schema, "", true, false, false, "(value)");
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

  it("reports an EntityRef under `ref` on anything but the `t: \"ref\"` Value, and one in a position it does not read", () => {
    const at = (schema: z.ZodType) => audit(schema).problems;
    expect(at(z.strictObject({ t: z.literal("ref"), ref: entityRefSchema }))).toEqual([]);
    expect(at(z.strictObject({ type: z.literal("entity"), ref: entityRefSchema }))).toEqual(["(value).ref: an EntityRef the rule would not read"]);
    expect(at(z.strictObject({ t: z.literal("text"), ref: entityRefSchema }))).toEqual(["(value).ref: an EntityRef the rule would not read"]);
    expect(at(z.strictObject({ t: z.literal("ref"), body: z.strictObject({ ref: entityRefSchema }) }))).toEqual(["(value).body.ref: an EntityRef the rule would not read"]);
    expect(at(z.strictObject({ owner: entityRefSchema }))).toEqual(["(value).owner: an EntityRef the rule would not read"]);
    expect(at(z.strictObject({ entity: z.array(entityRefSchema) }))).toEqual(["(value).entity[]: an EntityRef the rule would not read"]);
    // And the rule agrees: it reads the first, and lets the second through.
    expect(refused({ t: "ref", text: "x", ref: ref("tenant") })).toEqual({ path: "ref", kind: "tenant" });
    expect(refused({ type: "entity", ref: ref("tenant") })).toBeNull();
  });

  it("reports an EntityRef under `related` anywhere but an element of the array `related` holds", () => {
    const at = (schema: z.ZodType) => audit(schema).problems;
    expect(at(z.strictObject({ related: z.array(entityRefSchema).optional() }))).toEqual([]);
    expect(at(z.strictObject({ related: entityRefSchema }))).toEqual(["(value).related: an EntityRef the rule would not read"]);
    expect(at(z.strictObject({ related: z.array(z.array(entityRefSchema)) }))).toEqual(["(value).related[][]: an EntityRef the rule would not read"]);
    expect(at(z.strictObject({ related: z.record(z.string(), entityRefSchema) }))).toEqual(["(value).related.*: an EntityRef the rule would not read"]);
    // And the rule agrees: it reads the first, and lets the others through.
    expect(refused({ related: [ref("tenant")] })).toEqual({ path: "related.0", kind: "tenant" });
    expect(refused({ related: [[ref("tenant")]] })).toBeNull();
    expect(refused({ related: { a: ref("tenant") } })).toBeNull();
  });

  it("visits a schema shared between positions once in each, so a read position does not hide one it does not read", () => {
    const at = (schema: z.ZodType) => audit(schema).problems;
    const shared = entityRefSchema.optional();
    expect(at(z.strictObject({ entity: shared, owner: shared }))).toEqual(["(value).owner: an EntityRef the rule would not read"]);
    expect(
      at(z.strictObject({ value: z.strictObject({ t: z.literal("ref"), ref: shared }), embed: z.strictObject({ type: z.literal("entity"), ref: shared }) })),
    ).toEqual(["(value).embed.ref: an EntityRef the rule would not read"]);
    const list = z.array(entityRefSchema);
    expect(at(z.strictObject({ related: list, owners: list }))).toEqual(["(value).owners[]: an EntityRef the rule would not read"]);
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
    ["a tenant's access", (m: M) => (m.entity = ref(TENANT_ACCESS_KIND)), "entity", "community.tenant-access"],
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
    ["a billing page with no segment", "/billing", "refused plugin"],
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
    ["a refused plugin's view, bare", `/microgrids/${MG}/billing`, "refused plugin"],
    ["a refused plugin's view with its declared parameter", `/microgrids/${MG}/billing?period=${ID}`, "refused plugin"],
    ["a refused plugin's view with org only", `/microgrids/${MG}/billing?org=${ID}`, "refused plugin"],
    ["a tenant view, bare", "/my/day", "tenant view"],
    ["a tenant view with its declared parameter", `/my/day?tenant=${ID}`, "tenant view"],
    ["a per-view plugin's view with its declared parameter", `/microgrids/${MG}/roster?sort=name&org=${ID}`, null],
    ["a per-view plugin's view with an undeclared parameter", `/microgrids/${MG}/roster?period=${ID}`, "search parameter"],
    ["a refused plugin's catalog page no view serves", `/microgrids/${MG}/setup/rates`, "refused plugin"],
    ["the tenant app's catalog page no view serves", "/my/usage", "refused plugin"],
  ])("answers %s", (_name, href, why) => {
    expect(hrefRefusal(href, VIEWS)).toBe(why);
  });

  it("refuses every refused plugin's and every tenant view in the real surface, bare and with each declared parameter", async () => {
    const { views } = (await getMgmRuntime()).mgmSurface.snapshot();
    const shut = views.filter((v) => ASSISTANT_READING[v.plugin] === "refused" || v.def.scope === "tenant");
    // The surface has such views with declared parameters (billing's ?tenant_id=, payments' ?bill=).
    expect(shut.filter((v) => (v.def.query ?? []).length > 0).length).toBeGreaterThan(0);
    for (const v of shut) {
      const path = v.def.path.replace(/\[([^\]]+)\]/g, (_m, name: string) => (v.def.params[name] === "microgrid" ? MG : ID));
      const hrefs = [path, ...(v.def.query ?? []).map((q) => `${path}?${q}=${ID}`)];
      for (const href of hrefs) expect(hrefRefusal(href, views), `${v.def.id} ${href}`).not.toBeNull();
    }
  });
});

describe("refusedKind", () => {
  it("refuses the boundary's core kinds and allows the places", () => {
    expect(["tenant", "device", "rateSchedule", "billingPeriod", "lineItem", "paymentAttempt"].filter(refusedKind)).toHaveLength(6);
    expect(["organization", "community", "microgrid", "edge"].filter(refusedKind)).toEqual([]);
  });

  it("refuses community management's tenant access, and not its other kinds", () => {
    expect(refusedKind(TENANT_ACCESS_KIND)).toBe(true);
    expect(refusedKind("community.other")).toBe(false);
  });

  it("refuses the organization directory's person", () => {
    expect(refusedKind(USER_KIND)).toBe(true);
  });
});

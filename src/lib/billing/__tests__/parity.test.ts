/**
 * The billing parity table (src/lib/billing/parity.ts) against the code (#201).
 *
 * Every row names something real: its route with the method and body
 * schema, its page or GET route, and, while it is pending, its legacy
 * component. Every row is either contributed, matching the contribution, or
 * listed in PENDING below. The contributing pull requests of #201 remove
 * their rows from PENDING as they land; the legacy billing screens may be
 * deleted only once PENDING is empty, which the last test enforces.
 *
 * What counts as contributed, by kind of row:
 *  - action: the plugin contributes the action, with the row's route,
 *    method, target, risk, confirmation and schema, and an interface can
 *    submit it: the kit renders a form for the input a person fills
 *    (fieldsOf in src/lib/gui/kit/action-form.tsx is not null), or an
 *    installed GUI registers its own form for the action (GuiPlugin.forms).
 *    An action the host can only answer with NO_FORM stays pending, however
 *    it is contributed.
 *  - link: an example of the row's view carries an href the row fits on
 *    what the row's `via` names: its LinkRef (by id; with `download` for a
 *    download row), a row's own href or an EntityRef's. The view existing is
 *    not enough, and neither is the same href on the host's trail or on
 *    another of the view's links.
 *  - view: the view is contributed.
 *  - nav: the nav entry opens a view rather than a legacy page.
 *  - copy: never seen in a contribution, since copying is the GUI's to draw.
 *    The pull request that delivers it removes it from PENDING by hand, and
 *    its view must then be contributed.
 * A row whose pr is "unscheduled" stays pending whatever is contributed: it
 * needs a decision, not an accident of another pull request.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INSTALLED_GUIS } from "@/gui/installed";
import type { Json } from "@/lib/gui/contract";
import type { ActionDef, Contribution } from "@/lib/gui/surface";
import { DATA_KEYS } from "@/lib/gui/host/server/parse";
import { fieldsOf } from "@/lib/gui/kit/action-form";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import { BILLING_SURFACE } from "../surface";
import * as schemas from "../schemas";
import { BILLING_PARITY, type ParityAction, type ParityLink, type ParityRow } from "../parity";

const ROOT = path.resolve(__dirname, "../../../..");
const APP = path.join(ROOT, "src/app");

/**
 * Rows not contributed yet. A pull request that contributes a row's action,
 * link, view or nav entry, or delivers its copy control, removes the row here
 * in the same change; the test fails if a contributed row is left behind,
 * and if a row is neither contributed nor listed.
 */
const PENDING = new Set<string>([
  // Waits for a form: contributed, but the kit cannot render
  // GenerateBillsBody's tenant arrays and no GUI registers a form for it,
  // so no interface could submit it (see `submittable` below).
  "generate-bills",
  // Contribute the send queue on …/send
  "payment-link",
  "copy-payment-link",
  "payment-setup",
  // Contribute a bill's payment attempts
  "payment-history",
  "refresh-attempt",
  "record-adjustment",
  "accept-receipts",
  // Serve the billing pages through the GUI host
  "billing-tab",
]);

/** The legacy screens #201 deletes once nothing is pending. */
const LEGACY_SCREENS = [
  "src/components/BillingTable.tsx",
  "src/components/BillingPeriodList.tsx",
  "src/app/(gui)/microgrids/[id]/billing/page.tsx",
  "src/app/(gui)/microgrids/[id]/billing/[periodId]/page.tsx",
  "src/app/(gui)/microgrids/[id]/billing/[periodId]/history/page.tsx",
];

const SURFACES: Record<ParityAction["plugin"], Contribution> = {
  billing: BILLING_SURFACE,
  payments: PAYMENTS_SURFACE,
};

type Kind = ParityRow["replacedBy"]["kind"];
type Of<K extends Kind> = ParityRow & { replacedBy: Extract<ParityRow["replacedBy"], { kind: K }> };
const ofKind =
  <K extends Kind>(kind: K) =>
  (r: ParityRow): r is Of<K> =>
    r.replacedBy.kind === kind;

/** A route's source with its comments removed, so a call left in a comment does not count. */
function routeSource(route: string): string | null {
  const file = path.join(APP, route, "route.ts");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const exportsMethod = (source: string, method: string) =>
  new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\b`).test(source);

/** A page under src/app, inside any route group. */
function pageExists(href: string): boolean {
  const segments = href.split("/").filter(Boolean);
  const walk = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) return existsSync(path.join(dir, "page.tsx"));
    if (existsSync(path.join(dir, rest[0])) && walk(path.join(dir, rest[0]), rest.slice(1))) return true;
    try {
      return readdirSync(dir, { withFileTypes: true }).some(
        (e) => e.isDirectory() && /^\(.+\)$/.test(e.name) && walk(path.join(dir, e.name), rest)
      );
    } catch {
      return false;
    }
  };
  return walk(APP, segments);
}

function contributedAction(a: ParityAction): ActionDef | undefined {
  return SURFACES[a.plugin].actions?.find((d) => d.id === a.action);
}

/**
 * The JSON Schema of what a person fills for `def`: its input with the bound
 * fields and `confirmation` removed, as the host prepares it for the kit
 * (inputSpec in src/lib/gui/host/server/prepare.ts). If the host comes to
 * hide other fields, revisit.
 */
function personInput(def: ActionDef): Json {
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(def.input, { io: "input" }))) as Record<string, Json>;
  const hidden = new Set([...Object.keys(def.bind.path ?? {}), ...Object.keys(def.bind.body ?? {}), "confirmation"]);
  if (schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !hidden.has(k)));
  }
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((k) => !hidden.has(k as string));
  return schema as Json;
}

/**
 * Whether an interface can submit `def`: the kit's form renders its input
 * (an input with no fields to fill renders as none), or an installed GUI
 * registers a form for it that reads its input version, at a level the host
 * hands a GUI's form (none and confirm, as ActionHost in
 * src/lib/gui/host/client/action-host.tsx decides).
 */
function submittable(def: ActionDef): boolean {
  if (fieldsOf(personInput(def)) !== null) return true;
  if (def.confirm !== "none" && def.confirm !== "confirm") return false;
  return Object.values(INSTALLED_GUIS).some((gui) => gui.forms?.[def.id]?.reads.includes(def.inputVersion) === true);
}

function contributedView(id: string): boolean {
  return Object.values(SURFACES).some((s) => s.views?.some((v) => v.id === id));
}

/**
 * Whether a view's copy figures reach a person: the view declares an ext, and
 * an installed GUI registers a renderer reading its version. The kit's view
 * copies nothing, so without both a copy row has no control.
 */
function copiedByARenderer(id: string): boolean {
  const view = Object.values(SURFACES)
    .flatMap((s) => s.views ?? [])
    .find((v) => v.id === id);
  const schema = view?.ext?.schema;
  if (!schema) return false;
  const version = Number(schema.slice(schema.lastIndexOf("@") + 1));
  return Object.values(INSTALLED_GUIS).some((gui) => gui.renderers?.[id as `${string}.${string}`]?.reads.includes(version) === true);
}

/**
 * Every object in a model outside data subtrees and the host's trail, with
 * the key it sits under (an array's items take the array's key). The trail
 * is the host's, filled from the path (src/lib/gui/host/server/entities.ts),
 * and links every view's parents, so it shows nothing a view contributes.
 */
function objectsOf(value: unknown, key = "", out: { key: string; o: Record<string, unknown> }[] = []): { key: string; o: Record<string, unknown> }[] {
  if (Array.isArray(value)) value.forEach((item) => objectsOf(item, key, out));
  else if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    out.push({ key, o });
    for (const [k, child] of Object.entries(o)) if (!DATA_KEYS.has(k) && k !== "trail") objectsOf(child, k, out);
  }
  return out;
}

/**
 * The hrefs in a model that `via` names, and whether each sits on an object
 * with a `download`: the LinkRef with that id (in a `links` list), a row's
 * own href, or an EntityRef's. Only what the view itself put there.
 */
function carriedHrefs(model: unknown, via: NonNullable<ParityLink["via"]>): { href: string; download: boolean }[] {
  return objectsOf(model)
    .filter(({ key, o }) => {
      if (typeof o.href !== "string") return false;
      if (via === "row") return key === "rows";
      if (via === "entity") return typeof o.kind === "string" && typeof o.id === "string" && typeof o.label === "string";
      return key === "links" && o.id === via.link;
    })
    .map(({ o }) => ({ href: o.href as string, download: o.download !== undefined }));
}

/** A row's href as a pattern: each [segment] any one segment, any query or fragment allowed. */
function hrefPattern(href: string): RegExp {
  const body = href
    .split("/")
    .map((s) => (/^\[.+\]$/.test(s) ? "[^/?#]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}(?:[?#].*)?$`);
}

const examplesOf = (view: string): readonly unknown[] =>
  Object.values(SURFACES).flatMap((s) => (s.views ?? []).filter((v) => v.id === view).flatMap((v): readonly unknown[] => v.examples));

/**
 * A link row is contributed only when an example of its view carries an
 * href it fits on what the row names in `via` (for a download row, a LinkRef
 * with `download`): a view existing is not enough, and neither is the same
 * href on the host's trail or on another of the view's links.
 */
function contributedLink(l: ParityLink, examples: readonly unknown[] = examplesOf(l.view)): boolean {
  const via = l.via;
  if (via === undefined) return false;
  const pattern = hrefPattern(l.href);
  return examples.some((example) => carriedHrefs(example, via).some((h) => pattern.test(h.href) && (!l.download || h.download)));
}

/** A nav entry that opens a view rather than a legacy page. */
function contributedNav(id: string): boolean {
  return Object.values(SURFACES).some((s) => s.nav?.some((n) => n.id === id && "view" in n));
}

/** Whether a contribution shows the row as replaced. A copy row never does. */
function isContributed(r: ParityRow): boolean {
  const by = r.replacedBy;
  switch (by.kind) {
    case "action": {
      const def = contributedAction(by);
      return def !== undefined && submittable(def);
    }
    case "link":
      return contributedLink(by);
    case "view":
      return contributedView(by.view);
    case "nav":
      return contributedNav(by.nav);
    case "copy":
      return false;
  }
}

describe("the billing parity table", () => {
  it("gives every row a unique id, and every pending row a legacy component that exists", () => {
    const ids = BILLING_PARITY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Only pending rows: the Deletes pull request removes the legacy files once nothing is pending.
    for (const row of BILLING_PARITY.filter((r) => PENDING.has(r.id))) {
      for (const file of row.legacy.split(", ")) {
        expect(existsSync(path.join(ROOT, file)), `${row.id}: ${file}`).toBe(true);
      }
    }
  });

  it.each(BILLING_PARITY.filter(ofKind("action")).map((r) => [r.id, r.replacedBy] as const))(
    "%s: names a route that exports its method and parses its form, or says the route is new",
    (_id, a) => {
      const source = routeSource(a.route);
      if (a.newRoute) {
        // Drop newRoute once the route exists, so the row is checked like the others.
        expect(source === null || !exportsMethod(source, a.method), `${a.route} exports ${a.method}`).toBe(true);
        return;
      }
      expect(source, `src/app${a.route}/route.ts`).not.toBeNull();
      expect(exportsMethod(source!, a.method), `${a.route} exports ${a.method}`).toBe(true);
      if (a.form) {
        expect(Object.hasOwn(schemas, a.form), `${a.form} is exported from schemas.ts`).toBe(true);
        expect(source!, `${a.route} parses ${a.form}`).toMatch(new RegExp(`parseJsonBody\\(\\s*\\w+\\s*,\\s*${a.form}\\s*\\)`));
      }
    }
  );

  it("gives each action the confirmation its risk and method need, as a contribution does", () => {
    for (const row of BILLING_PARITY.filter(ofKind("action"))) {
      const a = row.replacedBy;
      if (a.method === "DELETE" || a.risk === "destructive") expect(["typed", "ceremony"], row.id).toContain(a.confirm);
      if (a.risk === "external") expect(a.confirm, row.id).not.toBe("none");
    }
  });

  it.each(BILLING_PARITY.filter(ofKind("link")).map((r) => [r.id, r.replacedBy] as const))(
    "%s: links to a page or GET route that exists",
    (_id, l) => {
      if (l.href.startsWith("/api/")) {
        const source = routeSource(l.href);
        expect(source, `src/app${l.href}/route.ts`).not.toBeNull();
        expect(exportsMethod(source!, "GET"), `${l.href} exports GET`).toBe(true);
      } else {
        expect(pageExists(l.href), `a page at ${l.href}`).toBe(true);
      }
    }
  );
});

describe("parity with the contributed actions and views", () => {
  it.each(BILLING_PARITY.map((r) => [r.id, r] as const))("%s is contributed, or pending", (id, row) => {
    if (row.pr === "unscheduled") {
      expect(PENDING.has(id), `${id} is unscheduled: it stays pending until #201 schedules it`).toBe(true);
      return;
    }
    const by = row.replacedBy;
    if (by.kind === "copy") {
      // Never seen in a contribution: once it leaves PENDING, its view must exist.
      if (!PENDING.has(id)) {
        expect(contributedView(by.view), `${id}'s view ${by.view}`).toBe(true);
        expect(copiedByARenderer(by.view), `${id}: ${by.view} declares an ext that an installed GUI's renderer reads`).toBe(true);
      }
      return;
    }
    if (by.kind === "action" && contributedAction(by) && !submittable(contributedAction(by)!)) {
      expect(PENDING.has(id), `${id} is contributed, but no interface can submit it (no kit form, no GUI form): keep it in PENDING`).toBe(true);
      return;
    }
    if (!isContributed(row)) {
      expect(PENDING.has(id), `${id} is not contributed: contribute it, or list it in PENDING`).toBe(true);
      return;
    }
    expect(PENDING.has(id), `${id} is contributed: remove it from PENDING`).toBe(false);
    if (by.kind !== "action") return;
    const def = contributedAction(by)!;
    expect({ path: def.path, method: def.method, risk: def.risk, confirm: def.confirm, target: def.target }).toEqual({
      path: by.route,
      method: by.method,
      risk: by.risk,
      confirm: by.confirm,
      target: by.target,
    });
    if (by.form) expect(def.input, `${id}'s input is ${by.form}`).toBe((schemas as Record<string, unknown>)[by.form]);
  });

  it("does not count an action as contributed while no interface can submit it", () => {
    const generate = contributedAction({ ...BILLING_PARITY.find((r) => r.id === "generate-bills")!.replacedBy } as ParityAction);
    expect(generate, "billing.generate-bills is contributed").toBeDefined();
    // Its tenant arrays are arrays of strings, which the kit cannot render, and no GUI registers a form for it.
    expect(fieldsOf(personInput(generate!))).toBeNull();
    expect(submittable(generate!)).toBe(false);
    expect(isContributed(BILLING_PARITY.find((r) => r.id === "generate-bills")!)).toBe(false);
    // The same action with a flat input the kit renders could be submitted.
    const flat = { ...generate!, input: z.strictObject({ billingPeriodId: z.string() }) } as ActionDef;
    expect(submittable(flat)).toBe(true);
  });

  it("clears no action row that no interface can submit", () => {
    for (const row of BILLING_PARITY.filter(ofKind("action")).filter((r) => !PENDING.has(r.id))) {
      const def = contributedAction(row.replacedBy);
      expect(def && submittable(def), `${row.id} can be submitted`).toBe(true);
    }
  });

  it("does not count a link as contributed because its view exists", () => {
    // billing.savings is contributed and carries no billing period link.
    expect(contributedView("billing.savings")).toBe(true);
    expect(contributedLink({ kind: "link", view: "billing.savings", href: "/microgrids/[id]/billing/[periodId]", via: "row" })).toBe(false);
  });

  it.each(["back-to-period", "history-show-all"])(
    "does not count %s as contributed on any href but its own LinkRef's, such as the trail's or Latest changes'",
    (id) => {
      const row = BILLING_PARITY.find((r) => r.id === id)!;
      const link = row.replacedBy as ParityLink;
      const via = link.via as { link: string };
      expect(contributedLink(link)).toBe(true);
      // The view's examples with that one LinkRef taken out: the trail and the other links stay.
      const without = examplesOf(link.view).map((example) => {
        const m = example as { links: { id: string }[]; trail: unknown[] };
        return { ...m, links: m.links.filter((l) => l.id !== via.link) };
      });
      expect(without.some((m) => m.trail.length > 0)).toBe(true);
      expect(contributedLink(link, without)).toBe(false);
      // Its href is still in those examples, on the trail or another link: the old any-href match would have passed.
      const pattern = hrefPattern(link.href);
      const everyObject = without.flatMap((m) => [...objectsOf(m), ...objectsOf((m as { trail: unknown }).trail, "trail")]);
      expect(everyObject.some(({ o }) => typeof o.href === "string" && pattern.test(o.href))).toBe(true);
    },
  );

  it("does not count a link row that names nothing to carry it", () => {
    const row = BILLING_PARITY.find((r) => r.id === "back-to-period")!;
    expect(contributedLink({ ...(row.replacedBy as ParityLink), via: undefined })).toBe(false);
  });

  it("lists only rows of the table as pending", () => {
    const ids = new Set(BILLING_PARITY.map((r) => r.id));
    expect([...PENDING].filter((id) => !ids.has(id))).toEqual([]);
  });

  it("deletes the legacy billing screens only once nothing is pending", () => {
    const gone = LEGACY_SCREENS.filter((file) => !existsSync(path.join(ROOT, file)));
    if (gone.length > 0) expect([...PENDING], `deleted ${gone.join(", ")} with rows still pending`).toEqual([]);
  });
});

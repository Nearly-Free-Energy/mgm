/**
 * The billing parity table (src/lib/billing/parity.ts) against the code (#201).
 *
 * Every row names something real: its route with the method and body
 * schema, and its page (a page.tsx, or a catalog page a view serves) or GET
 * route. Every row is either contributed, matching the contribution, or
 * listed in PENDING below. The contributing pull requests of #201 removed
 * their rows from PENDING as they landed; the legacy billing screens could
 * be deleted only once PENDING was empty, and a screen's URL could move to
 * the GUI host (its page.tsx deleted, its catalog page served by a view)
 * only once no row of that screen was pending. #201's Deletes item deleted
 * them, so the last two tests now hold the deletion: the legacy components
 * stay deleted with nothing pending, and a row added as pending fails until
 * its screen's page is restored.
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
import * as paymentSchemas from "@/lib/payments/schemas";
import * as schemas from "../schemas";
import { BILLING_PLUGIN, MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { BILLING_PARITY, type ParityAction, type ParityLink, type ParityRow, type ParityScreen } from "../parity";

const ROOT = path.resolve(__dirname, "../../../..");
const APP = path.join(ROOT, "src/app");

/**
 * Rows not contributed yet. A pull request that contributes a row's action,
 * link, view or nav entry, or delivers its copy control, removes the row here
 * in the same change; the test fails if a contributed row is left behind,
 * and if a row is neither contributed nor listed.
 */
const PENDING = new Set<string>([
]);

/**
 * The legacy screens' components, which #201's Deletes item deleted once
 * nothing was pending, with the menus, panels and dialogs only they
 * rendered. Their page.tsx files went earlier: billing/page.tsx and
 * …/[periodId]/history/page.tsx with "Serve the billing pages through the
 * GUI host", …/[periodId]/page.tsx with "Serve period review through the
 * GUI host", each once no row of its screen was pending. Every file a row
 * names as `legacy` is here or in KEPT.
 */
const LEGACY_SCREENS = [
  "src/components/BillingTable.tsx",
  "src/components/BillingPeriodList.tsx",
  "src/components/CopyButton.tsx",
  "src/components/billing/audit-log-list.tsx",
  "src/components/billing/error-code-copy.ts",
  "src/components/billing/manual-usage-cell.tsx",
  "src/components/billing/multi-select-column.tsx",
  "src/components/billing/payment-link-popover.tsx",
  "src/components/billing/payment-notes-confirm-dialog.tsx",
  "src/components/billing/preflight-panel.tsx",
  "src/components/billing/regenerate-multi-dialog.tsx",
  "src/components/billing/regenerate-row-dialog.tsx",
  "src/components/billing/row-actions-menu.tsx",
  "src/components/billing/row-banner-stack.tsx",
  "src/components/billing/sticky-selection-bar.tsx",
  "src/components/payments/payment-history.tsx",
  "src/components/ui/close-period-dialog.tsx",
  "src/components/ui/copy-table.tsx",
  "src/components/ui/period-picker.tsx",
  "src/lib/billing/audit-humanize.tsx",
];

/**
 * Files a row names as `legacy` that stay on purpose, and why. The
 * microgrid's tabs are not a billing screen: Setup still renders them, and
 * their Billing tab now opens billing.periods (billing-tab). If Setup stops
 * rendering them, revisit.
 */
const KEPT: Record<string, string> = {
  "src/app/(gui)/microgrids/[id]/tab-nav.tsx": "the microgrid's tabs, which Setup still renders",
};

/**
 * The catalog page (src/lib/plugins/bundled.ts) that serves each legacy
 * screen's URL. A screen's URL moves to the GUI host only once no row of
 * that screen is pending, so a person loses no control on the way; the last
 * test of this file enforces it. All three have moved, so a row of any
 * screen added as pending fails that test until its page is restored. If a
 * screen comes to be served at another URL, revisit.
 */
const SCREEN_PAGES: Record<ParityScreen, string> = {
  periods: "/microgrids/[id]/billing",
  "period-review": "/microgrids/[id]/billing/[periodId]",
  "period-history": "/microgrids/[id]/billing/[periodId]/history",
};

const SURFACES: Record<ParityAction["plugin"], Contribution> = {
  billing: BILLING_SURFACE,
  payments: PAYMENTS_SURFACE,
};
/** Each plugin's schemas module, which its routes parse with. */
const SCHEMAS: Record<ParityAction["plugin"], Record<string, unknown>> = {
  billing: schemas,
  payments: paymentSchemas,
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

/**
 * A catalog page the GUI host's catch-all serves by a view (`servedBy:
 * "view"`), which has no page.tsx of its own. If the host comes to serve a
 * page some other way, revisit.
 */
const servedByView = (href: string) =>
  MGM_BUNDLED_PLUGINS.some((p) => p.pages.some((page) => page.path === href && page.servedBy === "view"));

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
  it("gives every row a unique id, and names as legacy only a deleted screen's component or a file kept on purpose", () => {
    const ids = BILLING_PARITY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of BILLING_PARITY) {
      for (const file of row.legacy.split(", ")) {
        expect(LEGACY_SCREENS.includes(file) || Object.hasOwn(KEPT, file), `${row.id}: ${file} is in LEGACY_SCREENS or KEPT`).toBe(true);
      }
    }
    for (const file of Object.keys(KEPT)) expect(existsSync(path.join(ROOT, file)), `${file} is kept`).toBe(true);
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
        expect(Object.hasOwn(SCHEMAS[a.plugin], a.form), `${a.form} is exported from src/lib/${a.plugin}/schemas.ts`).toBe(true);
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
        expect(pageExists(l.href) || servedByView(l.href), `a page at ${l.href}`).toBe(true);
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
    if (by.form) expect(def.input, `${id}'s input is ${by.form}`).toBe(SCHEMAS[by.plugin][by.form]);
  });

  it("does not count an action as contributed while no interface can submit it", () => {
    // generate-bills is replaced by an action whose input has no field to
    // fill, which the kit submits as a confirmation alone.
    const fromMeters = contributedAction(BILLING_PARITY.find((r) => r.id === "generate-bills")!.replacedBy as ParityAction);
    expect(fromMeters?.id).toBe("billing.generate-from-meters");
    expect(fieldsOf(personInput(fromMeters!))).toEqual([]);
    expect(submittable(fromMeters!)).toBe(true);
    // The same action with GenerateBillsBody, the retired billing.generate-bills'
    // input: its tenant arrays are arrays of strings, which the kit cannot
    // render, and no GUI registers a form for it.
    const fullBody = { ...fromMeters!, id: "billing.generate-bills", input: schemas.GenerateBillsBody, bind: { body: { billingPeriodId: "billingPeriod" } } } as ActionDef;
    expect(fieldsOf(personInput(fullBody))).toBeNull();
    expect(submittable(fullBody)).toBe(false);
    // A flat input the kit renders could be submitted.
    const flat = { ...fullBody, input: z.strictObject({ billingPeriodId: z.string() }) } as ActionDef;
    expect(submittable(flat)).toBe(true);
  });

  it("lets a person type bill-from-readings' readings in the kit's form, and offers it on the tenants not billed", () => {
    const row = BILLING_PARITY.find((r) => r.id === "bill-from-readings")!;
    const def = contributedAction(row.replacedBy as ParityAction)!;
    expect(def.id).toBe("billing.bill-from-readings");
    // The period and the tenant are bound from the path; the person types the rest.
    expect(fieldsOf(personInput(def))?.map((f) => f.key)).toEqual(["start_kwh", "end_kwh", "reason"]);
    expect(submittable(def)).toBe(true);
    // An example of the section carries it on a row, bound to that row's tenant.
    const rows = examplesOf("billing.not-billed").flatMap((m) => (m as { body: { rows: { id: string; actions: { action: string; params: Record<string, string> }[] }[] } }).body.rows);
    const offered = rows.filter((r) => r.actions.some((a) => a.action === def.id));
    expect(offered.length).toBeGreaterThan(0);
    for (const r of offered) expect(r.actions.find((a) => a.action === def.id)!.params.tenantId).toBe(r.id);
  });

  it("no longer contributes the full-body billing.generate-bills", () => {
    expect(BILLING_SURFACE.actions?.some((a) => a.id === "billing.generate-bills")).toBe(false);
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

  it("keeps payments-while-off replaced only while the tab and the exempt actions are declared available while Payments is off", () => {
    // A view row counts as contributed once the view exists, so this is what
    // shows the decision was carried out (parity.ts, payments-while-off).
    const row = BILLING_PARITY.find((r) => r.id === "payments-while-off")!;
    expect(row.replacedBy).toEqual({ kind: "view", view: "payments.bill-attempts" });
    const view = PAYMENTS_SURFACE.views!.find((v) => v.id === "payments.bill-attempts")!;
    expect(view.attach?.whilePluginOff, "payments.bill-attempts is listed while Payments is off").toBe("listed");
    const kept = ["refresh-attempt", "record-adjustment", "accept-receipts"].map((id) => {
      const by = BILLING_PARITY.find((r) => r.id === id)!.replacedBy as ParityAction;
      return [by.action, contributedAction(by)?.whilePluginOff];
    });
    expect(kept).toEqual([
      ["payments.refresh-attempt", "enabled"],
      ["payments.record-adjustment", "enabled"],
      ["payments.accept-receipts", "enabled"],
    ]);
  });

  it("lists only rows of the table as pending", () => {
    const ids = new Set(BILLING_PARITY.map((r) => r.id));
    expect([...PENDING].filter((id) => !ids.has(id))).toEqual([]);
  });

  it("has deleted the legacy billing screens, with nothing pending", () => {
    expect([...PENDING], "the legacy screens are deleted: a pending row has no control left to fall back on").toEqual([]);
    const left = LEGACY_SCREENS.filter((file) => existsSync(path.join(ROOT, file)));
    expect(left, "the legacy billing screens stay deleted").toEqual([]);
  });

  it("keeps a screen's URL on its legacy page while a row of that screen is pending", () => {
    for (const row of BILLING_PARITY.filter((r) => PENDING.has(r.id))) {
      const pagePath = SCREEN_PAGES[row.screen];
      const page = BILLING_PLUGIN.pages.find((p) => p.path === pagePath);
      expect(page, `${pagePath} is a billing catalog page`).toBeDefined();
      expect(page!.servedBy, `${row.id} is pending: ${pagePath} stays a page.tsx, not a view`).toBeUndefined();
      expect(pageExists(pagePath), `${row.id} is pending: a page at ${pagePath}`).toBe(true);
    }
  });
});

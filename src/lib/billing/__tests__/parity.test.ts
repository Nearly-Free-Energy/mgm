/**
 * The billing parity table (src/lib/billing/parity.ts) against the code (#201).
 *
 * Every row names something real: its legacy component, its route with the
 * method and body schema, or its page. Every row is either contributed,
 * matching the contribution exactly, or listed in PENDING below. The
 * contributing pull requests of #201 remove their rows from PENDING as they
 * land; the legacy billing screens may be deleted only once PENDING is
 * empty, which the last test enforces.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionDef, Contribution } from "@/lib/gui/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import { BILLING_SURFACE } from "../surface";
import * as schemas from "../schemas";
import { BILLING_PARITY, type ParityAction, type ParityLink, type ParityRow } from "../parity";

const ROOT = path.resolve(__dirname, "../../../..");
const APP = path.join(ROOT, "src/app");

/**
 * Rows not contributed yet. A pull request that contributes a row's action
 * or view removes the row here in the same change; the test fails if it is
 * left behind, and if a row is neither contributed nor listed.
 */
const PENDING = new Set<string>([
  // Contribute billing periods and period creation as a view
  "create-period",
  "open-period",
  "delete-period",
  // Contribute period review, with targeted actions for each bill
  "generate-bills",
  "regenerate-bill",
  "record-usage",
  "mark-paid",
  "mark-unpaid",
  "mark-refunded",
  "mark-failed",
  "cancel-payment-link",
  "download-bill",
  "export-csv",
  "view-history",
  "view-tenant",
  "payment-setup",
  // Contribute the close checklist on …/close
  "close-period",
  // Contribute the send queue on …/send
  "payment-link",
  // Contribute a period's history
  "back-to-period",
  "history-show-all",
  // Unscheduled in #201: payments' attempt history and reconciliation.
  "payment-history",
  "refresh-attempt",
  "record-adjustment",
  "accept-receipts",
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

const actions = (r: ParityRow): r is ParityRow & { replacedBy: ParityAction } => r.replacedBy.kind === "action";
const links = (r: ParityRow): r is ParityRow & { replacedBy: ParityLink } => r.replacedBy.kind === "link";

function routeSource(route: string): string | null {
  const file = path.join(APP, route, "route.ts");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
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

function contributedView(id: string): boolean {
  return Object.values(SURFACES).some((s) => s.views?.some((v) => v.id === id));
}

const isContributed = (r: ParityRow) =>
  r.replacedBy.kind === "action" ? contributedAction(r.replacedBy) !== undefined : contributedView(r.replacedBy.view);

describe("the billing parity table", () => {
  it("gives every row a unique id and a legacy component that exists", () => {
    const ids = BILLING_PARITY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of BILLING_PARITY) {
      for (const file of row.legacy.split(", ")) {
        expect(existsSync(path.join(ROOT, file)), `${row.id}: ${file}`).toBe(true);
      }
    }
  });

  it.each(BILLING_PARITY.filter(actions).map((r) => [r.id, r.replacedBy] as const))(
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

  it("gives a DELETE row typed or ceremony confirmation, as a contribution needs", () => {
    for (const row of BILLING_PARITY.filter(actions)) {
      if (row.replacedBy.method === "DELETE") expect(["typed", "ceremony"], row.id).toContain(row.replacedBy.confirm);
    }
  });

  it.each(BILLING_PARITY.filter(links).map((r) => [r.id, r.replacedBy] as const))(
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
    if (!isContributed(row)) {
      expect(PENDING.has(id), `${id} is not contributed: contribute it, or list it in PENDING`).toBe(true);
      return;
    }
    expect(PENDING.has(id), `${id} is contributed: remove it from PENDING`).toBe(false);
    if (row.replacedBy.kind !== "action") return;
    const a = row.replacedBy;
    const def = contributedAction(a)!;
    expect({ path: def.path, method: def.method, confirm: def.confirm, target: def.target }).toEqual({
      path: a.route,
      method: a.method,
      confirm: a.confirm,
      target: a.target,
    });
    if (a.form) expect(def.input, `${id}'s input is ${a.form}`).toBe((schemas as Record<string, unknown>)[a.form]);
  });

  it("lists only rows of the table as pending", () => {
    const ids = new Set(BILLING_PARITY.map((r) => r.id));
    expect([...PENDING].filter((id) => !ids.has(id))).toEqual([]);
  });

  it("keeps every unscheduled row pending, so it gets a decision before the deletes", () => {
    for (const row of BILLING_PARITY.filter((r) => r.pr === "unscheduled")) {
      expect(isContributed(row) || PENDING.has(row.id), row.id).toBe(true);
    }
  });

  it("deletes the legacy billing screens only once nothing is pending", () => {
    const gone = LEGACY_SCREENS.filter((file) => !existsSync(path.join(ROOT, file)));
    if (gone.length > 0) expect([...PENDING], `deleted ${gone.join(", ")} with rows still pending`).toEqual([]);
  });
});

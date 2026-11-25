/**
 * The twice-sent test's harness (../repeat.db.test.ts): what a case is, how
 * it is sent to its route, and the snapshot that shows whether a send wrote.
 *
 * Each plugin with "safe" actions has a case module beside this file
 * (./billing.ts, ./payments.ts). A module seeds its own organization under
 * its own UUID prefix, names the route handlers its cases are sent to, and
 * lists one or more cases for each of its "safe" actions. A plugin that
 * contributes its first "safe" action adds a module, and the test lists it.
 */
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Id } from "@/lib/gui/contract";
import type { ActionDef } from "@/lib/gui/surface";
import type { MgmRuntime } from "@/lib/runtime/root";
import { serviceClient, type TestUser } from "@/lib/supabase/__tests__/rls.helpers";

/**
 * A route handler as Next.js calls it. Its params are typed `never` so that
 * every route's own params type fits; send() passes the case's params, which
 * the cases test checks against the action's bind.path.
 */
export type Handler = (request: NextRequest, context: { params: Promise<never> }) => Promise<Response>;

/** Who sends a case: the person the action is offered to. */
export type Caller = "manager" | "superAdmin";

export interface Case {
  /** Names the case when an action has several. */
  label?: string;
  as: Caller;
  /** The action's path segments, named as its bind.path names them. */
  params: Readonly<Record<string, string>>;
  /** The body, built once just before the first send and sent unchanged both times. */
  body: (caller: TestUser) => unknown;
  /** The status the first send answers; it must also change the snapshot. */
  first: number;
  /** The status the second, identical send answers; it must leave the snapshot as the first left it. */
  second: number;
  /**
   * Columns, as "table.column", that this case's second send may rewrite
   * with a new value of the same meaning, each with why that is not a
   * change. Removed from both snapshots before they are compared. Each must
   * name a column the snapshot reads, or the case fails.
   */
  ignore?: Readonly<Record<string, string>>;
}

export interface Fixture {
  /** The organization whose rows the snapshot reads. */
  orgId: string;
  /** The people the module's cases are sent as. */
  users: Readonly<Partial<Record<Caller, TestUser>>>;
}

export interface CaseModule {
  /** Each handler a case is sent to, keyed "METHOD /api/route" as the action names it. */
  handlers: Readonly<Record<string, Handler>>;
  /** The cases of each "safe" action of the module's plugin. */
  cases: Readonly<Partial<Record<Id, readonly Case[]>>>;
  /** Removes what seed wrote, and what an earlier run left; safe to call twice. */
  cleanup(runtime: MgmRuntime): Promise<void>;
  seed(runtime: MgmRuntime): Promise<Fixture>;
}

export const routeKey = (def: Pick<ActionDef, "method" | "path">) => `${def.method} ${def.path}`;

/** The action's path with its segments filled. */
export function fillPath(path: string, params: Readonly<Record<string, string>>): string {
  return path.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`[repeat] no value for [${name}] in ${path}`);
    return encodeURIComponent(value);
  });
}

/** Sends `body` to the action's route as Next.js would route it, and reads the answer. */
export async function send(
  handler: Handler,
  def: Pick<ActionDef, "method" | "path">,
  params: Readonly<Record<string, string>>,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const res = await handler(
    new NextRequest(`http://localhost${fillPath(def.path, params)}`, {
      method: def.method,
      headers: { "content-type": "application/json", "accept-language": "en" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ ...params }) as Promise<never> },
  );
  return { status: res.status, text: await res.text() };
}

type Row = Record<string, unknown>;
/** Full rows of each table, sorted by primary key. */
export type Snapshot = Record<string, Row[]>;

/** Each table the snapshot reads, with its primary key. */
const KEYS: Readonly<Record<string, readonly string[]>> = {
  billing_periods: ["id"],
  rate_schedules: ["id"],
  grid_tariffs: ["id"],
  microgrid_savings_settings: ["microgrid_id"],
  billing_line_items: ["id"],
  billing_audit_log: ["id"],
  payment_events: ["id"],
  payment_attempts: ["id"],
  payment_receipts: ["id"],
  payment_notifications: ["id"],
};

async function rows(
  svc: SupabaseClient,
  table: string,
  where: [column: string, values: readonly string[]][],
): Promise<Row[]> {
  const found = new Map<string, Row>();
  for (const [column, values] of where) {
    if (values.length === 0) continue;
    const { data, error } = await svc.from(table).select("*").in(column, [...values]);
    if (error) throw new Error(`[repeat] ${table}: ${error.message}`);
    for (const row of (data ?? []) as Row[]) found.set(JSON.stringify(KEYS[table].map((k) => row[k])), row);
  }
  return [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

/**
 * Every row of the organization's in each table a billing or payments write
 * route reaches, read with the service role. A new "safe" action whose route
 * writes another table adds that table here, or the test cannot see its
 * writes.
 */
export async function snapshot(orgId: string): Promise<Snapshot> {
  const svc = await serviceClient();
  const ids = (list: Row[], column = "id") => list.map((r) => String(r[column]));
  const communities = await svc.from("communities").select("id").eq("org_id", orgId);
  if (communities.error) throw new Error(`[repeat] communities: ${communities.error.message}`);
  const microgrids = await svc.from("microgrids").select("id").in("community_id", ids(communities.data ?? []));
  if (microgrids.error) throw new Error(`[repeat] microgrids: ${microgrids.error.message}`);
  const mg = ids(microgrids.data ?? []);
  const out: Snapshot = {};
  for (const table of ["billing_periods", "rate_schedules", "grid_tariffs", "microgrid_savings_settings"]) {
    out[table] = await rows(svc, table, [["microgrid_id", mg]]);
  }
  const periods = ids(out.billing_periods);
  out.billing_line_items = await rows(svc, "billing_line_items", [["billing_period_id", periods]]);
  out.billing_audit_log = await rows(svc, "billing_audit_log", [["billing_period_id", periods], ["org_id", [orgId]]]);
  out.payment_events = await rows(svc, "payment_events", [["line_item_id", ids(out.billing_line_items)]]);
  for (const table of ["payment_attempts", "payment_receipts", "payment_notifications"]) {
    out[table] = await rows(svc, table, [["org_id", [orgId]]]);
  }
  return out;
}

/** The snapshot without the listed "table.column"s. */
export function without(s: Snapshot, ignore: Readonly<Record<string, string>> = {}): Snapshot {
  const drop = Object.keys(ignore).map((tc) => tc.split(".") as [string, string]);
  return Object.fromEntries(
    Object.entries(s).map(([table, list]) => {
      const columns = drop.filter(([t]) => t === table).map(([, c]) => c);
      return [table, columns.length ? list.map((row) => Object.fromEntries(Object.entries(row).filter(([c]) => !columns.includes(c)))) : list];
    }),
  );
}

/** The listed "table.column"s that no row of the snapshot has. */
export function absentColumns(s: Snapshot, ignore: Readonly<Record<string, string>> = {}): string[] {
  return Object.keys(ignore).filter((tc) => {
    const [table, column] = tc.split(".");
    return !(s[table] ?? []).some((row) => Object.hasOwn(row, column));
  });
}

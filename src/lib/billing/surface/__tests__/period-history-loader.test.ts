/**
 * The `billing.period-history` loader: reads through the person's own
 * client, never raw_payload; the tenant filter read on the period's
 * microgrid; the keyset reads after a cursor; the page's actors' names;
 * refusals with fixed copy; and no capability composed, so the view still
 * loads while billing is off.
 *
 * The client here is local: it records every call and applies eq, lt, lte,
 * order and limit to in-memory rows as PostgREST would, so the paging can
 * be followed from page to page.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";

const composeBilling = vi.fn();
vi.mock("@/lib/billing/compose", () => ({ composeBilling: (...args: unknown[]) => composeBilling(...args) }));

import { loadPeriodHistory, PERIOD_HISTORY_REFUSALS } from "../period-history";
import { encodeCursor, instantKey, parseCursor, PERIOD_HISTORY_PAGE } from "../period-history-model";

const ORG = "e7c00000-0000-4000-8000-000000000001";
const MG = "e7c00000-0000-4000-8000-0000000000a1";
const PERIOD = "e7c00000-0000-4000-8000-0000000000b1";
const T1 = "e7c00000-0000-4000-8000-0000000000c1";
const BILL_1 = "e7c00000-0000-4000-8000-0000000000d1";
const USER_1 = "e7c00000-0000-4000-8000-0000000000f1";
const HIDDEN = "e7c00000-0000-4000-8000-0000000000f2";
const SECRET = "permission denied for table billing_audit_log";
const uuid = (n: number) => `e7c00000-0000-4000-8001-${n.toString(16).padStart(12, "0")}`;

type Rows = Record<string, unknown>[];
type Result = { data: unknown; error: unknown };
let tables: Record<string, Rows>;
let failing: Set<string>;
let rpcResult: Result;
let reads: unknown[][];

/** A field of a row, by a dotted path through embedded rows. */
const field = (row: Record<string, unknown>, column: string): unknown =>
  column.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (Array.isArray(v) ? v[0] : v)[k as keyof typeof v] : undefined), row);
const isTime = (v: unknown) => typeof v === "string" && instantKey(v) !== "";
const cmp = (a: unknown, b: unknown) => {
  const [x, y] = isTime(a) && isTime(b) ? [instantKey(a as string), instantKey(b as string)] : [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

function client(): SupabaseClient {
  return {
    from(table: string) {
      reads.push(["from", table]);
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const orders: [string, boolean][] = [];
      let limit: number | null = null;
      const answer = (): Promise<Result> => {
        if (failing.has(table)) return Promise.resolve({ data: null, error: { message: SECRET, code: "42501" } });
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (orders.length) {
          rows = [...rows].sort((a, b) => {
            for (const [col, asc] of orders) {
              const c = cmp(field(a, col), field(b, col));
              if (c) return asc ? c : -c;
            }
            return 0;
          });
        }
        return Promise.resolve({ data: limit === null ? rows : rows.slice(0, limit), error: null });
      };
      const chain: Record<string, unknown> = {
        select: (columns: string) => (reads.push(["select", table, columns]), chain),
        eq: (c: string, v: string) => (reads.push(["eq", table, c, v]), filters.push((r) => cmp(field(r, c), v) === 0), chain),
        lt: (c: string, v: string) => (reads.push(["lt", table, c, v]), filters.push((r) => cmp(field(r, c), v) < 0), chain),
        lte: (c: string, v: string) => (reads.push(["lte", table, c, v]), filters.push((r) => cmp(field(r, c), v) <= 0), chain),
        order: (c: string, o: { ascending: boolean }) => (reads.push(["order", table, c, o.ascending]), orders.push([c, o.ascending]), chain),
        limit: (n: number) => (reads.push(["limit", table, n]), (limit = n), chain),
        maybeSingle: () => answer().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => answer().then(ok, no),
      };
      return chain;
    },
    rpc(name: string, args: unknown) {
      reads.push(["rpc", name, args]);
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
}

const request = (search: Record<string, string> = {}, params: Record<string, string> = { id: MG, periodId: PERIOD }): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles: [managerOf(ORG)],
  organizationId: ORG,
  params,
  search: new URLSearchParams(search),
  locale: "en-GB",
  now: new Date("2026-11-18T08:00:00Z"),
  fmt: createFmt({ locale: "en-GB" }),
});

const audit = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  billing_period_id: PERIOD,
  billing_line_item_id: BILL_1,
  event_type: "line_item_generated",
  actor_user_id: USER_1,
  created_at: "2026-10-31T21:00:00+00:00",
  details: { tenant_name: "Snapshot name", new_total_amount: 1000 },
  billing_line_items: { tenants: { display_name: "Unit 1" } },
  ...o,
});
const payment = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  line_item_id: BILL_1,
  from_status: "unpaid",
  to_status: "paid",
  source: "manual",
  actor_user_id: USER_1,
  at: "2026-11-02T10:00:00+00:00",
  raw_payload: { marker: "RAW-PAYLOAD-CANARY" },
  billing_line_items: { billing_period_id: PERIOD, payment_notes: "Cash", tenants: { display_name: "Unit 1" } },
  ...o,
});

beforeEach(() => {
  composeBilling.mockReset();
  reads = [];
  failing = new Set();
  rpcResult = { data: [{ user_id: USER_1, first_name: "Okello", last_name: "Daniel", email: "okello@example.test" }], error: null };
  tables = {
    billing_periods: [{ id: PERIOD, microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", rate_schedule_id: null }],
    microgrids: [{ id: MG, currency: "UGX" }],
    tenants: [{ id: T1, microgrid_id: MG, display_name: "Unit 1" }],
    billing_line_items: [{ id: BILL_1, billing_period_id: PERIOD, tenant_id: T1 }],
    billing_audit_log: [
      audit(uuid(1), { event_type: "period_created", billing_line_item_id: null, actor_user_id: null, details: {}, billing_line_items: null, created_at: "2026-10-01T06:00:00+00:00" }),
      audit(uuid(2)),
      // The bill was deleted: the snapshot names the tenant.
      audit(uuid(3), { billing_line_item_id: null, billing_line_items: null, details: { tenant_name: "Gone unit" } }),
      audit(uuid(4), { event_type: "period_closed", billing_line_item_id: null, billing_line_items: null, actor_user_id: HIDDEN, created_at: "2026-11-05T16:00:00+00:00" }),
    ],
    payment_events: [payment(uuid(10)), payment(uuid(11), { source: "generate_link", actor_user_id: null, at: "2026-11-01T09:00:00+00:00" })],
  };
});

const ok = async (req: SurfaceRequest) => {
  const res = await loadPeriodHistory(req);
  if (!res.ok) throw new Error(`refused: ${res.message}`);
  return res.model;
};
const selectsOf = (table: string) => reads.filter((r) => r[0] === "select" && r[1] === table).map((r) => r[2] as string);
const callsOf = (op: string, table: string) => reads.filter((r) => r[0] === op && r[1] === table).map((r) => r.slice(2));

describe("loadPeriodHistory: reads", () => {
  it("reads through the person's own client, composes nothing, and never selects raw_payload", async () => {
    const model = await ok(request());
    expect(composeBilling).not.toHaveBeenCalled();
    expect(selectsOf("payment_events").every((s) => !s.includes("raw_payload"))).toBe(true);
    expect(selectsOf("microgrids")).toEqual(["id, currency"]);
    expect(selectsOf("billing_audit_log")[0]).toContain("billing_line_items!billing_audit_log_billing_line_item_id_fkey(tenants(display_name))");
    expect(selectsOf("payment_events")[0]).toContain("billing_line_items!inner(billing_period_id, payment_notes, tenants(display_name))");
    expect(callsOf("eq", "billing_periods")).toEqual([
      ["id", PERIOD],
      ["microgrid_id", MG],
    ]);
    expect(callsOf("eq", "payment_events")).toContainEqual(["billing_line_items.billing_period_id", PERIOD]);
    expect(callsOf("eq", "billing_audit_log")).toContainEqual(["billing_period_id", PERIOD]);
    expect(JSON.stringify(model)).not.toContain("RAW-PAYLOAD-CANARY");
  });

  it("merges both sources newest first and names tenants live, then from the snapshot", async () => {
    const model = await ok(request());
    expect(model.body.rows.map((r) => r.id)).toEqual([
      `audit:${uuid(4)}`,
      `payment_event:${uuid(10)}`,
      `payment_event:${uuid(11)}`,
      `audit:${uuid(3)}`,
      `audit:${uuid(2)}`,
      `audit:${uuid(1)}`,
    ]);
    const change = model.body.rows.map((r) => r.cells.change.text);
    expect(change).toEqual([
      "Period closed",
      "Payment status for Unit 1",
      "Payment link generated for Unit 1",
      "Bill generated for Gone unit",
      "Bill generated for Unit 1",
      "Period created",
    ]);
    expect(model.body.rows[1].cells.note.text).toBe("Cash");
    expect(model.body.rows[0].cells.at).toMatchObject({ t: "datetime", tz: "Africa/Kampala" });
  });

  it("shows times in the period's time zone and money in the microgrid's currency", async () => {
    tables.billing_periods[0].timezone = "Africa/Nairobi";
    tables.microgrids[0].currency = "KES";
    const model = await ok(request());
    expect(new Set(model.body.rows.map((r) => (r.cells.at.t === "datetime" ? r.cells.at.tz : r.cells.at.t)))).toEqual(new Set(["Africa/Nairobi"]));
    const generated = model.body.rows.find((r) => r.cells.change.text === "Bill generated for Unit 1")!;
    expect(generated.cells.detail.text).toMatch(/^Total: KES/);
  });

  it("loads a period with no pinned tariff", async () => {
    expect((await loadPeriodHistory(request())).ok).toBe(true);
    expect(reads.some((r) => r[1] === "rate_schedules")).toBe(false);
  });

  it("reads at most a page and one from each source", async () => {
    await ok(request());
    expect(callsOf("limit", "billing_audit_log")).toEqual([[PERIOD_HISTORY_PAGE + 1]]);
    expect(callsOf("limit", "payment_events")).toEqual([[PERIOD_HISTORY_PAGE + 1]]);
    expect(callsOf("order", "billing_audit_log")).toEqual([
      ["created_at", false],
      ["id", false],
    ]);
    expect(callsOf("order", "payment_events")).toEqual([
      ["at", false],
      ["id", false],
    ]);
  });
});

describe("loadPeriodHistory: refusals", () => {
  it.each(["billing_periods", "microgrids", "billing_audit_log", "payment_events", "tenants", "billing_line_items"])(
    "refuses with fixed copy when %s cannot be read",
    async (table) => {
      failing.add(table);
      const res = await loadPeriodHistory(request({ tenant_id: T1 }));
      expect(res).toEqual(PERIOD_HISTORY_REFUSALS.unavailable);
      expect(JSON.stringify(res)).not.toContain(SECRET);
    },
  );

  it("refuses with fixed copy when the actors cannot be named, rather than calling them Restricted", async () => {
    rpcResult = { data: null, error: { message: SECRET } };
    const res = await loadPeriodHistory(request());
    expect(res).toEqual(PERIOD_HISTORY_REFUSALS.unavailable);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("finds no missing period or microgrid", async () => {
    tables.billing_periods = [];
    expect(await loadPeriodHistory(request())).toEqual(PERIOD_HISTORY_REFUSALS.notFound);
    tables.billing_periods = [{ id: PERIOD, microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "UTC" }];
    tables.microgrids = [];
    expect(await loadPeriodHistory(request())).toEqual(PERIOD_HISTORY_REFUSALS.notFound);
  });

  it("finds no period under another microgrid", async () => {
    const other = "e7c00000-0000-4000-8000-0000000000a2";
    tables.microgrids.push({ id: other, currency: "UGX" });
    expect(await loadPeriodHistory(request({}, { id: other, periodId: PERIOD }))).toEqual(PERIOD_HISTORY_REFUSALS.notFound);
    expect(callsOf("eq", "billing_periods")).toContainEqual(["microgrid_id", other]);
  });
});

describe("loadPeriodHistory: the tenant filter", () => {
  it("reads the tenant on the period's microgrid and its bill, then filters both sources to that bill", async () => {
    const model = await ok(request({ tenant_id: T1.toUpperCase() }));
    expect(callsOf("eq", "tenants")).toEqual([
      ["id", T1],
      ["microgrid_id", MG],
    ]);
    expect(callsOf("eq", "billing_line_items")).toEqual([
      ["billing_period_id", PERIOD],
      ["tenant_id", T1],
    ]);
    expect(callsOf("eq", "billing_audit_log")).toContainEqual(["billing_line_item_id", BILL_1]);
    expect(callsOf("eq", "payment_events")).toContainEqual(["line_item_id", BILL_1]);
    expect(model.subtitle).toMatch(/Showing changes for Unit 1$/);
    expect(model.body.rows.map((r) => r.id)).toEqual([`payment_event:${uuid(10)}`, `payment_event:${uuid(11)}`, `audit:${uuid(2)}`]);
    expect(model.links!.map((l) => l.id)).toEqual(["billing.back-to-period", "billing.history-show-all"]);
  });

  it("shows nothing, with the name, for a tenant with no bill on the period", async () => {
    tables.billing_line_items = [];
    const model = await ok(request({ tenant_id: T1 }));
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty.title).toBe("No changes recorded for Unit 1");
    expect(reads.some((r) => r[1] === "billing_audit_log" || r[1] === "payment_events")).toBe(false);
  });

  it("names no tenant of another microgrid, and reads no entries for it", async () => {
    const elsewhere = "e7c00000-0000-4000-8000-0000000000c9";
    tables.tenants.push({ id: elsewhere, microgrid_id: "e7c00000-0000-4000-8000-0000000000a9", display_name: "Unit 9" });
    tables.billing_line_items.push({ id: uuid(99), billing_period_id: PERIOD, tenant_id: elsewhere });
    const model = await ok(request({ tenant_id: elsewhere }));
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty.title).toBe("No changes recorded for unknown tenant");
    expect(JSON.stringify(model)).not.toContain("Unit 9");
    expect(reads.some((r) => r[1] === "billing_audit_log" || r[1] === "payment_events")).toBe(false);
  });

  it("sends a tenant id that is not a UUID to no query, and echoes it nowhere", async () => {
    const model = await ok(request({ tenant_id: "x'); drop" }));
    expect(JSON.stringify(reads)).not.toContain("drop");
    expect(JSON.stringify(model)).not.toContain("drop");
    expect(model.body.rows).toEqual([]);
    expect(model.subtitle).toMatch(/Showing changes for unknown tenant$/);
  });

  it("answers a tenant id that is not a UUID, with a valid cursor, as its first page: Show all, and no Latest changes to the same place", async () => {
    const before = encodeCursor({ source: "a", id: uuid(3), at: "2026-10-31T21:00:00+00:00" });
    const model = await ok(request({ tenant_id: "not-a-uuid", before }));
    expect(model.links!.map((l) => [l.id, l.href])).toEqual([
      ["billing.back-to-period", `/microgrids/${MG}/billing/${PERIOD}`],
      ["billing.history-show-all", `/microgrids/${MG}/billing/${PERIOD}/history`],
    ]);
    expect(model.body.empty.title).toBe("No changes recorded for unknown tenant");
    expect(JSON.stringify(model)).not.toContain("not-a-uuid");
  });

  it("says a filtered later page with nothing left has no earlier changes", async () => {
    // Every entry of tenant 1's bill is newer than this cursor.
    const before = encodeCursor({ source: "a", id: uuid(1), at: "2026-01-01T00:00:00+00:00" });
    const model = await ok(request({ tenant_id: T1, before }));
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty).toEqual({ title: "No earlier changes recorded for Unit 1" });
    expect(model.links!.find((l) => l.id === "billing.history-latest")!.href).toBe(`/microgrids/${MG}/billing/${PERIOD}/history?tenant_id=${T1}`);
  });
});

describe("loadPeriodHistory: the cursor", () => {
  const at = "2026-10-31T21:00:00+00:00";

  it("after an audit entry, reads its instant's lower ids and earlier audit entries, and payments at or before it", async () => {
    await ok(request({ before: encodeCursor({ source: "a", id: uuid(3), at }) }));
    expect(callsOf("eq", "billing_audit_log")).toEqual([
      ["billing_period_id", PERIOD],
      ["created_at", at],
      ["billing_period_id", PERIOD],
    ]);
    expect(callsOf("lt", "billing_audit_log")).toEqual([
      ["id", uuid(3)],
      ["created_at", at],
    ]);
    expect(callsOf("lte", "payment_events")).toEqual([["at", at]]);
    expect(callsOf("lt", "payment_events")).toEqual([]);
    for (const t of ["billing_audit_log", "payment_events"]) for (const l of callsOf("limit", t)) expect(l).toEqual([PERIOD_HISTORY_PAGE + 1]);
  });

  it("after a payment event, the mirror image", async () => {
    await ok(request({ before: encodeCursor({ source: "p", id: uuid(10), at }) }));
    expect(callsOf("lt", "billing_audit_log")).toEqual([["created_at", at]]);
    expect(callsOf("lte", "billing_audit_log")).toEqual([]);
    expect(callsOf("eq", "payment_events")).toContainEqual(["at", at]);
    expect(callsOf("lt", "payment_events")).toEqual([
      ["id", uuid(10)],
      ["at", at],
    ]);
  });

  it("reads a malformed cursor as the first page, and offers no Latest changes", async () => {
    const model = await ok(request({ before: "a~nope~yesterday" }));
    expect(reads.some((r) => r[0] === "lt" || r[0] === "lte")).toBe(false);
    expect(model.links!.map((l) => l.id)).toEqual(["billing.back-to-period"]);
  });

  it("pages through a long history with ties, every entry once, with next only while more remain", async () => {
    // 450 audit entries over three instants and 30 payment events on two of them.
    const instants = ["2026-10-31T21:00:00.5+00:00", "2026-10-31T20:00:00+00:00", "2026-10-31T19:00:00.000001+00:00"];
    tables.billing_audit_log = Array.from({ length: 450 }, (_, n) => audit(uuid(0x1000 + n), { created_at: instants[n % 3] }));
    tables.payment_events = Array.from({ length: 30 }, (_, n) => payment(uuid(0x2000 + n), { at: instants[n % 2] }));
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const model = await ok(request(before ? { before } : {}));
      pages++;
      seen.push(...model.body.rows.map((r) => r.id));
      const next = model.body.next ? new URL(model.body.next, "https://x.invalid").searchParams.get("before") : null;
      if (next) {
        expect(model.body.rows).toHaveLength(PERIOD_HISTORY_PAGE);
        expect(parseCursor(next)).not.toBeNull();
      }
      before = next;
    } while (before && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(480);
    expect(seen).toHaveLength(480);
  });
});

describe("loadPeriodHistory: actors", () => {
  it("asks once for this page's actors, deduplicated, and names hidden and absent actors", async () => {
    const model = await ok(request());
    const rpcs = reads.filter((r) => r[0] === "rpc");
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0][1]).toBe("fn_list_visible_users");
    expect(((rpcs[0][2] as { _target_user_ids: string[] })._target_user_ids).sort()).toEqual([USER_1, HIDDEN].sort());
    const by = Object.fromEntries(model.body.rows.map((r) => [r.id, r.cells.by.text]));
    expect(by[`audit:${uuid(4)}`]).toBe("Restricted");
    expect(by[`audit:${uuid(1)}`]).toBe("System");
    expect(by[`payment_event:${uuid(11)}`]).toBe("System");
    expect(by[`audit:${uuid(2)}`]).toBe("Okello Daniel");
  });

  it("asks nothing when no entry has an actor", async () => {
    tables.billing_audit_log = [];
    tables.payment_events = [];
    await ok(request());
    expect(reads.some((r) => r[0] === "rpc")).toBe(false);
  });
});

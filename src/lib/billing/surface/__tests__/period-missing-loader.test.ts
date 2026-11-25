/**
 * The `billing.period-missing` watcher's reads: through the person's own
 * client, the organization's microgrids and periods filtered to the
 * organization explicitly (a super admin's row-level security shows every
 * organization); tenant assignments read only for microgrids with no period
 * in their last month, with the bill engine's role and effective-dated
 * overlap; nothing before the 2nd but the microgrids; a failed read, or one
 * at its bound, throws without the database's message.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { superAdmin } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";
import { loadPeriodMissing } from "../period-missing";

const ORG = "e7f50000-0000-4000-8000-000000000001";
const NORTH = "e7f50000-0000-4000-8000-0000000000a1";
const SOUTH = "e7f50000-0000-4000-8000-0000000000a2";
const WEST = "e7f50000-0000-4000-8000-0000000000a3";
const SECRET = "permission denied for table tenant_devices";
const fmt = createFmt({ locale: "en-GB" });
const NOW = "2026-11-20T09:00:00Z";

type Ops = [string, unknown[]][];
type Answer = { data: unknown; error: { message: string } | null };

/** A client whose every query is answered by `answer`, from its table and the operations applied to it. */
function client(answer: (table: string, ops: Ops) => Answer) {
  const calls: { table: string; ops: Ops }[] = [];
  const from = (table: string) => {
    const ops: Ops = [];
    calls.push({ table, ops });
    const chain: Record<string, unknown> = {
      then: (resolve: (r: Answer) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer(table, ops)).then(resolve, reject),
    };
    for (const op of ["select", "eq", "in", "lte", "gte", "or", "order", "limit"]) {
      chain[op] = (...args: unknown[]) => (ops.push([op, args]), chain);
    }
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}
const ok = (data: unknown): Answer => ({ data, error: null });
const eqOf = (ops: Ops, column: string) => ops.find(([op, [c]]) => op === "eq" && c === column)?.[1][1];

const req = (c: SupabaseClient, now = NOW): SurfaceRequest =>
  ({
    supabase: c,
    user: { id: "e7f50000-0000-4000-8fff-000000000001" } as User,
    roles: [superAdmin()],
    organizationId: ORG,
    params: {},
    search: new URLSearchParams(),
    locale: "en-GB",
    now: new Date(now),
    fmt,
  }) as unknown as SurfaceRequest;

const MICROGRIDS = [
  { id: NORTH, name: "North site", timezone: "Africa/Kampala" },
  { id: SOUTH, name: "South site", timezone: "Africa/Kampala" },
  { id: WEST, name: "West site", timezone: "America/Los_Angeles" },
];

describe("loadPeriodMissing", () => {
  it("reads the microgrids, their periods, then tenants only where last month has no period, and reports those with a metered tenant", async () => {
    const { client: c, calls } = client((table, ops) => {
      if (table === "microgrids") return ok(MICROGRIDS);
      // North has October; South and West have none (West's only period ends in September).
      if (table === "billing_periods") return ok([{ microgrid_id: NORTH, start_date: "2026-10-01", end_date: "2026-10-31" }, { microgrid_id: WEST, start_date: "2026-09-01", end_date: "2026-09-30" }]);
      // South had a tenant on a primary meter during October; West had none.
      if (table === "tenant_devices") return ok(eqOf(ops, "tenants.microgrid_id") === SOUTH ? [{ effective_from: "2026-03-01", effective_to: null }] : []);
      throw new Error(`unexpected ${table}`);
    });
    const out = await loadPeriodMissing(req(c));
    expect(out.map((s) => [s.id, s.severity, s.title, s.href])).toEqual([
      [SOUTH, "warn", "South site: no billing period for October 2026", `/microgrids/${SOUTH}/billing`],
    ]);
    expect(calls[0]).toEqual({
      table: "microgrids",
      ops: [
        ["select", ["id, name, timezone, communities!inner(org_id)"]],
        ["eq", ["communities.org_id", ORG]],
        ["order", ["name", { ascending: true }]],
        ["order", ["id", { ascending: true }]],
        ["limit", [501]],
      ],
    });
    expect(calls[1]).toEqual({
      table: "billing_periods",
      ops: [
        ["select", ["microgrid_id, start_date, end_date, microgrids!inner(communities!inner(org_id))"]],
        ["eq", ["microgrids.communities.org_id", ORG]],
        ["lte", ["start_date", "2026-10-31"]],
        ["gte", ["end_date", "2026-10-01"]],
        ["limit", [2001]],
      ],
    });
    expect(calls.slice(2).map((call) => call.table)).toEqual(["tenant_devices", "tenant_devices"]);
    expect(calls[2].ops).toEqual([
      ["select", ["effective_from, effective_to, tenants!inner(microgrid_id)"]],
      ["eq", ["role", "primary_consumption_meter"]],
      ["eq", ["tenants.microgrid_id", SOUTH]],
      ["lte", ["effective_from", "2026-10-31"]],
      ["or", ["effective_to.is.null,effective_to.gt.2026-10-01"]],
      ["limit", [1]],
    ]);
    expect(eqOf(calls[3].ops, "tenants.microgrid_id")).toBe(WEST);
  });

  it("leaves out an assignment that ended before the month began, as the engine would", async () => {
    const { client: c } = client((table) => {
      if (table === "microgrids") return ok([MICROGRIDS[1]]);
      if (table === "billing_periods") return ok([]);
      // effective_to is exclusive: an assignment ending on 1 October covered no day of it.
      return ok([{ effective_from: "2026-01-01", effective_to: "2026-10-01" }]);
    });
    expect(await loadPeriodMissing(req(c))).toEqual([]);
  });

  it("reads only the microgrids before the 2nd in every zone", async () => {
    const { client: c, calls } = client((table) => (table === "microgrids" ? ok(MICROGRIDS) : ok([])));
    // 1 November 20:00 in Kampala, 1 November 10:00 in Los Angeles.
    expect(await loadPeriodMissing(req(c, "2026-11-01T17:00:00Z"))).toEqual([]);
    expect(calls.map((call) => call.table)).toEqual(["microgrids"]);
  });

  it("asks only about the microgrids whose zone has reached the 2nd", async () => {
    const { client: c, calls } = client((table) => (table === "microgrids" ? ok(MICROGRIDS) : table === "billing_periods" ? ok([]) : ok([{ effective_from: "2026-01-01", effective_to: null }])));
    // 2 November 01:00 in Kampala, 1 November 14:00 in Los Angeles.
    const out = await loadPeriodMissing(req(c, "2026-11-01T22:00:00Z"));
    expect(out.map((s) => s.id)).toEqual([NORTH, SOUTH]);
    expect(calls.filter((call) => call.table === "tenant_devices").map((call) => eqOf(call.ops, "tenants.microgrid_id"))).toEqual([NORTH, SOUTH]);
  });

  it.each([
    ["microgrids", "billing.period-missing: the microgrids could not be read"],
    ["billing_periods", "billing.period-missing: the periods could not be read"],
    ["tenant_devices", "billing.period-missing: the tenants could not be read"],
  ])("throws when the %s read fails, without the database's message", async (failing, message) => {
    const { client: c } = client((table) =>
      table === failing ? { data: null, error: { message: SECRET } } : table === "microgrids" ? ok(MICROGRIDS) : ok([]),
    );
    const read = loadPeriodMissing(req(c));
    await expect(read).rejects.toThrow(message);
    await expect(read).rejects.not.toThrow(SECRET);
  });

  it("throws rather than check part of an organization with more microgrids or periods than one read returns", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `m${i}`, name: `Site ${i}`, timezone: "Africa/Kampala" }));
    await expect(loadPeriodMissing(req(client((t) => (t === "microgrids" ? ok(many) : ok([]))).client))).rejects.toThrow(
      "billing.period-missing: too many microgrids to check",
    );
    const periods = Array.from({ length: 2001 }, () => ({ microgrid_id: NORTH, start_date: "2026-10-01", end_date: "2026-10-31" }));
    await expect(loadPeriodMissing(req(client((t) => (t === "microgrids" ? ok(MICROGRIDS) : ok(periods))).client))).rejects.toThrow(
      "billing.period-missing: too many periods to check",
    );
  });

  it("reads tenants a few microgrids at a time and stops once it has found the cap", async () => {
    const many = Array.from({ length: 75 }, (_, i) => ({ id: `m${String(i).padStart(2, "0")}`, name: `Site ${String(i).padStart(2, "0")}`, timezone: "Africa/Kampala" }));
    const { client: c, calls } = client((table) => (table === "microgrids" ? ok(many) : table === "billing_periods" ? ok([]) : ok([{ effective_from: "2026-01-01", effective_to: null }])));
    const out = await loadPeriodMissing(req(c));
    expect(out).toHaveLength(50);
    expect(calls.filter((call) => call.table === "tenant_devices")).toHaveLength(50);
  });
});

/**
 * The `billing.period-due` watcher's reads: through the person's own
 * client, filtered to the organization explicitly (a super admin's
 * row-level security shows every organization), first the draft periods
 * that have ended in every zone, then, only if those are short of the cap,
 * the two UTC dates on which a period's zone decides; periods that have not
 * ended never crowd out ones that have; a failed read throws without the
 * database's message; no tenant reaches a signal.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { MAX_SIGNALS_PER_SOURCE } from "@/lib/gui/surface";
import { createFmt } from "@/lib/gui/fmt";
import { superAdmin, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";
import { loadPeriodDue } from "../period-due";

const ORG = "e7f10000-0000-4000-8000-000000000001";
const MG = "e7f10000-0000-4000-8000-0000000000a1";
const SECRET = "permission denied for table billing_periods";
const fmt = createFmt({ locale: "en-GB" });

const row = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  microgrid_id: MG,
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  timezone: "Africa/Kampala",
  billing_line_items: [{ count: 3 }],
  microgrids: { id: MG, name: "North site" },
  ...o,
});

const req = (client: SupabaseClient, now: string): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e7f10000-0000-4000-8fff-000000000001" } as User,
    roles: [superAdmin()],
    organizationId: ORG,
    params: {},
    search: new URLSearchParams(),
    locale: "en-GB",
    now: new Date(now),
    fmt,
  }) as unknown as SurfaceRequest;

describe("loadPeriodDue", () => {
  it("reads the periods that have ended everywhere, then the two edge dates, and nothing else", async () => {
    const { client, calls } = tableClient({ billing_periods: { data: [] } });
    expect(await loadPeriodDue(req(client, "2026-11-20T23:30:00Z"))).toEqual([]);
    const base: [string, unknown[]][] = [
      ["select", ["id, microgrid_id, start_date, end_date, timezone, billing_line_items(count), microgrids!inner(id, name, communities!inner(org_id))"]],
      ["eq", ["status", "draft"]],
      ["eq", ["microgrids.communities.org_id", ORG]],
    ];
    expect(calls).toEqual([
      {
        table: "billing_periods",
        ops: [
          ...base,
          // Before yesterday's UTC date: ended in every zone.
          ["lt", ["end_date", "2026-11-19"]],
          ["order", ["end_date", { ascending: true }]],
          ["order", ["id", { ascending: true }]],
          ["limit", [MAX_SIGNALS_PER_SOURCE]],
        ],
      },
      {
        table: "billing_periods",
        ops: [
          ...base,
          // Yesterday and today in UTC: the period's own zone decides.
          ["gte", ["end_date", "2026-11-19"]],
          ["lte", ["end_date", "2026-11-20"]],
          ["order", ["end_date", { ascending: true }]],
          ["order", ["id", { ascending: true }]],
          ["limit", [MAX_SIGNALS_PER_SOURCE * 10]],
        ],
      },
    ]);
  });

  it("skips the edge read once the periods that have ended everywhere fill the cap", async () => {
    const full = Array.from({ length: MAX_SIGNALS_PER_SOURCE }, (_, i) => row(`p${String(i).padStart(3, "0")}`));
    const fake = filteringClient(full);
    const out = await loadPeriodDue(req(fake.client, "2026-11-20T09:00:00Z"));
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(fake.calls).toBe(1);
  });

  it("does not let periods that have not ended in their zone crowd out ones that have", async () => {
    // 02:00Z on 20 November: still 19 November in New York, already over in Kampala.
    const notYet = Array.from({ length: 120 }, (_, i) =>
      row(`a-ny-${String(i).padStart(3, "0")}`, { start_date: "2026-11-01", end_date: "2026-11-19", timezone: "America/New_York" }),
    );
    const over = Array.from({ length: 30 }, (_, i) =>
      row(`b-kla-${String(i).padStart(3, "0")}`, { start_date: "2026-11-01", end_date: "2026-11-19", timezone: "Africa/Kampala" }),
    );
    const { client } = filteringClient([...notYet, ...over, row("october")]);
    const out = await loadPeriodDue(req(client, "2026-11-20T02:00:00Z"));
    expect(out.map((s) => s.id)).toEqual(["october", ...over.map((r) => r.id)]);
  });

  it("throws rather than guess when the edge dates hold more periods than it reads", async () => {
    const crowd = Array.from({ length: MAX_SIGNALS_PER_SOURCE * 10 }, (_, i) =>
      row(`e${String(i).padStart(4, "0")}`, { start_date: "2026-11-01", end_date: "2026-11-19", timezone: "America/New_York" }),
    );
    const { client } = filteringClient(crowd);
    await expect(loadPeriodDue(req(client, "2026-11-20T02:00:00Z"))).rejects.toThrow("billing.period-due: too many periods");
  });

  it("keeps a period whose end has passed in its own zone, and one that is only past in UTC's waits", async () => {
    const { client } = filteringClient([
      row("october"),
      row("ends-today-in-kampala", { start_date: "2026-11-01", end_date: "2026-11-20" }),
      row("no-bills", { start_date: "2026-11-01", end_date: "2026-11-19", billing_line_items: [{ count: 0 }] }),
    ]);
    // 22:00Z on 20 November is already 21 November in Kampala; 20:30Z is not.
    const late = await loadPeriodDue(req(client, "2026-11-20T21:30:00Z"));
    expect(late.map((s) => [s.id, s.title, s.href])).toEqual([
      ["october", "North site: October 2026 is not closed", `/microgrids/${MG}/billing/october/close`],
      ["no-bills", "North site: 1 to 19 November 2026 has no bills", `/microgrids/${MG}/billing/no-bills`],
      ["ends-today-in-kampala", "North site: 1 to 20 November 2026 is not closed", `/microgrids/${MG}/billing/ends-today-in-kampala/close`],
    ]);
    const early = await loadPeriodDue(req(client, "2026-11-20T20:30:00Z"));
    expect(early.map((s) => s.id)).toEqual(["october", "no-bills"]);
  });

  it("throws on a failed read, without the database's message", async () => {
    const { client } = tableClient({ billing_periods: { data: null, error: { message: SECRET } } });
    const failed = loadPeriodDue(req(client, "2026-11-20T09:00:00Z"));
    await expect(failed).rejects.toThrow("billing.period-due: the periods could not be read");
    await expect(failed).rejects.not.toThrow(SECRET);
  });

  it("puts no tenant into a signal, whatever the read returns beside the period", async () => {
    const { client } = tableClient({ billing_periods: { data: [row("october", { tenants: [{ display_name: "Akello Grace" }] })] } });
    const out = await loadPeriodDue(req(client, "2026-11-20T09:00:00Z"));
    expect(JSON.stringify(out)).not.toContain("Akello");
  });
});

/** A billing_periods fake that applies the date filters, the order and the limit, for the reads' interplay. */
function filteringClient(rows: ReturnType<typeof row>[]) {
  let calls = 0;
  const client = {
    from() {
      calls += 1;
      let out = [...rows];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        lt: (_c: string, v: string) => ((out = out.filter((r) => r.end_date < v)), chain),
        gte: (_c: string, v: string) => ((out = out.filter((r) => r.end_date >= v)), chain),
        lte: (_c: string, v: string) => ((out = out.filter((r) => r.end_date <= v)), chain),
        limit: (n: number) => {
          out = out.sort((x, y) => x.end_date.localeCompare(y.end_date) || x.id.localeCompare(y.id)).slice(0, n);
          return chain;
        },
        then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: out, error: null }).then(resolve),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, get calls() { return calls; } };
}

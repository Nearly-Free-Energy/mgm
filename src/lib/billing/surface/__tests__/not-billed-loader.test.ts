/**
 * The `billing.not-billed` loader: reads the period on the path's microgrid,
 * every bill and every tenant in pages, through the person's own client
 * only; refusals with fixed copy rather than a partial list; no capability
 * composed, so the section still loads while billing is off. A closed
 * period leaves out the tenants who joined after it closed, from the list and from
 * the count against the most a view lists.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";

const composeBilling = vi.fn();
vi.mock("@/lib/billing/compose", () => ({ composeBilling: (...args: unknown[]) => composeBilling(...args) }));

import { loadNotBilled, NOT_BILLED_REFUSALS } from "../not-billed";
import { PERIOD_REVIEW_MAX_ROWS } from "../period-review-model";
import { NOT_BILLED_REASON } from "../not-billed-model";

const ORG = "e7a00000-0000-4000-8000-000000000001";
const MG = "e7a00000-0000-4000-8000-0000000000a1";
const PERIOD = "e7a00000-0000-4000-8000-0000000000b1";
const T = (n: number) => `e7a00000-0000-4000-8000-${(0xd00 + n).toString(16).padStart(12, "0")}`;
const SECRET = "permission denied for table tenants";

type Result = { data: unknown; error: unknown };
let tables: Record<string, Result>;
let reads: unknown[][];

function client(): SupabaseClient {
  return {
    from(table: string) {
      reads.push(["from", table]);
      let after: string | null = null;
      let limit: number | null = null;
      let range: [number, number] | null = null;
      const answer = (): Promise<{ data: unknown; error: unknown; count?: number }> => {
        const t = tables[table];
        if (t.error) return Promise.resolve(t);
        const rows = Array.isArray(t.data) ? (t.data as { id: string }[]) : [];
        if (after !== null || limit !== null) {
          const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const left = after === null ? sorted : sorted.filter((r) => r.id > (after as string));
          return Promise.resolve({ data: left.slice(0, limit ?? left.length), error: null, count: left.length });
        }
        if (range !== null) return Promise.resolve({ data: rows.slice(range[0], range[1] + 1), error: null, count: rows.length });
        return Promise.resolve(t);
      };
      const chain: Record<string, unknown> = {
        select: (columns: string) => (reads.push(["select", table, columns]), chain),
        range: (from: number, to: number) => ((range = [from, to]), chain),
        gt: (_column: string, value: string) => ((after = value), chain),
        limit: (n: number) => ((limit = n), chain),
        eq: (column: string, value: string) => (reads.push(["eq", table, column, value]), chain),
        order: () => chain,
        maybeSingle: () => answer().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => answer().then(ok, no),
      };
      return chain;
    },
    rpc(name: string) {
      reads.push(["rpc", name]);
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

const request = (): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles: [managerOf(ORG)],
  organizationId: ORG,
  params: { id: MG, periodId: PERIOD },
  search: new URLSearchParams(),
  locale: "en-GB",
  now: new Date("2026-11-18T08:00:00Z"),
  fmt: createFmt({ locale: "en-GB" }),
});

const covering = { role: "primary_consumption_meter", effective_from: "2020-01-01", effective_to: null, devices: { openems_component_id: "m1", edges: { openems_edge_id: "e0" } } };
const tenant = (n: number, links: unknown[] = [], createdAt = "2020-01-01T00:00:00+00:00") => ({
  id: T(n),
  display_name: `Unit ${n}`,
  tenant_devices: links,
  created_at: createdAt,
});
const APRIL = { id: PERIOD, start_date: "2026-04-01", end_date: "2026-04-30", timezone: "Africa/Kampala", closed_at: null };
/** April, closed on 5 May. */
const APRIL_CLOSED = { ...APRIL, status: "closed", closed_at: "2026-05-05T09:00:00+00:00" };

beforeEach(() => {
  composeBilling.mockReset();
  reads = [];
  tables = {
    billing_periods: { data: { ...APRIL, status: "draft" }, error: null },
    billing_line_items: { data: [{ id: "b1", tenant_id: T(2) }], error: null },
    tenants: { data: [tenant(1, [covering]), tenant(2, [covering]), tenant(3)], error: null },
  };
});

describe("loadNotBilled", () => {
  it("lists the tenants with no bill and why, reading through the person's own client only", async () => {
    const out = await loadNotBilled(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows.map((r) => [r.id, r.cells.reason])).toEqual([
      [T(1), createFmt({ locale: "en-GB" }).text(NOT_BILLED_REASON.metered)],
      [T(3), createFmt({ locale: "en-GB" }).text(NOT_BILLED_REASON.no_meter)],
    ]);
    expect(out.model.body.rows.every((r) => r.actions.length === 1)).toBe(true);
    expect(composeBilling).not.toHaveBeenCalled();
    expect(reads.filter((r) => r[0] === "rpc")).toEqual([]);
    // The period on the path's microgrid, the bills of that period, the tenants of that microgrid with their primary links.
    expect(reads).toContainEqual(["eq", "billing_periods", "microgrid_id", MG]);
    expect(reads).toContainEqual(["eq", "billing_line_items", "billing_period_id", PERIOD]);
    expect(reads).toContainEqual(["eq", "tenants", "microgrid_id", MG]);
    expect(reads).toContainEqual(["eq", "tenants", "tenant_devices.role", "primary_consumption_meter"]);
    // The period's zone and close, and each tenant's creation, for a closed period's list.
    expect(reads).toContainEqual(["select", "billing_periods", "id, start_date, end_date, status, timezone, closed_at"]);
    expect(reads.find((r) => r[0] === "select" && r[1] === "tenants")?.[2]).toMatch(/, created_at$/);
  });

  it("leaves a tenant who joined after a closed period out of its list, and lists them in a draft", async () => {
    // Recorded in June, with a meter from June: not a tenant in April.
    tables.tenants = { data: [tenant(1, [covering]), tenant(4, [{ ...covering, effective_from: "2026-06-01" }], "2026-06-01T08:00:00+00:00")], error: null };
    tables.billing_line_items = { data: [], error: null };
    tables.billing_periods = { data: APRIL_CLOSED, error: null };
    const closed = await loadNotBilled(request());
    if (!closed.ok) throw new Error(closed.message);
    expect(closed.model.body.rows.map((r) => r.id)).toEqual([T(1)]);

    tables.billing_periods = { data: { ...APRIL, status: "draft" }, error: null };
    const draft = await loadNotBilled(request());
    if (!draft.ok) throw new Error(draft.message);
    expect(draft.model.body.rows.map((r) => r.id)).toEqual([T(1), T(4)]);
  });

  it("keeps a tenant recorded after a closed period ended but before it closed, as the close counted them", async () => {
    tables.tenants = { data: [tenant(4, [], "2026-05-03T08:00:00+00:00")], error: null };
    tables.billing_line_items = { data: [], error: null };
    tables.billing_periods = { data: APRIL_CLOSED, error: null };
    const out = await loadNotBilled(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows.map((r) => r.id)).toEqual([T(4)]);
  });

  it("does not count the tenants a closed period leaves out against the most it lists", async () => {
    tables.billing_line_items = { data: [], error: null };
    tables.tenants = {
      data: Array.from({ length: PERIOD_REVIEW_MAX_ROWS + 1 }, (_, n) => tenant(n, [], n === 0 ? undefined : "2026-06-01T08:00:00+00:00")),
      error: null,
    };
    tables.billing_periods = { data: APRIL_CLOSED, error: null };
    const out = await loadNotBilled(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows.map((r) => r.id)).toEqual([T(0)]);
    tables.billing_periods = { data: { ...APRIL, status: "draft" }, error: null };
    expect(await loadNotBilled(request())).toEqual(NOT_BILLED_REFUSALS.tooLarge);
  });

  it("offers no action on a closed period", async () => {
    tables.billing_periods = { data: APRIL_CLOSED, error: null };
    const out = await loadNotBilled(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows).toHaveLength(2);
    expect(out.model.body.rows.every((r) => r.actions.length === 0)).toBe(true);
  });

  it("answers 404 for a period it cannot see on the path's microgrid", async () => {
    tables.billing_periods = { data: null, error: null };
    expect(await loadNotBilled(request())).toEqual(NOT_BILLED_REFUSALS.notFound);
  });

  it.each(["billing_periods", "billing_line_items", "tenants"])("answers 503 with fixed copy when %s cannot be read", async (table) => {
    tables[table] = { data: null, error: { message: SECRET } };
    const out = await loadNotBilled(request());
    expect(out).toEqual(NOT_BILLED_REFUSALS.unavailable);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("refuses more tenants not billed than a view lists, rather than cutting the list", async () => {
    tables.billing_line_items = { data: [], error: null };
    tables.tenants = { data: Array.from({ length: PERIOD_REVIEW_MAX_ROWS + 1 }, (_, n) => tenant(n)), error: null };
    expect(await loadNotBilled(request())).toEqual(NOT_BILLED_REFUSALS.tooLarge);
    // As many as it lists is fine, however many tenants are billed.
    tables.billing_line_items = { data: [{ id: "b1", tenant_id: T(0) }], error: null };
    expect(await loadNotBilled(request())).toMatchObject({ ok: true });
  });
});

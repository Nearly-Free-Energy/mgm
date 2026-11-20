/**
 * The `billing.period-due` watcher's read: one query through the person's
 * own client, filtered to the organization explicitly (a super admin's
 * row-level security shows every organization), to draft periods that can
 * have ended; a failed read throws without the database's message; no
 * tenant reaches a signal.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
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
  it("reads the organization's draft periods that can have ended, oldest first, and nothing else", async () => {
    const { client, calls } = tableClient({ billing_periods: { data: [] } });
    expect(await loadPeriodDue(req(client, "2026-11-20T23:30:00Z"))).toEqual([]);
    expect(calls).toEqual([
      {
        table: "billing_periods",
        ops: [
          ["select", ["id, microgrid_id, start_date, end_date, timezone, billing_line_items(count), microgrids!inner(id, name, communities!inner(org_id))"]],
          ["eq", ["status", "draft"]],
          ["eq", ["microgrids.communities.org_id", ORG]],
          // Today's UTC date: no zone's date is more than a day ahead of it.
          ["lte", ["end_date", "2026-11-20"]],
          ["order", ["end_date", { ascending: true }]],
          ["order", ["id", { ascending: true }]],
          ["limit", [100]],
        ],
      },
    ]);
  });

  it("keeps a period whose end has passed in its own zone, and one that is only past in UTC's waits", async () => {
    const { client } = tableClient({
      billing_periods: {
        data: [
          row("october"),
          row("ends-today-in-kampala", { start_date: "2026-11-01", end_date: "2026-11-20" }),
          row("no-bills", { start_date: "2026-11-01", end_date: "2026-11-19", billing_line_items: [{ count: 0 }] }),
        ],
      },
    });
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

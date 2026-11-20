/**
 * billing.bill-from-readings' availability and prepare
 * (../not-billed.ts): a draft only; whose bill, which period and the
 * tenant's meter, with a warning for a metered tenant; the route's refusals
 * in the route's order; reads only, through the person's own client.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";
import { BILL_FROM_READINGS_COPY } from "../../schemas";
import {
  BILL_FROM_READINGS_REFUSALS,
  BILL_FROM_READINGS_STATEMENT,
  BILL_FROM_READINGS_WARNINGS,
  billFromReadingsAvailable,
  prepareBillFromReadings,
} from "../not-billed";

const ORG = "e7b00000-0000-4000-8000-000000000001";
const MG = "e7b00000-0000-4000-8000-0000000000a1";
const OTHER_MG = "e7b00000-0000-4000-8000-0000000000a2";
const PERIOD = "e7b00000-0000-4000-8000-0000000000b1";
const CLOSED = "e7b00000-0000-4000-8000-0000000000b2";
const MISSING = "e7b00000-0000-4000-8000-0000000000b3";
const TENANT = "e7b00000-0000-4000-8000-0000000000d1";
const SECRET = "permission denied for table tenants";
const fmt = createFmt({ locale: "en-GB" });

type Result = { data: unknown; error: unknown };
let tables: Record<string, Result>;
let calls: unknown[][];

function client(): SupabaseClient {
  return {
    from(table: string) {
      calls.push(["from", table]);
      const answer = () => Promise.resolve(tables[table]);
      const chain: Record<string, unknown> = {
        select: (columns: string) => (calls.push(["select", table, columns]), chain),
        eq: (column: string, value: string) => (calls.push(["eq", table, column, value]), chain),
        in: (column: string, values: string[]) => (calls.push(["in", table, column, values]), chain),
        insert: () => (calls.push(["insert", table]), chain),
        update: () => (calls.push(["update", table]), chain),
        upsert: () => (calls.push(["upsert", table]), chain),
        delete: () => (calls.push(["delete", table]), chain),
        maybeSingle: () => answer().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => answer().then(ok, no),
      };
      return chain;
    },
    rpc(name: string) {
      calls.push(["rpc", name]);
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

const request = (): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles: [managerOf(ORG)],
  organizationId: ORG,
  params: { periodId: PERIOD, tenantId: TENANT },
  search: new URLSearchParams(),
  locale: "en-GB",
  now: new Date("2026-11-18T08:00:00Z"),
  fmt,
});

const covering = { role: "primary_consumption_meter", effective_from: "2020-01-01", effective_to: null, devices: { openems_component_id: "m1", edges: { openems_edge_id: "e0" } } };
const prepare = () => prepareBillFromReadings(request(), { params: { periodId: PERIOD, tenantId: TENANT }, body: {} });

beforeEach(() => {
  calls = [];
  tables = {
    billing_periods: { data: { id: PERIOD, microgrid_id: MG, start_date: "2026-04-01", end_date: "2026-04-30", status: "draft" }, error: null },
    tenants: { data: { id: TENANT, display_name: "Akello Grace", microgrid_id: MG, tenant_devices: [] }, error: null },
    billing_line_items: { data: null, error: null },
  };
});

describe("billFromReadingsAvailable", () => {
  it("offers it on a draft, and says why not on a closed or missing period", async () => {
    tables.billing_periods = {
      data: [
        { id: PERIOD, status: "draft" },
        { id: CLOSED, status: "closed" },
      ],
      error: null,
    };
    expect(await billFromReadingsAvailable(request(), [PERIOD, CLOSED, MISSING])).toEqual({
      [PERIOD]: true,
      [CLOSED]: BILL_FROM_READINGS_COPY.closed,
      [MISSING]: "This billing period could not be found.",
    });
    expect(calls).toContainEqual(["in", "billing_periods", "id", [PERIOD, CLOSED, MISSING]]);
  });

  it("throws on a failed read, so the host shows it as not checked", async () => {
    tables.billing_periods = { data: null, error: { message: SECRET } };
    await expect(billFromReadingsAvailable(request(), [PERIOD])).rejects.toThrow("availability not read");
  });
});

describe("prepareBillFromReadings", () => {
  it("names the tenant, the period and the meter, with the statement and the warning every bill from readings carries", async () => {
    const out = await prepare();
    expect(out).toEqual({
      ok: true,
      model: {
        type: "ceremony",
        statement: BILL_FROM_READINGS_STATEMENT,
        facts: [
          { label: "Tenant", value: fmt.text("Akello Grace") },
          { label: "Period", value: fmt.text("1 Apr 2026 – 30 Apr 2026") },
          { label: "Meter", value: fmt.text("No meter for this period") },
        ],
        warnings: [BILL_FROM_READINGS_WARNINGS.asEntered],
        acknowledgements: [],
      },
    });
    // The tenant's own primary links, as the engine reads them.
    expect(calls).toContainEqual(["eq", "tenants", "id", TENANT]);
    expect(calls).toContainEqual(["eq", "tenants", "tenant_devices.role", "primary_consumption_meter"]);
  });

  it("warns that a metered tenant's bill from readings is kept by runs from meter data", async () => {
    tables.tenants = { data: { id: TENANT, display_name: "Akello Grace", microgrid_id: MG, tenant_devices: [covering] }, error: null };
    const out = await prepare();
    if (!out.ok) throw new Error(out.message);
    expect(out.model.facts.at(-1)).toEqual({ label: "Meter", value: fmt.text("Assigned for the whole period") });
    expect(out.model.warnings).toEqual([BILL_FROM_READINGS_WARNINGS.asEntered, BILL_FROM_READINGS_WARNINGS.metered]);
  });

  it("names an assignment gap", async () => {
    tables.tenants = {
      data: { id: TENANT, display_name: "Akello Grace", microgrid_id: MG, tenant_devices: [{ ...covering, effective_from: "2026-04-15" }] },
      error: null,
    };
    const out = await prepare();
    if (!out.ok) throw new Error(out.message);
    expect(out.model.facts.at(-1)).toEqual({ label: "Meter", value: fmt.text("Meter assignment gap in this period") });
    expect(out.model.warnings).toEqual([BILL_FROM_READINGS_WARNINGS.asEntered]);
  });

  it.each([
    ["a period it cannot read", () => (tables.billing_periods = { data: null, error: { message: SECRET } }), BILL_FROM_READINGS_REFUSALS.unavailable],
    ["a missing period", () => (tables.billing_periods = { data: null, error: null }), BILL_FROM_READINGS_REFUSALS.notFound],
    [
      "a closed period",
      () => (tables.billing_periods = { data: { id: PERIOD, microgrid_id: MG, start_date: "2026-04-01", end_date: "2026-04-30", status: "closed" }, error: null }),
      BILL_FROM_READINGS_REFUSALS.closed,
    ],
    ["a tenant it cannot read", () => (tables.tenants = { data: null, error: { message: SECRET } }), BILL_FROM_READINGS_REFUSALS.unavailable],
    ["a missing tenant", () => (tables.tenants = { data: null, error: null }), BILL_FROM_READINGS_REFUSALS.tenantNotFound],
    [
      "a tenant of another microgrid",
      () => (tables.tenants = { data: { id: TENANT, display_name: "Akello Grace", microgrid_id: OTHER_MG, tenant_devices: [] }, error: null }),
      BILL_FROM_READINGS_REFUSALS.otherMicrogrid,
    ],
    ["bills it cannot read", () => (tables.billing_line_items = { data: null, error: { message: SECRET } }), BILL_FROM_READINGS_REFUSALS.unavailable],
    ["a tenant with a bill", () => (tables.billing_line_items = { data: { id: "b1" }, error: null }), BILL_FROM_READINGS_REFUSALS.hasBill],
  ])("refuses %s with fixed copy", async (_label, arrange, refusal) => {
    arrange();
    const out = await prepare();
    expect(out).toEqual(refusal);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("refuses in the route's order: a closed period before a tenant of another microgrid or with a bill", async () => {
    tables.billing_periods = { data: { id: PERIOD, microgrid_id: MG, start_date: "2026-04-01", end_date: "2026-04-30", status: "closed" }, error: null };
    tables.tenants = { data: { id: TENANT, display_name: "Akello Grace", microgrid_id: OTHER_MG, tenant_devices: [] }, error: null };
    tables.billing_line_items = { data: { id: "b1" }, error: null };
    expect(await prepare()).toEqual(BILL_FROM_READINGS_REFUSALS.closed);
    expect(calls.filter((c) => c[0] === "from").map((c) => c[1])).toEqual(["billing_periods"]);
    tables.billing_periods.data = { ...(tables.billing_periods.data as object), status: "draft" };
    calls = [];
    expect(await prepare()).toEqual(BILL_FROM_READINGS_REFUSALS.otherMicrogrid);
    expect(calls.filter((c) => c[0] === "from").map((c) => c[1])).toEqual(["billing_periods", "tenants"]);
  });

  it("only reads: no function call and no write", async () => {
    await prepare();
    expect(calls.filter((c) => ["rpc", "insert", "update", "upsert", "delete"].includes(c[0] as string))).toEqual([]);
    expect(calls).toContainEqual(["eq", "billing_line_items", "billing_period_id", PERIOD]);
    expect(calls).toContainEqual(["eq", "billing_line_items", "tenant_id", TENANT]);
  });
});

/**
 * GET /api/gui/view serves a period's close checklist,
 * `billing.close-checklist`, and POST /api/gui/prepare prepares
 * `billing.close-period` with the close route's own ceremony: the host
 * resolves the microgrid and the period through the person's own client,
 * and the loader and prepare read the period, the bills and
 * fn_billing_period_close_review through that client. A full close runs
 * through the host the way a GUI runs it: prepare, then the confirmation
 * the host's step sends, posted to the close route, which checks the
 * digest, the acknowledgements and the typed name. Another organization's
 * manager and a tenant get nothing; while billing is off the checklist
 * still loads, with the gate's notice and Close disabled.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[close-checklist.db] no caller");
    return caller.client;
  },
}));

import { invoke } from "@/lib/gui/host/client/invoke";
import type { PreparedAction } from "@/lib/gui/host/server/prepare";
import { POST as closeRoute } from "@/app/api/billing-periods/[periodId]/close/route";
import { CLOSE_REFUSAL_COPY } from "@/lib/billing/close";
import { POST as prepareRoute } from "../../prepare/route";
import { GET } from "../route";

const ORG = "e7900000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7900000-0000-4000-8000-000000000002";
const COMMUNITY = "e7900000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7900000-0000-4000-8001-000000000002";
const MICROGRID = "e7900000-0000-4000-8002-000000000001";
const SECOND_MICROGRID = "e7900000-0000-4000-8002-000000000002";
const OTHER_MICROGRID = "e7900000-0000-4000-8002-000000000003";
const SCHEDULE = "e7900000-0000-4000-8006-000000000001";
/** October: bills for three of four tenants, one with no usage. Closed through the host below. */
const WARN = "e7900000-0000-4000-8003-000000000001";
/** September: no bills. */
const EMPTY = "e7900000-0000-4000-8003-000000000002";
/** August: one bill whose total is not a whole number. */
const FRACTIONAL = "e7900000-0000-4000-8003-000000000003";
/** July: closed. */
const CLOSED = "e7900000-0000-4000-8003-000000000004";
/** June: every tenant billed. Refused on the confirmation, then closed after a stale digest. */
const READY = "e7900000-0000-4000-8003-000000000005";
const tenant = (n: number) => `e7900000-0000-4000-8004-00000000000${n}`;
const bill = (n: number) => `e7900000-0000-4000-8005-0000000000${n.toString().padStart(2, "0")}`;
const EMAIL = "gui-close-manager@test.local";
const OTHER_EMAIL = "gui-close-other@test.local";
const TENANT_EMAIL = "gui-close-tenant@test.local";

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;

const href = (periodId: string, microgridId = MICROGRID) => `/microgrids/${microgridId}/billing/${periodId}/close`;
const view = (path: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(path)}`));
const prepare = (periodId: string) =>
  prepareRoute(
    new NextRequest("http://localhost/api/gui/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB" },
      body: JSON.stringify({ action: "billing.close-period", params: { periodId } }),
    }),
  );
const postClose = (periodId: string, body: unknown) =>
  closeRoute(
    new NextRequest(`http://localhost/api/billing-periods/${periodId}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ periodId }) },
  );

/** What a GUI's fetch does with the host's write: the close route, as Next.js would route it. */
const routeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const match = /^\/api\/billing-periods\/([^/]+)\/close$/.exec(url);
  if (!match || init.method !== "POST") throw new Error(`[close-checklist.db] unexpected write ${init.method} ${url}`);
  return postClose(match[1], JSON.parse(init.body as string));
};

/** The confirmation the host's step sends once every box is ticked and the name typed (action-host.tsx). */
type Ceremony = { typed: string; digest: string; acknowledgements: { id: string }[]; facts: { label: string; value: { text: string } }[] };
const confirmationFor = (c: Ceremony, o: { acknowledged?: string[]; typed?: string } = {}) => ({
  digest: c.digest,
  acknowledged: o.acknowledged ?? c.acknowledgements.map((a) => a.id),
  typed: o.typed ?? c.typed,
});
const send = (prepared: PreparedAction, confirmation: ReturnType<typeof confirmationFor>) =>
  invoke(prepared, null, { level: "ceremony", confirmation }, routeFetch);

async function prepared(periodId: string): Promise<PreparedAction & { ceremony: Ceremony }> {
  const res = await prepare(periodId);
  expect(res.status).toBe(200);
  return (await res.json()) as PreparedAction & { ceremony: Ceremony };
}

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[close-checklist.db] mgm_plugins: ${error.message}`);
}

async function status(periodId: string): Promise<string> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_periods").select("status").eq("id", periodId).single();
  if (error) throw new Error(`[close-checklist.db] status: ${error.message}`);
  return data.status;
}

// cleanupTestData purges, as the database owner, the closed periods the
// billing retention guards keep from an organization's delete.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

/** A bill with every key spelled out: a multi-row insert sends the union of the rows' keys. */
const row = (id: string, periodId: string, tenantId: string, o: Record<string, unknown> = {}) => ({
  id,
  billing_period_id: periodId,
  tenant_id: tenantId,
  start_kwh: 100,
  end_kwh: 110,
  usage_kwh: 10,
  tier_breakdown: [{ label: "Lifeline", kwh: 10, amount: 2500 }],
  total_amount: 2500,
  reading_source: "edge",
  payment_status: "unpaid",
  paid_at: null,
  invoice_number: null,
  ...o,
});

const period = (id: string, month: string, last: string, o: Record<string, unknown> = {}) => ({
  id,
  microgrid_id: MICROGRID,
  start_date: `2026-${month}-01`,
  end_date: `2026-${month}-${last}`,
  timezone: "Africa/Kampala",
  status: "draft",
  closed_at: null,
  rate_schedule_id: SCHEDULE,
  ...o,
});

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Close Org" }, { id: OTHER_ORG, name: "GUI Close Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Close Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Close Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Close site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: SECOND_MICROGRID, community_id: COMMUNITY, name: "Second site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      {
        id: SCHEDULE,
        microgrid_id: MICROGRID,
        tiers: [{ label: "Lifeline", min_kwh: 1, max_kwh: null, rate_per_kwh: 250 }],
        service_charge: 0,
        tax_rate: 0,
      },
    ],
    [
      "tenants",
      [1, 2, 3, 4].map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Close unit ${n}`, primary_phone: `+25670000090${n}` })),
    ],
    [
      "billing_periods",
      [
        period(WARN, "10", "31"),
        period(EMPTY, "09", "30"),
        period(FRACTIONAL, "08", "31"),
        period(CLOSED, "07", "31", { status: "closed", closed_at: "2026-08-03T09:00:00+00:00" }),
        period(READY, "06", "30"),
      ],
    ],
    [
      "billing_line_items",
      [
        row(bill(1), WARN, tenant(1)),
        row(bill(2), WARN, tenant(2), { reading_source: "manual" }),
        row(bill(3), WARN, tenant(3), { usage_kwh: null, total_amount: 0, tier_breakdown: [] }),
        row(bill(11), FRACTIONAL, tenant(1), { total_amount: 100.5 }),
        row(bill(21), CLOSED, tenant(1)),
        ...[1, 2, 3, 4].map((n) => row(bill(30 + n), READY, tenant(n))),
      ],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[close-checklist.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
}, 60_000);

type Step = { id: string; title: string; state: string; detail?: string; href?: string; action?: { action: string; enabled: boolean; reason?: string; tone?: string; params: Record<string, string> } };

describe.skipIf(shouldSkip())("GET /api/gui/view: a period's close checklist", () => {
  it("walks a draft with warnings to an enabled Close, with links and the trail", async () => {
    caller = manager;
    await setBilling(true);
    const res = await view(href(WARN));
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model).toMatchObject({
      type: "view",
      view: "billing.close-checklist",
      kind: "flow",
      org: ORG,
      title: "Close October 2026",
      subtitle: "Africa/Kampala",
      entity: { kind: "billingPeriod", id: WARN },
    });
    expect(model).not.toHaveProperty("notice");
    const steps = model.body.steps as Step[];
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ["bills", "todo"],
      ["usage", "todo"],
      ["totals", "todo"],
      ["close", "current"],
    ]);
    expect(steps[0].detail).toContain("1 tenant has no bill in this period: Close unit 4.");
    expect(steps[1].detail).toContain("1 bill has no usage recorded: Close unit 3.");
    // Close unit 3's bill has no usage and is 'edge' by default; it is not counted as read.
    expect(steps[1].detail).toContain("Of the rest, 1 read from meters, 1 entered by hand.");
    expect(steps[0].href).toBe(`/microgrids/${MICROGRID}/billing/${WARN}`);
    expect(steps[3].action).toEqual({ action: "billing.close-period", params: { periodId: WARN }, label: "Close period", enabled: true });
    expect(model.links.map((l: { id: string }) => l.id)).toEqual(["billing.back-to-period", "billing.view-history"]);
    expect(model.trail.map((c: { label: string }) => c.label)).toContain("Close site");
  });

  it("blocks a draft with no bills, with Close disabled with the reason", async () => {
    caller = manager;
    const model = await (await view(href(EMPTY))).json();
    const steps = model.body.steps as Step[];
    expect(steps.map((s) => s.state)).toEqual(["blocked", "todo", "todo", "blocked"]);
    expect(steps[3].action).toMatchObject({ enabled: false, reason: "Generate bills before closing this period." });
  });

  it("blocks a draft with a total that is not a whole number", async () => {
    caller = manager;
    const model = await (await view(href(FRACTIONAL))).json();
    const steps = model.body.steps as Step[];
    // Three tenants have no bill; the one bill has usage.
    expect(steps.map((s) => s.state)).toEqual(["todo", "done", "blocked", "blocked"]);
    expect(steps[2].detail).toBe("Regenerate the bills for Close unit 1 before closing: their totals are not whole numbers.");
    expect(steps[3].action).toMatchObject({ enabled: false, reason: steps[2].detail });
  });

  it("shows a closed period as closed, with the CSV export and no Close", async () => {
    caller = manager;
    const res = await view(href(CLOSED));
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model.title).toBe("July 2026 is closed");
    expect(model.body.steps).toEqual([expect.objectContaining({ id: "close", title: "Period closed", state: "done" })]);
    expect(model.body.steps[0]).not.toHaveProperty("action");
    expect(model.links.map((l: { id: string }) => l.id)).toEqual(["billing.back-to-period", "billing.view-history", "billing.export-csv"]);
    expect(model.links[2]).toMatchObject({ label: "Export CSV for URA", href: `/api/billing-periods/${CLOSED}/export-csv` });
  });

  it("finds no period under another microgrid", async () => {
    caller = manager;
    expect((await view(href(WARN, SECOND_MICROGRID))).status).toBe(404);
  });

  it("gives another organization's manager nothing, and their close is refused", async () => {
    caller = other;
    const res = await view(href(WARN));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Close unit");
    expect(text).not.toContain("Close site");
    expect((await prepare(WARN)).status).toBe(404);
    expect((await postClose(WARN, {})).status).toBe(404);
    expect(await status(WARN)).toBe("draft");
  });

  it("gives a tenant of the microgrid nothing, and their close is refused", async () => {
    caller = tenantUser;
    const res = await view(href(WARN));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Close site");
    expect((await prepare(WARN)).status).toBe(404);
    // The route's own reads, with the tenant's client, find no period.
    expect((await postClose(WARN, {})).status).toBe(404);
    expect(await status(WARN)).toBe("draft");
  });

  it("still loads while billing is off, with the gate's notice and Close disabled; prepare is refused", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const res = await view(href(WARN));
      expect(res.status).toBe(200);
      const model = await res.json();
      expect(model.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("Billing is disabled") });
      expect(model.body.steps.at(-1).action).toMatchObject({ enabled: false, reason: model.notice.text });
      const refused = await prepare(WARN);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ ok: false, message: expect.stringContaining("Billing is disabled") });
    } finally {
      await setBilling(true);
    }
  });
});

describe.skipIf(shouldSkip())("closing a period through the GUI host", () => {
  it("refuses a missing acknowledgement and a wrong name, and closes nothing", async () => {
    caller = manager;
    const p = await prepared(READY);
    expect(p.ceremony.acknowledgements.map((a) => a.id)).toEqual(["totals_reviewed"]);
    expect(await send(p, confirmationFor(p.ceremony, { acknowledged: [] }))).toMatchObject({
      ok: false,
      status: 428,
      code: "billing_close_acknowledgement_missing",
    });
    expect(await send(p, confirmationFor(p.ceremony, { typed: "September 2026" }))).toMatchObject({
      ok: false,
      status: 428,
      code: "billing_close_name_mismatch",
    });
    expect(await status(READY)).toBe("draft");
  });

  it("refuses totals that changed after prepare with the code the host prepares again on, and closes with the new ones", async () => {
    caller = manager;
    const stale = await prepared(READY);
    // Neutral, and prepared again on the route's code for totals that changed (action-host.tsx).
    expect(stale.tone).toBe("neutral");
    expect(stale.prepareAgainOn).toContain("billing_period_totals_changed");
    const total = (p: { ceremony: Ceremony }) => p.ceremony.facts.find((f) => f.label === "Total")?.value.text;
    const svc = await serviceClient();
    const { error } = await svc.from("billing_line_items").update({ total_amount: 3000 }).eq("id", bill(31));
    if (error) throw new Error(`[close-checklist.db] update: ${error.message}`);
    // The answer the host prepares again on; its message is the note over the new totals.
    expect(await send(stale, confirmationFor(stale.ceremony))).toMatchObject({
      ok: false,
      status: 409,
      code: "billing_period_totals_changed",
      message: CLOSE_REFUSAL_COPY.totalsChanged,
    });
    expect(await status(READY)).toBe("draft");

    // Preparing again, as the host does with the same ref, returns the new totals.
    const fresh = await prepared(READY);
    expect(fresh.ceremony.digest).not.toBe(stale.ceremony.digest);
    expect(total(fresh)).toBeDefined();
    expect(total(fresh)).not.toBe(total(stale));
    expect(await send(fresh, confirmationFor(fresh.ceremony))).toMatchObject({ ok: true });
    expect(await status(READY)).toBe("closed");
  });

  it("closes the draft with warnings once each is acknowledged and its name typed", async () => {
    caller = manager;
    const p = await prepared(WARN);
    expect(p).toMatchObject({ type: "prepared", confirm: "ceremony", method: "POST", path: `/api/billing-periods/${WARN}/close` });
    expect(p.ceremony.typed).toBe("October 2026");
    expect(p.ceremony.acknowledgements.map((a) => a.id)).toEqual(["totals_reviewed", "tenants_without_bills", "bills_without_usage"]);
    expect(p.ceremony.digest).toMatch(/^v1:/);

    expect(await send(p, confirmationFor(p.ceremony))).toMatchObject({ ok: true });
    expect(await status(WARN)).toBe("closed");

    const svc = await serviceClient();
    const { data: audit, error } = await svc
      .from("billing_audit_log")
      .select("actor_user_id, details")
      .eq("billing_period_id", WARN)
      .eq("event_type", "period_closed");
    expect(error).toBeNull();
    expect(audit).toEqual([
      expect.objectContaining({
        actor_user_id: manager.userId,
        details: expect.objectContaining({ digest: p.ceremony.digest, acknowledged: ["totals_reviewed", "tenants_without_bills", "bills_without_usage"] }),
      }),
    ]);

    // The refreshed checklist shows it closed, and Close is no longer offered.
    const model = await (await view(href(WARN))).json();
    expect(model.title).toBe("October 2026 is closed");
    expect(model.links.at(-1)).toMatchObject({ id: "billing.export-csv", label: "Export CSV for URA" });
    const again = await prepare(WARN);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "gui_action_unavailable", message: "Billing period is already closed." });
  });
});

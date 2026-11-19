/**
 * GET /api/gui/view serves one billing period's audit history,
 * `billing.period-history`: the route checks the session, the host resolves
 * the microgrid and the period through the person's own client, and the
 * loader reads the audit log and payment events through that client, a
 * page at a time, newest first, with ties across a page boundary. The
 * period review's View history link for a tenant opens that tenant's
 * entries; a tenant of another microgrid or organization is never named;
 * payment_events.raw_payload never leaves the database; another
 * organization's manager and a tenant get nothing; and while billing is off
 * the history still loads, with the gate's notice.
 *
 * The legacy page still serves /microgrids/[id]/billing/[periodId]/history
 * in the browser; this reaches the view only through the host's API.
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
    if (!caller) throw new Error("[period-history.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e7a00000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7a00000-0000-4000-8000-000000000002";
const COMMUNITY = "e7a00000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7a00000-0000-4000-8001-000000000002";
const MICROGRID = "e7a00000-0000-4000-8002-000000000001";
const SECOND_MICROGRID = "e7a00000-0000-4000-8002-000000000002";
const OTHER_MICROGRID = "e7a00000-0000-4000-8002-000000000003";
const SCHEDULE = "e7a00000-0000-4000-8006-000000000001";
const DRAFT = "e7a00000-0000-4000-8003-000000000001";
const EMPTY = "e7a00000-0000-4000-8003-000000000002";
const OTHER_PERIOD = "e7a00000-0000-4000-8003-000000000003";
const tenant = (n: number) => `e7a00000-0000-4000-8004-00000000000${n}`;
const bill = (n: number) => `e7a00000-0000-4000-8005-00000000000${n}`;
const auditId = (n: number) => `e7a00000-0000-4000-8007-${n.toString(16).padStart(12, "0")}`;
const eventId = (n: number) => `e7a00000-0000-4000-8008-${n.toString(16).padStart(12, "0")}`;
const EMAIL = "gui-history-manager@test.local";
const OTHER_EMAIL = "gui-history-other@test.local";
const TENANT_EMAIL = "gui-history-tenant@test.local";
const CANARY = "RAW-PAYLOAD-CANARY";
/** Extra entries, enough that the first page's boundary falls inside a tie. */
const EXTRA = 205;

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;

const view = (href: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(href)}`));
const historyHref = (period = DRAFT, microgrid = MICROGRID) => `/microgrids/${microgrid}/billing/${period}/history`;

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[period-history.db] mgm_plugins: ${error.message}`);
}

// cleanupTestData purges, as the database owner, the paid bill and its
// payment events the billing retention guards keep from an organization's delete.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

/** A bill with every key spelled out: a multi-row insert sends the union of the rows' keys. */
const billRow = (id: string, periodId: string, tenantId: string, o: Record<string, unknown> = {}) => ({
  id,
  billing_period_id: periodId,
  tenant_id: tenantId,
  start_kwh: 100,
  end_kwh: 150,
  usage_kwh: 50,
  tier_breakdown: [{ label: "Flat", kwh: 50, amount: 30000 }],
  total_amount: 30000,
  reading_source: "edge",
  payment_status: "unpaid",
  paid_at: null,
  ...o,
});

/** An audit row with every key spelled out; a null actor is the system's. */
const auditRow = (
  id: string,
  o: { period?: string; lineItem?: string | null; type?: string; actor?: string | null; at: string; details?: Record<string, unknown> },
) => ({
  id,
  billing_period_id: o.period ?? DRAFT,
  billing_line_item_id: o.lineItem ?? null,
  event_type: o.type ?? "line_item_generated",
  actor_user_id: o.actor ?? null,
  actor_kind: o.actor ? "human" : "system",
  actor_ref: o.actor ? null : "period-history-test",
  created_at: o.at,
  details: o.details ?? {},
});

type Row = { id: string; cells: Record<string, { t: string; v?: string; text: string }> };
type Model = {
  view: string;
  kind: string;
  org: string;
  title: string;
  subtitle?: string;
  entity: { kind: string; id: string };
  links: { id: string; label: string; href: string }[];
  notice?: { tone: string; text: string };
  body: { rows: Row[]; next?: string; empty: { title: string; text?: string } };
};

/** Every page of a history from `href`, following next. */
async function allPages(href: string): Promise<Model[]> {
  const pages: Model[] = [];
  for (let next: string | undefined = href; next && pages.length < 10; ) {
    const res = await view(next);
    expect(res.status).toBe(200);
    const model = (await res.json()) as Model;
    pages.push(model);
    next = model.body.next;
  }
  return pages;
}

let expectedIds: Set<string>;

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const paidAt = new Date().toISOString();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI History Org" }, { id: OTHER_ORG, name: "GUI History Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI History Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI History Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "History site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: SECOND_MICROGRID, community_id: COMMUNITY, name: "Second site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      { id: SCHEDULE, microgrid_id: MICROGRID, tiers: [{ label: "Flat", min_kwh: 0, max_kwh: null, rate_per_kwh: 600 }], service_charge: 0, tax_rate: 0 },
    ],
    [
      "tenants",
      [
        ...[1, 2, 3].map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+25670000090${n}` })),
        { id: tenant(9), microgrid_id: SECOND_MICROGRID, display_name: "Unit 9", primary_phone: "+256700000909" },
        { id: tenant(8), microgrid_id: OTHER_MICROGRID, display_name: "Other unit", primary_phone: "+256700000908" },
      ],
    ],
    [
      "billing_periods",
      [
        { id: DRAFT, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft", rate_schedule_id: SCHEDULE },
        { id: EMPTY, microgrid_id: MICROGRID, start_date: "2026-09-01", end_date: "2026-09-30", timezone: "Africa/Kampala", status: "draft", rate_schedule_id: SCHEDULE },
        { id: OTHER_PERIOD, microgrid_id: OTHER_MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft" },
      ],
    ],
    [
      "billing_line_items",
      [
        billRow(bill(1), DRAFT, tenant(1), { payment_status: "paid", paid_at: paidAt, payment_notes: "Paid at the office" }),
        billRow(bill(2), DRAFT, tenant(2)),
        billRow(bill(3), DRAFT, tenant(3)),
        billRow(bill(8), OTHER_PERIOD, tenant(8)),
      ],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[period-history.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });

  const tie = ["2026-10-31T21:00:00.25+00:00", "2026-10-31T20:00:00+00:00", "2026-10-31T19:00:00.000001+00:00"];
  const audit = [
    auditRow(auditId(1), { type: "period_created", at: "2026-10-01T06:00:00+00:00" }),
    auditRow(auditId(2), {
      lineItem: bill(1),
      actor: manager.userId,
      at: "2026-11-01T09:00:00+00:00",
      details: { tenant_name: "Unit 1", new_total_amount: 30000, new_reading_source: "manual", manual_reason: "Read by hand" },
    }),
    auditRow(auditId(3), {
      type: "line_item_regenerated",
      lineItem: bill(1),
      actor: manager.userId,
      at: "2026-11-02T09:00:00.123456+00:00",
      details: {
        tenant_name: "Unit 1",
        previous_total_amount: 30000,
        new_total_amount: 24000,
        previous_reading_source: "manual",
        new_reading_source: "edge",
        manual_reason: "Corrected",
        period_was_closed: true,
      },
    }),
    // The bill it was written for is gone: the snapshot names the tenant.
    auditRow(auditId(4), { at: "2026-11-03T09:00:00+00:00", details: { tenant_name: "Gone unit", new_total_amount: 100 } }),
    ...Array.from({ length: EXTRA }, (_, n) =>
      auditRow(auditId(0x100 + n), {
        lineItem: n % 2 ? bill(2) : bill(3),
        at: tie[n % 3],
        details: { tenant_name: n % 2 ? "Unit 2" : "Unit 3", new_total_amount: 1000 + n },
      }),
    ),
    // Another organization's period.
    auditRow(auditId(0x900), { period: OTHER_PERIOD, lineItem: bill(8), at: "2026-11-03T09:00:00+00:00", details: { tenant_name: "Other unit" } }),
  ];
  {
    const { error } = await svc.from("billing_audit_log").insert(audit);
    if (error) throw new Error(`[period-history.db] billing_audit_log: ${error.message}`);
  }
  const events = [
    {
      id: eventId(1),
      line_item_id: bill(1),
      from_status: "unpaid",
      to_status: "paid",
      source: "manual",
      actor_user_id: manager.userId,
      actor_kind: "human",
      actor_ref: null,
      raw_payload: { marker: CANARY },
      at: "2026-11-04T10:00:00.5+00:00",
    },
    {
      id: eventId(2),
      line_item_id: bill(1),
      from_status: "unpaid",
      to_status: "link_generated",
      source: "generate_link",
      actor_user_id: null,
      actor_kind: "system",
      actor_ref: "period-history-test",
      raw_payload: { marker: CANARY },
      // At an instant extra audit entries share, so the merge breaks a tie across sources.
      at: tie[1],
    },
  ];
  {
    const { error } = await svc.from("payment_events").insert(events);
    if (error) throw new Error(`[period-history.db] payment_events: ${error.message}`);
  }

  // What the database holds for the period, whatever else wrote to it.
  const [a, p] = await Promise.all([
    svc.from("billing_audit_log").select("id").eq("billing_period_id", DRAFT),
    svc.from("payment_events").select("id").in("line_item_id", [bill(1), bill(2), bill(3)]),
  ]);
  if (a.error || p.error) throw new Error("[period-history.db] could not read the seeded history");
  expectedIds = new Set([
    ...(a.data ?? []).map((r: { id: string }) => `audit:${r.id}`),
    ...(p.data ?? []).map((r: { id: string }) => `payment_event:${r.id}`),
  ]);
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
}, 60_000);

describe.skipIf(shouldSkip())("GET /api/gui/view: a billing period's history", () => {
  it("returns the first page newest first, with actors, snapshot names, the revision mark and a next page", async () => {
    caller = manager;
    await setBilling(true);
    const res = await view(historyHref());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("Other unit");
    const model = JSON.parse(text) as Model;
    expect(model).toMatchObject({
      view: "billing.period-history",
      kind: "collection",
      org: ORG,
      title: "Audit history",
      entity: { kind: "billingPeriod", id: DRAFT },
    });
    expect(model).not.toHaveProperty("notice");
    expect(model.links).toEqual([{ id: "billing.back-to-period", label: "Back to period", href: `/microgrids/${MICROGRID}/billing/${DRAFT}` }]);
    const rows = model.body.rows;
    expect(rows).toHaveLength(200);
    expect(model.body.next).toMatch(/[?&]before=/);
    const times = rows.map((r) => Date.parse(r.cells.at.v!));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(`payment_event:${eventId(1)}`)?.cells).toMatchObject({
      change: { text: "Payment status for Unit 1" },
      detail: { text: "Unpaid → Paid" },
      note: { text: "Paid at the office" },
      by: { text: EMAIL },
    });
    expect(byId.get(`audit:${auditId(4)}`)?.cells.change.text).toBe("Bill generated for Gone unit");
    expect(byId.get(`audit:${auditId(3)}`)?.cells).toMatchObject({
      change: { text: "Bill regenerated for Unit 1" },
      revision: { t: "status", text: "Post-close revision" },
      note: { text: "Corrected" },
    });
    expect(byId.get(`audit:${auditId(3)}`)?.cells.detail.text).toMatch(/ · Source changed from Manual to Edge$/);
    expect(rows.some((r) => r.cells.by.text === "System")).toBe(true);
  });

  it("follows next to the end: every entry once, across ties and both sources", async () => {
    caller = manager;
    const pages = await allPages(historyHref());
    expect(pages.length).toBe(Math.ceil(expectedIds.size / 200));
    const ids = pages.flatMap((p) => p.body.rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(expectedIds);
    expect(pages.at(-1)!.body).not.toHaveProperty("next");
    // A later page leads back to the latest changes.
    expect(pages[1].links.map((l) => l.id)).toEqual(["billing.back-to-period", "billing.history-latest"]);
    expect(ids.at(-1)).toBe(`audit:${auditId(1)}`);
  });

  it("opens the period review's View history link for a tenant on that tenant's entries", async () => {
    caller = manager;
    const review = await view(`/microgrids/${MICROGRID}/billing/${DRAFT}`);
    expect(review.status).toBe(200);
    const reviewModel = await review.json();
    const row = (reviewModel.body.rows as { id: string; links: { id: string; href: string }[] }[]).find((r) => r.id === bill(1))!;
    const href = row.links.find((l) => l.id === "billing.view-history")!.href;
    expect(href).toBe(`${historyHref()}?tenant_id=${tenant(1)}`);
    const pages = await allPages(href);
    expect(pages).toHaveLength(1);
    const [model] = pages;
    expect(model.subtitle).toMatch(/ · Showing changes for Unit 1$/);
    expect(model.links.map((l) => [l.id, l.href])).toEqual([
      ["billing.back-to-period", `/microgrids/${MICROGRID}/billing/${DRAFT}`],
      ["billing.history-show-all", historyHref()],
    ]);
    expect(model.body.rows.map((r) => r.id).sort()).toEqual(
      [`audit:${auditId(2)}`, `audit:${auditId(3)}`, `payment_event:${eventId(1)}`, `payment_event:${eventId(2)}`].sort(),
    );
    // The review's header link is the unfiltered history.
    expect(reviewModel.links.find((l: { id: string }) => l.id === "billing.view-history").href).toBe(historyHref());
  });

  it.each([
    ["another microgrid's", 9, "Unit 9"],
    ["another organization's", 8, "Other unit"],
  ])("names no tenant of %s, and shows none of its entries", async (_what, n, name) => {
    caller = manager;
    const res = await view(`${historyHref()}?tenant_id=${tenant(n)}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(name);
    const model = JSON.parse(text) as Model;
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty.title).toBe("No changes recorded for unknown tenant");
  });

  it("answers a tenant id that is not a UUID with the unknown tenant, not an error", async () => {
    caller = manager;
    const res = await view(`${historyHref()}?tenant_id=not-a-uuid`);
    expect(res.status).toBe(200);
    const model = (await res.json()) as Model;
    expect(model.body.rows).toEqual([]);
    expect(model.subtitle).toMatch(/ · Showing changes for unknown tenant$/);
    expect(JSON.stringify(model)).not.toContain("not-a-uuid");
  });

  it("answers a cursor with a date Postgres refuses with the first page, not an error", async () => {
    caller = manager;
    // Date.parse rolls 30 February over into March; the database refuses it.
    const res = await view(`${historyHref()}?before=${encodeURIComponent(`a~${auditId(1)}~2026-02-30T00:00:00Z`)}`);
    expect(res.status).toBe(200);
    const model = (await res.json()) as Model;
    const first = (await (await view(historyHref())).json()) as Model;
    expect(model.body.rows.map((r) => r.id)).toEqual(first.body.rows.map((r) => r.id));
    expect(model.links.map((l) => l.id)).toEqual(["billing.back-to-period"]);
  });

  it("shows a period with no entries as empty", async () => {
    caller = manager;
    const res = await view(historyHref(EMPTY));
    expect(res.status).toBe(200);
    const model = (await res.json()) as Model;
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty.title).toBe("No changes recorded yet");
  });

  it("gives another organization's manager nothing", async () => {
    caller = other;
    const res = await view(historyHref());
    expect([403, 404]).toContain(res.status);
    const text = await res.text();
    for (const leak of ["Unit 1", "History site", "Gone unit", EMAIL]) expect(text).not.toContain(leak);
  });

  it("gives a tenant nothing, their own bill's period included", async () => {
    caller = tenantUser;
    const res = await view(`${historyHref()}?tenant_id=${tenant(1)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Unit 1");
  });

  it.each([
    ["the same organization's", SECOND_MICROGRID],
    ["another organization's", OTHER_MICROGRID],
  ])("finds no period under %s other microgrid", async (_what, microgrid) => {
    caller = manager;
    const res = await view(historyHref(DRAFT, microgrid));
    expect(res.status).toBe(404);
  });

  it("still loads while billing is off, with the gate's notice", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const res = await view(historyHref());
      expect(res.status).toBe(200);
      const model = (await res.json()) as Model;
      expect(model.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("Billing is disabled") });
      expect(model.body.rows.length).toBeGreaterThan(0);
    } finally {
      await setBilling(true);
    }
  });
});

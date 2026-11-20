/**
 * GET /api/gui/view serves Today (`org.today`, the home page on "/") and its
 * billing tile (`billing.current-periods`, /billing) through the host
 * against the local database. The host collects the organization's signals
 * with the caller's own session before Today's loader runs, and lists the
 * tile with the organization Today loaded in. An organization's manager
 * sees its overdue period and its microgrid's newest period; another
 * organization's manager, asking for this organization, gets their own and
 * none of these; a person whose rows are all tenant rows gets the answer a
 * missing page gets, with nothing of the organization. While billing is off
 * Today shows neither billing's signal nor its tile. Nothing here calls out:
 * every request goes to the local Supabase.
 *
 * In the browser the (gui) catch-all serves "/" through the same view (its
 * catalog page is `servedBy: "view"`), which the 360 px smoke
 * (e2e/narrow.spec.ts) opens; the catch-all sends a tenant-only person to
 * their home first (tenant-only-pages.test.tsx).
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  mintServiceRoleJwt,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import { addDaysToDateKey, dayKeyInZone } from "@/lib/timezone/day-key";

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[today.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e8800000-0000-4000-8000-000000000001";
const OTHER_ORG = "e8800000-0000-4000-8000-000000000002";
const COMMUNITY = "e8800000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e8800000-0000-4000-8001-000000000002";
const MICROGRID = "e8800000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e8800000-0000-4000-8002-000000000002";
const SCHEDULE = "e8800000-0000-4000-8006-000000000001";
const OTHER_SCHEDULE = "e8800000-0000-4000-8006-000000000002";
/** Ended, no bills: billing's watcher reports it. */
const SEPTEMBER = "e8800000-0000-4000-8003-000000000001";
/** Still running: the microgrid's newest period, which the tile shows. */
const CURRENT = "e8800000-0000-4000-8003-000000000002";
const OTHER_PERIOD = "e8800000-0000-4000-8003-000000000003";
const TENANT = "e8800000-0000-4000-8004-000000000001";
const EMAIL = "gui-today-manager@test.local";
const OTHER_EMAIL = "gui-today-other@test.local";
const TENANT_EMAIL = "gui-today-tenant@test.local";

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;
let fetchSpy: { mock: { calls: Parameters<typeof fetch>[] }; mockRestore(): void };

type Model = {
  view: string;
  org: string;
  title: string;
  notice?: { text: string };
  attached: { view: string; href: string; hint: string }[];
  body: { rows: { id: string; href?: string; cells: Record<string, { text: string }> }[]; empty: { title: string } };
};

const view = (href: string) =>
  GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(href)}`, { headers: { "accept-language": "en-GB" } }));
async function load(href: string): Promise<{ model: Model; text: string }> {
  const res = await view(href);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return { model: JSON.parse(text) as Model, text };
}

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[today.db] mgm_plugins: ${error.message}`);
}

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Payments' watchers compose the Payments capability, whose repository is
  // built with a service-role client (src/lib/payments/compose.ts) from
  // these names (src/lib/supabase/service.ts), as signals.db.test.ts sets
  // them; if either file reads other names, revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  fetchSpy = vi.spyOn(globalThis, "fetch");
  await cleanup();
  const today = dayKeyInZone(new Date(), "Africa/Kampala");
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Today Org" }, { id: OTHER_ORG, name: "GUI Today Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Today Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Today Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Today site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other today site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      [
        { id: SCHEDULE, microgrid_id: MICROGRID, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 },
        { id: OTHER_SCHEDULE, microgrid_id: OTHER_MICROGRID, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 },
      ],
    ],
    ["tenants", { id: TENANT, microgrid_id: MICROGRID, display_name: "Nakato Today-Canary", primary_phone: "+256700000911" }],
    [
      "billing_periods",
      [
        { id: SEPTEMBER, microgrid_id: MICROGRID, start_date: "2026-09-01", end_date: "2026-09-30", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE },
        {
          id: CURRENT,
          microgrid_id: MICROGRID,
          start_date: addDaysToDateKey(today, -2),
          end_date: addDaysToDateKey(today, 20),
          status: "draft",
          timezone: "Africa/Kampala",
          rate_schedule_id: SCHEDULE,
        },
        { id: OTHER_PERIOD, microgrid_id: OTHER_MICROGRID, start_date: "2026-09-01", end_date: "2026-09-30", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: OTHER_SCHEDULE },
      ],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[today.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: TENANT });
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
  fetchSpy?.mockRestore();
  vi.unstubAllEnvs();
}, 120_000);

const TILE = (org: string) => ({ view: "billing.current-periods", title: "Current billing periods", href: `/billing?org=${org}`, hint: "tile" });

describe.skipIf(shouldSkip())("Today through GET /api/gui/view against the database", () => {
  it("gives the organization's manager its signals and its billing tile", async () => {
    caller = manager;
    const { model, text } = await load(`/?org=${ORG}`);
    expect(model).toMatchObject({ view: "org.today", org: ORG, title: "Today" });
    expect(model.notice).toBeUndefined();
    const due = model.body.rows.find((r) => r.id === `billing.period-due:${SEPTEMBER}`);
    expect(due).toMatchObject({ href: `/microgrids/${MICROGRID}/billing/${SEPTEMBER}`, cells: { title: { text: "Today site: September 2026 has no bills" } } });
    // The period still running is not due.
    expect(text).not.toContain(CURRENT);
    expect(model.attached).toEqual([TILE(ORG)]);
    for (const id of [OTHER_ORG, OTHER_MICROGRID, OTHER_PERIOD, "Nakato Today-Canary"]) expect(text, id).not.toContain(id);

    const tile = await load(model.attached[0].href);
    expect(tile.model).toMatchObject({ view: "billing.current-periods", org: ORG });
    expect(tile.model.body.rows.map((r) => [r.id, r.href, r.cells.status.text])).toEqual([
      [MICROGRID, `/microgrids/${MICROGRID}/billing/${CURRENT}`, "Draft"],
    ]);
    for (const id of [OTHER_MICROGRID, OTHER_PERIOD, "Nakato Today-Canary"]) expect(tile.text, id).not.toContain(id);
    // Every request went to the local Supabase.
    expect(fetchSpy.mock.calls.every(([input]) => String(input instanceof Request ? input.url : input).startsWith(LOCAL_SUPABASE_URL))).toBe(true);
  });

  it("gives another organization's manager, asking for this organization, their own and none of these", async () => {
    caller = other;
    const { model, text } = await load(`/?org=${ORG}`);
    expect(model.org).toBe(OTHER_ORG);
    expect(model.body.rows.map((r) => r.id)).toEqual([`billing.period-due:${OTHER_PERIOD}`]);
    expect(model.attached).toEqual([TILE(OTHER_ORG)]);
    for (const id of [ORG, MICROGRID, SEPTEMBER, CURRENT]) expect(text, id).not.toContain(id);

    const tile = await load(`/billing?org=${ORG}`);
    expect(tile.model.org).toBe(OTHER_ORG);
    expect(tile.model.body.rows.map((r) => r.id)).toEqual([OTHER_MICROGRID]);
    for (const id of [ORG, MICROGRID, SEPTEMBER, CURRENT]) expect(tile.text, id).not.toContain(id);
  });

  it("answers a person whose rows are all tenant rows as a missing page, with nothing of the organization", async () => {
    caller = tenantUser;
    for (const href of ["/", `/?org=${ORG}`, `/billing?org=${ORG}`]) {
      const res = await view(href);
      expect(res.status, href).toBe(404);
      const text = await res.text();
      for (const id of [ORG, MICROGRID, SEPTEMBER, CURRENT]) expect(text, id).not.toContain(id);
    }
  });

  it("shows neither billing's signal nor its tile while billing is off", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const { model, text } = await load(`/?org=${ORG}`);
      expect(model.org).toBe(ORG);
      expect(text).not.toContain(SEPTEMBER);
      expect(model.attached).toEqual([]);
      expect(model.body.empty.title).toBe("Nothing needs you right now.");
    } finally {
      await setBilling(true);
    }
  });
});

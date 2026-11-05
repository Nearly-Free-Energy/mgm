/**
 * billing_period_delete_guard.test.ts (migrations 20261103090100 and
 * 20261103160000)
 *
 * Verifies the BEFORE DELETE guard on billing_periods against a live local
 * Supabase through PostgREST, as an org manager except where noted (the
 * service_role case and the organization delete run as service_role):
 *   - a draft period with no payment activity can be deleted (its line
 *     items go with it);
 *   - a closed period is kept;
 *   - a draft period with a paid line item is kept;
 *   - a draft period with a payment attempt is kept;
 *   - a draft period with a payment event is kept;
 *   - service_role is held to the same rule;
 *   - deleting the microgrid (fn_entity_delete_microgrid) or the organization
 *     is refused while it holds a closed period, and its periods and payment
 *     records stay (20261103160000).
 *
 * keep_closed_and_paid_billing.test.ts covers the rest of 20261103160000.
 *
 * Self-fixturing; honors `SKIP_RLS_TESTS=1` for runs without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[billing_period_delete_guard] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  org: "b0d00000-0000-4000-8000-00000000000a",
  community: "b0d00000-0000-4000-8001-00000000000a",
  // mgKeep holds the periods deleted one at a time; mgParent is the
  // microgrid a whole-microgrid delete is tried on.
  mgKeep: "b0d00000-0000-4000-8002-00000000000a",
  mgParent: "b0d00000-0000-4000-8002-00000000000b",
  hhKeep: "b0d00000-0000-4000-8005-00000000000a",
  hhParent: "b0d00000-0000-4000-8005-00000000000b",
  merchant: "b0d00000-0000-4000-8008-00000000000a",

  periodDraftEmpty: "b0d00000-0000-4000-8006-000000000001",
  periodClosed: "b0d00000-0000-4000-8006-000000000002",
  periodDraftPaid: "b0d00000-0000-4000-8006-000000000003",
  periodDraftAttempt: "b0d00000-0000-4000-8006-000000000004",
  periodDraftEvent: "b0d00000-0000-4000-8006-000000000005",
  periodParentClosed: "b0d00000-0000-4000-8006-000000000006",

  lineDraftEmpty: "b0d00000-0000-4000-8007-000000000001",
  lineClosed: "b0d00000-0000-4000-8007-000000000002",
  lineDraftPaid: "b0d00000-0000-4000-8007-000000000003",
  lineDraftAttempt: "b0d00000-0000-4000-8007-000000000004",
  lineDraftEvent: "b0d00000-0000-4000-8007-000000000005",
  lineParentClosed: "b0d00000-0000-4000-8007-000000000006",

  attemptKeep: "b0d00000-0000-4000-8009-000000000004",
  attemptParent: "b0d00000-0000-4000-8009-000000000006",

  // A second organization, which the last test tries to delete whole.
  orgParent: "b0d00000-0000-4000-8000-00000000000b",
  communityOrgParent: "b0d00000-0000-4000-8001-00000000000b",
  mgOrgParent: "b0d00000-0000-4000-8002-00000000000c",
  periodOrgParentClosed: "b0d00000-0000-4000-8006-000000000007",
};

const EMAIL_ORG_MANAGER = `bpdg-orgmgr-${Date.now()}@test.local`;

let manager: TestUser;

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(
      `[billing_period_delete_guard] fixture insert failed on ${table}: ${error.message}`,
    );
  }
}

async function periodExists(id: string): Promise<boolean> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_periods").select("id").eq("id", id);
  if (error) throw new Error(error.message);
  return (data ?? []).length === 1;
}

function period(id: string, microgridId: string, month: string, status: "draft" | "closed") {
  const [year, mm] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return {
    id,
    microgrid_id: microgridId,
    start_date: `${month}-01`,
    end_date: `${month}-${String(lastDay).padStart(2, "0")}`,
    status,
    closed_at: status === "closed" ? new Date().toISOString() : null,
  };
}

function lineItem(
  id: string,
  periodId: string,
  householdId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    billing_period_id: periodId,
    household_id: householdId,
    usage_kwh: 10,
    total_amount: 5000,
    // Spelled out on every row: a multi-row PostgREST insert sends the union
    // of the rows' keys, so a key missing from one row arrives as NULL.
    payment_status: "unpaid",
    paid_at: null,
    ...extra,
  };
}

// Removes this file's fixture organizations. payment_merchant_versions
// references organizations without ON DELETE CASCADE, so its rows go first;
// otherwise the organization delete in cleanupTestData fails and the fixed
// fixture ids collide on the next run. If that foreign key gains a cascade,
// the first delete becomes a no-op. Both organizations hold closed periods,
// so cleanupTestData purges them as the database owner.
async function cleanupFixtures(): Promise<void> {
  const svc = await serviceClient();
  const { error } = await svc
    .from("payment_merchant_versions")
    .delete()
    .in("org_id", [FIXTURE.org, FIXTURE.orgParent]);
  if (error) {
    throw new Error(`[billing_period_delete_guard] cleanup failed: ${error.message}`);
  }
  await cleanupTestData({
    orgIds: [FIXTURE.org, FIXTURE.orgParent],
    userEmails: [EMAIL_ORG_MANAGER],
  });
}

desc("20261103090100_billing_period_delete_guard.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: FIXTURE.org, name: "Delete Guard Org" },
      { id: FIXTURE.orgParent, name: "Delete Guard Org (parent)" },
    ]);
    await insertOrThrow(svc, "communities", [
      { id: FIXTURE.community, org_id: FIXTURE.org, name: "DG Comm" },
      { id: FIXTURE.communityOrgParent, org_id: FIXTURE.orgParent, name: "DG Comm (parent org)" },
    ]);
    await insertOrThrow(svc, "microgrids", [
      { id: FIXTURE.mgKeep, community_id: FIXTURE.community, name: "DG MG keep", currency: "UGX" },
      { id: FIXTURE.mgParent, community_id: FIXTURE.community, name: "DG MG parent", currency: "UGX" },
      { id: FIXTURE.mgOrgParent, community_id: FIXTURE.communityOrgParent, name: "DG MG org", currency: "UGX" },
    ]);
    await insertOrThrow(svc, "households", [
      {
        id: FIXTURE.hhKeep,
        microgrid_id: FIXTURE.mgKeep,
        display_name: "DG Household keep",
        primary_phone: "+256700000001",
      },
      {
        id: FIXTURE.hhParent,
        microgrid_id: FIXTURE.mgParent,
        display_name: "DG Household parent",
        primary_phone: "+256700000002",
      },
    ]);

    await insertOrThrow(svc, "billing_periods", [
      period(FIXTURE.periodDraftEmpty, FIXTURE.mgKeep, "2026-01", "draft"),
      period(FIXTURE.periodClosed, FIXTURE.mgKeep, "2026-02", "closed"),
      period(FIXTURE.periodDraftPaid, FIXTURE.mgKeep, "2026-03", "draft"),
      period(FIXTURE.periodDraftAttempt, FIXTURE.mgKeep, "2026-04", "draft"),
      period(FIXTURE.periodDraftEvent, FIXTURE.mgKeep, "2026-05", "draft"),
      period(FIXTURE.periodParentClosed, FIXTURE.mgParent, "2026-01", "closed"),
      period(FIXTURE.periodOrgParentClosed, FIXTURE.mgOrgParent, "2026-01", "closed"),
    ]);

    await insertOrThrow(svc, "billing_line_items", [
      lineItem(FIXTURE.lineDraftEmpty, FIXTURE.periodDraftEmpty, FIXTURE.hhKeep),
      lineItem(FIXTURE.lineClosed, FIXTURE.periodClosed, FIXTURE.hhKeep),
      lineItem(FIXTURE.lineDraftPaid, FIXTURE.periodDraftPaid, FIXTURE.hhKeep, {
        payment_status: "paid",
        paid_at: new Date().toISOString(),
      }),
      lineItem(FIXTURE.lineDraftAttempt, FIXTURE.periodDraftAttempt, FIXTURE.hhKeep),
      lineItem(FIXTURE.lineDraftEvent, FIXTURE.periodDraftEvent, FIXTURE.hhKeep),
      lineItem(FIXTURE.lineParentClosed, FIXTURE.periodParentClosed, FIXTURE.hhParent, {
        payment_status: "paid",
        paid_at: new Date().toISOString(),
      }),
    ]);

    // Merchant account first: the payment_account_snapshot trigger writes the
    // version row that payment_attempt_scope requires.
    await insertOrThrow(svc, "payment_merchant_accounts", {
      id: FIXTURE.merchant,
      org_id: FIXTURE.org,
      display_name: "DG merchant",
    });
    await insertOrThrow(svc, "payment_attempts", [
      {
        id: FIXTURE.attemptKeep,
        org_id: FIXTURE.org,
        line_item_id: FIXTURE.lineDraftAttempt,
        community_id: FIXTURE.community,
        merchant_account_id: FIXTURE.merchant,
        merchant_account_version: 1,
        amount: 5000,
        merchant_reference: `DG-${FIXTURE.attemptKeep}`,
      },
      {
        id: FIXTURE.attemptParent,
        org_id: FIXTURE.org,
        line_item_id: FIXTURE.lineParentClosed,
        community_id: FIXTURE.community,
        merchant_account_id: FIXTURE.merchant,
        merchant_account_version: 1,
        amount: 5000,
        merchant_reference: `DG-${FIXTURE.attemptParent}`,
      },
    ]);
    await insertOrThrow(svc, "payment_events", {
      line_item_id: FIXTURE.lineDraftEvent,
      from_status: "unpaid",
      to_status: "link_generated",
      source: "generate_link",
      actor_kind: "system",
      actor_ref: "billing_period_delete_guard_test",
    });

    manager = await createTestUser({
      email: EMAIL_ORG_MANAGER,
      role: "org_manager",
      scopeId: FIXTURE.org,
    });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 30_000);

  it("an org manager can delete a draft period with no payment activity", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .delete()
      .eq("id", FIXTURE.periodDraftEmpty);
    expect(error).toBeNull();
    expect(await periodExists(FIXTURE.periodDraftEmpty)).toBe(false);

    const svc = await serviceClient();
    const { data: lines } = await svc
      .from("billing_line_items")
      .select("id")
      .eq("id", FIXTURE.lineDraftEmpty);
    expect(lines ?? []).toHaveLength(0);
  });

  it("an org manager cannot delete a closed period", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .delete()
      .eq("id", FIXTURE.periodClosed);
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/^billing_period_kept/);
    expect(error?.details).toBe("closed");
    expect(await periodExists(FIXTURE.periodClosed)).toBe(true);
  });

  it("an org manager cannot delete a draft period with a paid line item", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .delete()
      .eq("id", FIXTURE.periodDraftPaid);
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/^billing_period_kept/);
    expect(error?.details).toBe("payment_activity");
    expect(await periodExists(FIXTURE.periodDraftPaid)).toBe(true);
  });

  it("an org manager cannot delete a draft period with a payment attempt", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .delete()
      .eq("id", FIXTURE.periodDraftAttempt);
    expect(error?.code).toBe("23514");
    expect(error?.details).toBe("payment_activity");
    expect(await periodExists(FIXTURE.periodDraftAttempt)).toBe(true);

    const svc = await serviceClient();
    const { data: attempts } = await svc
      .from("payment_attempts")
      .select("id")
      .eq("id", FIXTURE.attemptKeep);
    expect(attempts ?? []).toHaveLength(1);
  });

  it("an org manager cannot delete a draft period with a payment event", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .delete()
      .eq("id", FIXTURE.periodDraftEvent);
    expect(error?.code).toBe("23514");
    expect(error?.details).toBe("payment_activity");
    expect(await periodExists(FIXTURE.periodDraftEvent)).toBe(true);
  });

  it("service_role is held to the same rule", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("billing_periods")
      .delete()
      .eq("id", FIXTURE.periodClosed);
    expect(error?.code).toBe("23514");
    expect(await periodExists(FIXTURE.periodClosed)).toBe(true);
  });

  it("deleting the microgrid is refused while it holds a closed period, and its payment records stay", async () => {
    const { data, error } = await manager.client.rpc("fn_entity_delete_microgrid", {
      p_id: FIXTURE.mgParent,
    });
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/^billing_period_kept/);
    expect(error?.details).toBe("closed");
    expect(data).toBeNull();
    expect(await periodExists(FIXTURE.periodParentClosed)).toBe(true);

    const svc = await serviceClient();
    const { data: attempts } = await svc
      .from("payment_attempts")
      .select("id")
      .eq("id", FIXTURE.attemptParent);
    expect(attempts ?? []).toHaveLength(1);
  });

  it("deleting the organization is refused while it holds a closed period", async () => {
    const svc = await serviceClient();
    const { error } = await svc.from("organizations").delete().eq("id", FIXTURE.orgParent);
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/^billing_period_kept/);
    expect(error?.details).toBe("closed");
    expect(await periodExists(FIXTURE.periodOrgParentClosed)).toBe(true);
  });
});

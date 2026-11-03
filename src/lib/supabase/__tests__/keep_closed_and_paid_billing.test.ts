/**
 * keep_closed_and_paid_billing.test.ts (migration 20261103160000)
 *
 * Verifies, against a live local Supabase through PostgREST, that closed
 * billing and billing with payment activity are kept whichever row a delete
 * names, and that closed periods stay closed. As an org manager except where
 * noted:
 *   - fn_entity_delete_microgrid, fn_entity_delete_community and
 *     fn_entity_delete_org (as a super admin) are refused while the entity
 *     holds a closed period or a period with payment activity, including an
 *     organization whose only payment activity is a payment attempt;
 *   - a direct microgrid delete, and a service_role organization delete, are
 *     refused the same way;
 *   - a microgrid or community whose only billing is unpaid drafts can still
 *     be deleted;
 *   - a bill in a closed period, a paid bill, and a household with a bill in
 *     a closed period cannot be deleted, while an unpaid bill in a draft can;
 *   - a closed period cannot be reopened, by service_role either, while a
 *     resend of its status and a post-close bill regeneration
 *     (fn_record_line_item_with_audit) still work;
 *   - TRUNCATE is refused for the database owner too, directly and through a
 *     parent table's CASCADE, and the API roles hold no TRUNCATE privilege;
 *   - the delete preview's counts (countEntityDescendants, through the
 *     caller's RLS) see the kept billing, and the meter readings an edge
 *     delete would remove from a closed period.
 *
 * billing_period_delete_guard.test.ts covers the direct period deletes.
 * The TRUNCATE cases run as the database owner (runAsDatabaseOwner).
 *
 * Self-fixturing; honors `SKIP_RLS_TESTS=1` for runs without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countEntityDescendants } from "@/lib/entity-descendants";
import { startOfDayInZone } from "@/lib/timezone/day-key";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
  runAsDatabaseOwner,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[keep_closed_and_paid_billing] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  // The org manager's organization.
  org: "cb11ed00-0000-4000-8000-00000000000a",
  // commKeep holds mgClosed, mgPaid and mgDraft; commDraft holds only an
  // unpaid draft.
  commKeep: "cb11ed00-0000-4000-8001-00000000000a",
  commDraft: "cb11ed00-0000-4000-8001-00000000000b",
  mgClosed: "cb11ed00-0000-4000-8002-00000000000a",
  mgPaid: "cb11ed00-0000-4000-8002-00000000000b",
  mgDraft: "cb11ed00-0000-4000-8002-00000000000c",
  mgDraftInComm: "cb11ed00-0000-4000-8002-00000000000d",
  rateClosed: "cb11ed00-0000-4000-8003-00000000000a",
  // An edge with one meter on mgClosed, for the readings count.
  edgeClosed: "cb11ed00-0000-4000-8004-00000000000a",
  deviceClosed: "cb11ed00-0000-4000-8004-00000000001a",

  hhClosed: "cb11ed00-0000-4000-8005-00000000000a",
  hhPaid: "cb11ed00-0000-4000-8005-00000000000b",
  hhUnpaid: "cb11ed00-0000-4000-8005-00000000000c",
  hhDraft: "cb11ed00-0000-4000-8005-00000000000d",
  hhDraftInComm: "cb11ed00-0000-4000-8005-00000000000e",

  periodClosed: "cb11ed00-0000-4000-8006-00000000000a",
  periodPaid: "cb11ed00-0000-4000-8006-00000000000b",
  periodDraft: "cb11ed00-0000-4000-8006-00000000000c",
  periodDraftInComm: "cb11ed00-0000-4000-8006-00000000000d",

  billClosed: "cb11ed00-0000-4000-8007-00000000000a",
  billPaid: "cb11ed00-0000-4000-8007-00000000000b",
  billUnpaid: "cb11ed00-0000-4000-8007-00000000000c",
  billDraft: "cb11ed00-0000-4000-8007-00000000000d",
  billDraftInComm: "cb11ed00-0000-4000-8007-00000000000e",

  // A second organization whose only payment activity is a payment attempt
  // on an unpaid bill in a draft period. Deleting an organization removes
  // its payment attempts through payment_attempts.org_id before the cascade
  // reaches its periods, which the organization guard has to see past.
  orgAttempt: "cb11ed00-0000-4000-8000-00000000000b",
  commAttempt: "cb11ed00-0000-4000-8001-00000000000c",
  mgAttempt: "cb11ed00-0000-4000-8002-00000000000e",
  hhAttempt: "cb11ed00-0000-4000-8005-00000000000f",
  periodAttempt: "cb11ed00-0000-4000-8006-00000000000e",
  billAttempt: "cb11ed00-0000-4000-8007-00000000000f",
  merchantAttempt: "cb11ed00-0000-4000-8008-00000000000b",
  attempt: "cb11ed00-0000-4000-8009-00000000000b",
};

const EMAIL_ORG_MANAGER = `kcpb-orgmgr-${Date.now()}@test.local`;
const EMAIL_SUPER_ADMIN = `kcpb-super-${Date.now()}@test.local`;

let manager: TestUser;
let superAdmin: TestUser;

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(
      `[keep_closed_and_paid_billing] fixture insert failed on ${table}: ${error.message}`,
    );
  }
}

async function exists(table: string, id: string): Promise<boolean> {
  const svc = await serviceClient();
  const { data, error } = await svc.from(table).select("id").eq("id", id);
  if (error) throw new Error(error.message);
  return (data ?? []).length === 1;
}

async function periodStatus(id: string): Promise<string | undefined> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_periods").select("status").eq("id", id);
  if (error) throw new Error(error.message);
  return (data?.[0] as { status: string } | undefined)?.status;
}

function period(id: string, microgridId: string, status: "draft" | "closed") {
  return {
    id,
    microgrid_id: microgridId,
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    status,
    closed_at: status === "closed" ? new Date().toISOString() : null,
  };
}

function bill(
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

/** The refusal the billing retention guards raise. */
function expectKept(
  error: { code?: string; message?: string; details?: string } | null,
  details: "closed" | "payment_activity",
  messageStart = "billing_period_kept",
) {
  expect(error?.code).toBe("23514");
  expect(error?.message?.startsWith(messageStart)).toBe(true);
  expect(error?.details).toBe(details);
}

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first; otherwise an organization left behind
// without kept billing would fail to delete and collide with the next run's
// fixed ids. Both organizations hold kept billing at the end of a run, so
// cleanupTestData purges them as the database owner.
async function cleanupFixtures(): Promise<void> {
  const svc = await serviceClient();
  const { error } = await svc
    .from("payment_merchant_versions")
    .delete()
    .in("org_id", [FIXTURE.org, FIXTURE.orgAttempt]);
  if (error) {
    throw new Error(`[keep_closed_and_paid_billing] cleanup failed: ${error.message}`);
  }
  await cleanupTestData({
    orgIds: [FIXTURE.org, FIXTURE.orgAttempt],
    userEmails: [EMAIL_ORG_MANAGER, EMAIL_SUPER_ADMIN],
  });
}

desc("20261103160000_keep_closed_and_paid_billing.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: FIXTURE.org, name: "Keep Billing Org" },
      { id: FIXTURE.orgAttempt, name: "Keep Billing Org (attempt)" },
    ]);
    await insertOrThrow(svc, "communities", [
      { id: FIXTURE.commKeep, org_id: FIXTURE.org, name: "KB Comm keep" },
      { id: FIXTURE.commDraft, org_id: FIXTURE.org, name: "KB Comm draft" },
      { id: FIXTURE.commAttempt, org_id: FIXTURE.orgAttempt, name: "KB Comm attempt" },
    ]);
    // East of UTC, so the readings window cannot pass by reading the dates as
    // UTC. Inserted on its own: a multi-row insert sends the union of the
    // rows' keys, and the other microgrids keep the default timezone.
    await insertOrThrow(svc, "microgrids", {
      id: FIXTURE.mgClosed,
      community_id: FIXTURE.commKeep,
      name: "KB MG closed",
      currency: "UGX",
      timezone: "Africa/Kampala",
    });
    await insertOrThrow(svc, "microgrids", [
      { id: FIXTURE.mgPaid, community_id: FIXTURE.commKeep, name: "KB MG paid", currency: "UGX" },
      { id: FIXTURE.mgDraft, community_id: FIXTURE.commKeep, name: "KB MG draft", currency: "UGX" },
      {
        id: FIXTURE.mgDraftInComm,
        community_id: FIXTURE.commDraft,
        name: "KB MG draft in comm",
        currency: "UGX",
      },
      {
        id: FIXTURE.mgAttempt,
        community_id: FIXTURE.commAttempt,
        name: "KB MG attempt",
        currency: "UGX",
      },
    ]);
    // Before the closed period, which pins it on insert: the regeneration
    // test writes a bill against that pinned tariff.
    await insertOrThrow(svc, "rate_schedules", {
      id: FIXTURE.rateClosed,
      microgrid_id: FIXTURE.mgClosed,
      tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }],
      service_charge: 0,
      tax_rate: 0,
    });
    await insertOrThrow(svc, "households", [
      { id: FIXTURE.hhClosed, microgrid_id: FIXTURE.mgClosed, display_name: "KB closed", primary_phone: "+256700000301" },
      { id: FIXTURE.hhPaid, microgrid_id: FIXTURE.mgPaid, display_name: "KB paid", primary_phone: "+256700000302" },
      { id: FIXTURE.hhUnpaid, microgrid_id: FIXTURE.mgPaid, display_name: "KB unpaid", primary_phone: "+256700000303" },
      { id: FIXTURE.hhDraft, microgrid_id: FIXTURE.mgDraft, display_name: "KB draft", primary_phone: "+256700000304" },
      {
        id: FIXTURE.hhDraftInComm,
        microgrid_id: FIXTURE.mgDraftInComm,
        display_name: "KB draft in comm",
        primary_phone: "+256700000305",
      },
      { id: FIXTURE.hhAttempt, microgrid_id: FIXTURE.mgAttempt, display_name: "KB attempt", primary_phone: "+256700000306" },
    ]);
    await insertOrThrow(svc, "billing_periods", [
      period(FIXTURE.periodClosed, FIXTURE.mgClosed, "closed"),
      period(FIXTURE.periodPaid, FIXTURE.mgPaid, "draft"),
      period(FIXTURE.periodDraft, FIXTURE.mgDraft, "draft"),
      period(FIXTURE.periodDraftInComm, FIXTURE.mgDraftInComm, "draft"),
      period(FIXTURE.periodAttempt, FIXTURE.mgAttempt, "draft"),
    ]);
    await insertOrThrow(svc, "billing_line_items", [
      bill(FIXTURE.billClosed, FIXTURE.periodClosed, FIXTURE.hhClosed),
      bill(FIXTURE.billPaid, FIXTURE.periodPaid, FIXTURE.hhPaid, {
        payment_status: "paid",
        paid_at: new Date().toISOString(),
      }),
      bill(FIXTURE.billUnpaid, FIXTURE.periodPaid, FIXTURE.hhUnpaid),
      bill(FIXTURE.billDraft, FIXTURE.periodDraft, FIXTURE.hhDraft),
      bill(FIXTURE.billDraftInComm, FIXTURE.periodDraftInComm, FIXTURE.hhDraftInComm),
      bill(FIXTURE.billAttempt, FIXTURE.periodAttempt, FIXTURE.hhAttempt),
    ]);

    await insertOrThrow(svc, "edges", {
      id: FIXTURE.edgeClosed,
      microgrid_id: FIXTURE.mgClosed,
      name: "KB Edge closed",
      openems_edge_id: "kb-edge-closed",
    });
    await insertOrThrow(svc, "devices", {
      id: FIXTURE.deviceClosed,
      edge_id: FIXTURE.edgeClosed,
      name: "KB Meter closed",
      device_type: "consumption_meter",
      openems_component_id: "kb-meter-closed",
    });
    // periodClosed covers 2026-01-01 to 2026-01-31 in Africa/Kampala (UTC+3).
    // Its opening register, one reading inside, and its closing register at
    // the start of 2026-02-01 count. The reading a second before it opens,
    // and one in March, do not.
    const opening = startOfDayInZone("2026-01-01", "Africa/Kampala");
    const closing = startOfDayInZone("2026-02-01", "Africa/Kampala");
    await insertOrThrow(
      svc,
      "meter_readings",
      [
        new Date(opening.getTime() - 1000),
        opening,
        new Date("2026-01-15T09:00:00Z"),
        closing,
        new Date("2026-03-10T09:00:00Z"),
      ].map((readAt, i) => ({
        device_id: FIXTURE.deviceClosed,
        reading_kwh: 100 + i,
        read_at: readAt.toISOString(),
      })),
    );

    // Merchant account first: the payment_account_snapshot trigger writes the
    // version row that payment_attempt_scope requires.
    await insertOrThrow(svc, "payment_merchant_accounts", {
      id: FIXTURE.merchantAttempt,
      org_id: FIXTURE.orgAttempt,
      display_name: "KB merchant",
    });
    await insertOrThrow(svc, "payment_attempts", {
      id: FIXTURE.attempt,
      org_id: FIXTURE.orgAttempt,
      line_item_id: FIXTURE.billAttempt,
      community_id: FIXTURE.commAttempt,
      merchant_account_id: FIXTURE.merchantAttempt,
      merchant_account_version: 1,
      amount: 5000,
      merchant_reference: `KB-${FIXTURE.attempt}`,
    });

    manager = await createTestUser({
      email: EMAIL_ORG_MANAGER,
      role: "org_manager",
      scopeId: FIXTURE.org,
    });
    superAdmin = await createTestUser({ email: EMAIL_SUPER_ADMIN, role: "super_admin" });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  // ── What the delete preview counts ────────────────────────────────────────

  it("the delete preview's counts see the kept billing and the readings from closed periods", async () => {
    const [microgridClosed, microgridPaid, community, edge, organization] = await Promise.all([
      countEntityDescendants(manager.client, "microgrid", FIXTURE.mgClosed),
      countEntityDescendants(manager.client, "microgrid", FIXTURE.mgPaid),
      countEntityDescendants(manager.client, "community", FIXTURE.commKeep),
      countEntityDescendants(manager.client, "edge", FIXTURE.edgeClosed),
      countEntityDescendants(superAdmin.client, "organization", FIXTURE.orgAttempt),
    ]);
    expect(microgridClosed).toMatchObject({
      kind: "microgrid",
      billing_periods_closed: 1,
      billing_periods_with_payments: 0,
    });
    expect(microgridPaid).toMatchObject({
      kind: "microgrid",
      billing_periods_closed: 0,
      billing_periods_with_payments: 1,
    });
    expect(community).toMatchObject({
      kind: "community",
      billing_periods_closed: 1,
      billing_periods_with_payments: 1,
    });
    // The payment attempt is the organization's only payment activity.
    expect(organization).toMatchObject({
      kind: "organization",
      billing_periods_closed: 0,
      billing_periods_with_payments: 1,
    });
    expect(edge).toMatchObject({ kind: "edge", devices: 1, readings_in_closed_periods: 3 });
  });

  // ── Organization, community and microgrid deletes ─────────────────────────

  it("fn_entity_delete_microgrid is refused while the microgrid has a closed period", async () => {
    const { data, error } = await manager.client.rpc("fn_entity_delete_microgrid", {
      p_id: FIXTURE.mgClosed,
    });
    expectKept(error, "closed", "billing_period_kept: a microgrid");
    expect(data).toBeNull();
    expect(await exists("microgrids", FIXTURE.mgClosed)).toBe(true);
    expect(await exists("billing_line_items", FIXTURE.billClosed)).toBe(true);
  });

  it("fn_entity_delete_microgrid is refused while a draft period has a paid bill", async () => {
    const { error } = await manager.client.rpc("fn_entity_delete_microgrid", {
      p_id: FIXTURE.mgPaid,
    });
    expectKept(error, "payment_activity", "billing_period_kept: a microgrid");
    expect(await exists("billing_line_items", FIXTURE.billPaid)).toBe(true);
  });

  it("fn_entity_delete_community is refused while one of its microgrids has a closed period", async () => {
    const { error } = await manager.client.rpc("fn_entity_delete_community", {
      p_id: FIXTURE.commKeep,
    });
    expectKept(error, "closed", "billing_period_kept: a community");
    expect(await exists("communities", FIXTURE.commKeep)).toBe(true);
  });

  it("fn_entity_delete_org is refused when the organization's only payment activity is a payment attempt", async () => {
    const { error } = await superAdmin.client.rpc("fn_entity_delete_org", {
      p_id: FIXTURE.orgAttempt,
    });
    expectKept(error, "payment_activity", "billing_period_kept: an organization");
    expect(await exists("organizations", FIXTURE.orgAttempt)).toBe(true);
    expect(await exists("payment_attempts", FIXTURE.attempt)).toBe(true);
  });

  it("a direct microgrid delete through the API is refused the same way", async () => {
    const { error } = await manager.client
      .from("microgrids")
      .delete()
      .eq("id", FIXTURE.mgClosed);
    expectKept(error, "closed", "billing_period_kept: a microgrid");
    expect(await exists("microgrids", FIXTURE.mgClosed)).toBe(true);
  });

  it("service_role is refused too", async () => {
    const svc = await serviceClient();
    const { error } = await svc.from("organizations").delete().eq("id", FIXTURE.org);
    expectKept(error, "closed", "billing_period_kept: an organization");
    expect(await exists("organizations", FIXTURE.org)).toBe(true);
  });

  it("a microgrid whose only billing is an unpaid draft can still be deleted, with its period", async () => {
    const { data, error } = await manager.client.rpc("fn_entity_delete_microgrid", {
      p_id: FIXTURE.mgDraft,
    });
    expect(error).toBeNull();
    expect(data).toBe(1);
    expect(await exists("billing_periods", FIXTURE.periodDraft)).toBe(false);
    expect(await exists("billing_line_items", FIXTURE.billDraft)).toBe(false);
  });

  it("a community whose only billing is an unpaid draft can still be deleted", async () => {
    const { data, error } = await manager.client.rpc("fn_entity_delete_community", {
      p_id: FIXTURE.commDraft,
    });
    expect(error).toBeNull();
    expect(data).toBe(1);
    expect(await exists("billing_periods", FIXTURE.periodDraftInComm)).toBe(false);
  });

  // ── Bills ─────────────────────────────────────────────────────────────────

  it("a bill in a closed period cannot be deleted", async () => {
    const { error } = await manager.client
      .from("billing_line_items")
      .delete()
      .eq("id", FIXTURE.billClosed);
    expectKept(error, "closed", "billing_period_kept: a bill");
    expect(await exists("billing_line_items", FIXTURE.billClosed)).toBe(true);
  });

  it("a paid bill cannot be deleted", async () => {
    const { error } = await manager.client
      .from("billing_line_items")
      .delete()
      .eq("id", FIXTURE.billPaid);
    expectKept(error, "payment_activity", "billing_period_kept: a bill");
    expect(await exists("billing_line_items", FIXTURE.billPaid)).toBe(true);
  });

  it("a household with a bill in a closed period cannot be deleted", async () => {
    const { error } = await manager.client
      .from("households")
      .delete()
      .eq("id", FIXTURE.hhClosed);
    expectKept(error, "closed", "billing_period_kept: a bill");
    expect(await exists("households", FIXTURE.hhClosed)).toBe(true);
    expect(await exists("billing_line_items", FIXTURE.billClosed)).toBe(true);
  });

  it("an unpaid bill in a draft period can still be deleted", async () => {
    const { error } = await manager.client
      .from("billing_line_items")
      .delete()
      .eq("id", FIXTURE.billUnpaid);
    expect(error).toBeNull();
    expect(await exists("billing_line_items", FIXTURE.billUnpaid)).toBe(false);
  });

  // ── Closed periods stay closed ────────────────────────────────────────────

  it("an org manager cannot reopen a closed period", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .update({ status: "draft", closed_at: null })
      .eq("id", FIXTURE.periodClosed);
    expectKept(error, "closed", "billing_period_closed");
    expect(await periodStatus(FIXTURE.periodClosed)).toBe("closed");
  });

  it("service_role cannot reopen a closed period either", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("billing_periods")
      .update({ status: "draft" })
      .eq("id", FIXTURE.periodClosed);
    expectKept(error, "closed", "billing_period_closed");
    expect(await periodStatus(FIXTURE.periodClosed)).toBe("closed");
  });

  it("resending a closed period's status is accepted", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .update({ status: "closed" })
      .eq("id", FIXTURE.periodClosed);
    expect(error).toBeNull();
    expect(await periodStatus(FIXTURE.periodClosed)).toBe("closed");
  });

  it("a bill in a closed period can still be regenerated, and the period stays closed", async () => {
    const { error } = await manager.client.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodClosed,
      _rate_schedule_id: FIXTURE.rateClosed,
      _household_id: FIXTURE.hhClosed,
      _device_id: null,
      _usage_kwh: 12,
      _start_kwh: 100,
      _end_kwh: 112,
      _tier_breakdown: [{ label: "T1", kwh: 12, amount: 6000 }],
      _total_amount: 6000,
      _reading_source: "manual",
      _entered_by_user_id: manager.userId,
      _manual_reason: "Corrected reading after close",
      _actor_user_id: manager.userId,
      _audit_details: { household_name: "KB closed" },
    });
    expect(error).toBeNull();

    const svc = await serviceClient();
    const { data: bills } = await svc
      .from("billing_line_items")
      .select("id, total_amount")
      .eq("billing_period_id", FIXTURE.periodClosed);
    expect(bills).toEqual([{ id: FIXTURE.billClosed, total_amount: 6000 }]);

    const { data: audit } = await svc
      .from("billing_audit_log")
      .select("event_type, details")
      .eq("billing_line_item_id", FIXTURE.billClosed);
    expect(audit).toHaveLength(1);
    expect(audit?.[0]?.event_type).toBe("line_item_regenerated");
    expect((audit?.[0]?.details as Record<string, unknown>).period_was_closed).toBe(true);
    expect(await periodStatus(FIXTURE.periodClosed)).toBe("closed");
  });

  // ── TRUNCATE ──────────────────────────────────────────────────────────────

  it("TRUNCATE is refused for the database owner too, directly and through a parent's CASCADE", () => {
    // Without CASCADE, Postgres refuses to truncate either table before any
    // trigger runs, because other tables reference them.
    for (const [statement, table] of [
      ["TRUNCATE billing_periods CASCADE", "billing_periods"],
      ["TRUNCATE billing_line_items CASCADE", "billing_line_items"],
      ["TRUNCATE microgrids CASCADE", "billing_periods"],
      ["TRUNCATE households CASCADE", "billing_line_items"],
    ]) {
      // The block always ends in an error, so it rolls back whatever the
      // TRUNCATE did if the guard ever stops refusing it.
      const probe = runAsDatabaseOwner(
        [
          "DO $probe$",
          "BEGIN",
          "  BEGIN",
          `    ${statement};`,
          "  EXCEPTION WHEN check_violation THEN",
          "    RAISE EXCEPTION 'probe refused: %', SQLERRM;",
          "  END;",
          "  RAISE EXCEPTION 'probe truncated';",
          "END",
          "$probe$",
        ].join("\n"),
      );
      expect(probe.ok, probe.output).toBe(false);
      expect(probe.output, statement).toContain(
        `probe refused: billing_truncate_refused: ${table} cannot be truncated`,
      );
    }
  });

  it("the API roles hold no TRUNCATE privilege on the billing tables", () => {
    const query = runAsDatabaseOwner(
      `SELECT r AS role,
              has_table_privilege(r, 'billing_periods', 'TRUNCATE') AS periods,
              has_table_privilege(r, 'billing_line_items', 'TRUNCATE') AS bills
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
       ORDER BY r`,
    );
    expect(query.ok, query.output).toBe(true);
    expect(JSON.parse(query.stdout)).toEqual([
      { role: "anon", periods: false, bills: false },
      { role: "authenticated", periods: false, bills: false },
      { role: "service_role", periods: false, bills: false },
    ]);
  });
});

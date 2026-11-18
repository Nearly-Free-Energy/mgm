/**
 * close_billing_period.test.ts (migration 20261118130000, #201)
 *
 * Verifies, against a live local Supabase through PostgREST, closing a
 * billing period against the totals a person reviewed. As an org manager
 * except where noted:
 *   - fn_billing_period_close_review returns the totals, the unbilled and
 *     unmetered tenants, the acknowledgements the close requires and a
 *     digest; the digest is stable, changes when a bill's figures change and
 *     not when a payment is recorded; another organization's manager gets
 *     nothing;
 *   - fn_close_billing_period refuses a stale digest, a missing
 *     acknowledgement, another organization's period and an already-closed
 *     period, leaving the period a draft; with the current digest and every
 *     acknowledgement it closes the period and records the digest and
 *     acknowledgements in the audit log;
 *   - a close waiting on a bill being inserted, updated or deleted
 *     recomputes the digest after that commits and refuses the stale one,
 *     and a bill delete waiting on a close is refused once the close commits;
 *   - the status and closed_at cannot be written directly, by update or by
 *     insert, while a resend of the same values is accepted and service_role
 *     (fixtures, imports, restores) is exempt;
 *   - the grants: anon executes neither function, the API roles do not
 *     execute the trigger function, and the (uuid, boolean) close is gone.
 *
 * Owner queries and the race run through runAsDatabaseOwner, which needs the
 * repository's Supabase CLI first on PATH and SUPABASE_WORKDIR set when the
 * local project is not the working directory's.
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
  clientAs,
  runAsDatabaseOwner,
  raceAgainstHeldTransaction,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[close_billing_period] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  org: "c105ed00-0000-4000-8000-00000000000a",
  orgOther: "c105ed00-0000-4000-8000-00000000000b",
  comm: "c105ed00-0000-4000-8001-00000000000a",
  // mgMixed: one billed tenant, one billed without usage, one unbilled.
  mgMixed: "c105ed00-0000-4000-8002-00000000000a",
  // mgSimple: every tenant billed, so only totals_reviewed is required.
  mgSimple: "c105ed00-0000-4000-8002-00000000000b",
  // mgRace: a close waiting on a bill being written. mgRaceDelete: a close
  // waiting on a bill being deleted, then updated. mgRaceClose: a bill delete
  // waiting on a close.
  mgRace: "c105ed00-0000-4000-8002-00000000000c",
  mgRaceDelete: "c105ed00-0000-4000-8002-00000000000d",
  mgRaceClose: "c105ed00-0000-4000-8002-00000000000e",
  rateMixed: "c105ed00-0000-4000-8003-00000000000a",
  rateRace: "c105ed00-0000-4000-8003-00000000000c",
  tBilled: "c105ed00-0000-4000-8005-00000000000a",
  tUnmetered: "c105ed00-0000-4000-8005-00000000000b",
  tUnbilled: "c105ed00-0000-4000-8005-00000000000c",
  tSimple: "c105ed00-0000-4000-8005-00000000000d",
  tRace: "c105ed00-0000-4000-8005-00000000000e",
  tRaceLate: "c105ed00-0000-4000-8005-00000000000f",
  tRaceDelete1: "c105ed00-0000-4000-8005-000000000010",
  tRaceDelete2: "c105ed00-0000-4000-8005-000000000011",
  tRaceClose1: "c105ed00-0000-4000-8005-000000000012",
  tRaceClose2: "c105ed00-0000-4000-8005-000000000013",
  periodMixed: "c105ed00-0000-4000-8006-00000000000a",
  periodSimple: "c105ed00-0000-4000-8006-00000000000b",
  periodRace: "c105ed00-0000-4000-8006-00000000000c",
  periodRaceDelete: "c105ed00-0000-4000-8006-00000000000d",
  periodRaceClose: "c105ed00-0000-4000-8006-00000000000e",
  billBilled: "c105ed00-0000-4000-8007-00000000000a",
  billUnmetered: "c105ed00-0000-4000-8007-00000000000b",
  billSimple: "c105ed00-0000-4000-8007-00000000000d",
  billRace: "c105ed00-0000-4000-8007-00000000000e",
  billRaceDelete1: "c105ed00-0000-4000-8007-000000000010",
  billRaceDelete2: "c105ed00-0000-4000-8007-000000000011",
  billRaceClose1: "c105ed00-0000-4000-8007-000000000012",
  billRaceClose2: "c105ed00-0000-4000-8007-000000000013",
};

const EMAIL_MANAGER = `cbp-orgmgr-${Date.now()}@test.local`;
const EMAIL_OTHER = `cbp-other-${Date.now()}@test.local`;

let manager: TestUser;
let other: TestUser;

type Review = {
  periodId: string;
  status: string;
  startDate: string;
  endDate: string;
  currency: string;
  billCount: number;
  totalAmount: number;
  usageKwh: number;
  unbilled: { tenantId: string; tenantName: string }[];
  unmetered: { tenantId: string; tenantName: string }[];
  acknowledgements: string[];
  digest: string;
};

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(`[close_billing_period] fixture insert failed on ${table}: ${error.message}`);
  }
}

async function review(client: SupabaseClient, periodId: string): Promise<Review | null> {
  const { data, error } = await client.rpc("fn_billing_period_close_review", { _period_id: periodId });
  if (error) throw new Error(`[close_billing_period] review failed: ${error.message}`);
  return data as Review | null;
}

async function periodRow(id: string): Promise<{ status: string; closed_at: string | null }> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_periods").select("status, closed_at").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as { status: string; closed_at: string | null };
}

function close(client: SupabaseClient, periodId: string, digest: string | null, acknowledged: string[]) {
  return client.rpc("fn_close_billing_period", {
    _period_id: periodId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _digest: digest as any,
    _acknowledged: acknowledged,
  });
}

function expectRefused(
  error: { code?: string; message?: string; details?: string } | null,
  code: string,
  token: string,
) {
  expect(error?.code).toBe(code);
  expect(error?.message?.startsWith(`${token}:`), error?.message).toBe(true);
}

async function cleanupFixtures(): Promise<void> {
  await cleanupTestData({
    orgIds: [FIXTURE.org, FIXTURE.orgOther],
    userEmails: [EMAIL_MANAGER, EMAIL_OTHER],
  });
}

desc("20261118130000_close_billing_period_against_reviewed_totals.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();
    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: FIXTURE.org, name: "Close Billing Org" },
      { id: FIXTURE.orgOther, name: "Close Billing Other Org" },
    ]);
    await insertOrThrow(svc, "communities", { id: FIXTURE.comm, org_id: FIXTURE.org, name: "CB Comm" });
    await insertOrThrow(svc, "microgrids", [
      { id: FIXTURE.mgMixed, community_id: FIXTURE.comm, name: "CB MG mixed", currency: "UGX" },
      { id: FIXTURE.mgSimple, community_id: FIXTURE.comm, name: "CB MG simple", currency: "UGX" },
      { id: FIXTURE.mgRace, community_id: FIXTURE.comm, name: "CB MG race", currency: "UGX" },
      { id: FIXTURE.mgRaceDelete, community_id: FIXTURE.comm, name: "CB MG race delete", currency: "UGX" },
      { id: FIXTURE.mgRaceClose, community_id: FIXTURE.comm, name: "CB MG race close", currency: "UGX" },
    ]);
    // Before the periods, which pin the latest tariff on insert.
    await insertOrThrow(svc, "rate_schedules", [
      {
        id: FIXTURE.rateMixed,
        microgrid_id: FIXTURE.mgMixed,
        tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }],
        service_charge: 0,
        tax_rate: 0,
      },
      {
        id: FIXTURE.rateRace,
        microgrid_id: FIXTURE.mgRace,
        tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }],
        service_charge: 0,
        tax_rate: 0,
      },
    ]);
    await insertOrThrow(svc, "tenants", [
      { id: FIXTURE.tBilled, microgrid_id: FIXTURE.mgMixed, display_name: "CB billed", primary_phone: "+256700000401" },
      { id: FIXTURE.tUnmetered, microgrid_id: FIXTURE.mgMixed, display_name: "CB unmetered", primary_phone: "+256700000402" },
      { id: FIXTURE.tUnbilled, microgrid_id: FIXTURE.mgMixed, display_name: "CB unbilled", primary_phone: "+256700000403" },
      { id: FIXTURE.tSimple, microgrid_id: FIXTURE.mgSimple, display_name: "CB simple", primary_phone: "+256700000404" },
      { id: FIXTURE.tRace, microgrid_id: FIXTURE.mgRace, display_name: "CB race", primary_phone: "+256700000405" },
      { id: FIXTURE.tRaceLate, microgrid_id: FIXTURE.mgRace, display_name: "CB race late", primary_phone: "+256700000406" },
      { id: FIXTURE.tRaceDelete1, microgrid_id: FIXTURE.mgRaceDelete, display_name: "CB race delete 1", primary_phone: "+256700000407" },
      { id: FIXTURE.tRaceDelete2, microgrid_id: FIXTURE.mgRaceDelete, display_name: "CB race delete 2", primary_phone: "+256700000408" },
      { id: FIXTURE.tRaceClose1, microgrid_id: FIXTURE.mgRaceClose, display_name: "CB race close 1", primary_phone: "+256700000409" },
      { id: FIXTURE.tRaceClose2, microgrid_id: FIXTURE.mgRaceClose, display_name: "CB race close 2", primary_phone: "+256700000410" },
    ]);
    await insertOrThrow(svc, "billing_periods", [
      { id: FIXTURE.periodMixed, microgrid_id: FIXTURE.mgMixed, start_date: "2026-10-01", end_date: "2026-10-31" },
      { id: FIXTURE.periodSimple, microgrid_id: FIXTURE.mgSimple, start_date: "2026-10-01", end_date: "2026-10-31" },
      { id: FIXTURE.periodRace, microgrid_id: FIXTURE.mgRace, start_date: "2026-10-01", end_date: "2026-10-31" },
      { id: FIXTURE.periodRaceDelete, microgrid_id: FIXTURE.mgRaceDelete, start_date: "2026-10-01", end_date: "2026-10-31" },
      { id: FIXTURE.periodRaceClose, microgrid_id: FIXTURE.mgRaceClose, start_date: "2026-10-01", end_date: "2026-10-31" },
    ]);
    await insertOrThrow(svc, "billing_line_items", [
      { id: FIXTURE.billBilled, billing_period_id: FIXTURE.periodMixed, tenant_id: FIXTURE.tBilled, usage_kwh: 10, total_amount: 5000, tier_breakdown: [{ label: "T1", kwh: 10, amount: 5000 }] },
      { id: FIXTURE.billUnmetered, billing_period_id: FIXTURE.periodMixed, tenant_id: FIXTURE.tUnmetered, usage_kwh: null, total_amount: 0, tier_breakdown: [] },
      { id: FIXTURE.billSimple, billing_period_id: FIXTURE.periodSimple, tenant_id: FIXTURE.tSimple, usage_kwh: 4, total_amount: 2000, tier_breakdown: [{ label: "T1", kwh: 4, amount: 2000 }] },
      { id: FIXTURE.billRace, billing_period_id: FIXTURE.periodRace, tenant_id: FIXTURE.tRace, usage_kwh: 3, total_amount: 1500, tier_breakdown: [{ label: "T1", kwh: 3, amount: 1500 }] },
      { id: FIXTURE.billRaceDelete1, billing_period_id: FIXTURE.periodRaceDelete, tenant_id: FIXTURE.tRaceDelete1, usage_kwh: 3, total_amount: 1500, tier_breakdown: [] },
      { id: FIXTURE.billRaceDelete2, billing_period_id: FIXTURE.periodRaceDelete, tenant_id: FIXTURE.tRaceDelete2, usage_kwh: 4, total_amount: 2000, tier_breakdown: [] },
      { id: FIXTURE.billRaceClose1, billing_period_id: FIXTURE.periodRaceClose, tenant_id: FIXTURE.tRaceClose1, usage_kwh: 3, total_amount: 1500, tier_breakdown: [] },
      { id: FIXTURE.billRaceClose2, billing_period_id: FIXTURE.periodRaceClose, tenant_id: FIXTURE.tRaceClose2, usage_kwh: 4, total_amount: 2000, tier_breakdown: [] },
    ]);

    manager = await createTestUser({ email: EMAIL_MANAGER, role: "org_manager", scopeId: FIXTURE.org });
    other = await createTestUser({ email: EMAIL_OTHER, role: "org_manager", scopeId: FIXTURE.orgOther });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  // ── The review ─────────────────────────────────────────────────────────────

  it("returns the totals, warnings, required acknowledgements and a digest", async () => {
    const r = await review(manager.client, FIXTURE.periodMixed);
    expect(r).toMatchObject({
      periodId: FIXTURE.periodMixed,
      status: "draft",
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      currency: "UGX",
      billCount: 2,
      totalAmount: 5000,
      usageKwh: 10,
      unbilled: [{ tenantId: FIXTURE.tUnbilled, tenantName: "CB unbilled" }],
      unmetered: [{ tenantId: FIXTURE.tUnmetered, tenantName: "CB unmetered" }],
      acknowledgements: ["totals_reviewed", "tenants_without_bills", "bills_without_usage"],
    });
    expect(r?.digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect((await review(manager.client, FIXTURE.periodMixed))?.digest).toBe(r?.digest);
  });

  it("requires only totals_reviewed when every tenant has a bill with usage", async () => {
    const r = await review(manager.client, FIXTURE.periodSimple);
    expect(r).toMatchObject({ billCount: 1, totalAmount: 2000, unbilled: [], unmetered: [], acknowledgements: ["totals_reviewed"] });
  });

  it("returns nothing for another organization's period", async () => {
    expect(await review(other.client, FIXTURE.periodMixed)).toBeNull();
  });

  it("changes the digest when a bill's figures change, and not when a payment is recorded", async () => {
    const before = (await review(manager.client, FIXTURE.periodSimple))!.digest;

    const { error: payError } = await manager.client.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.billSimple,
      _to_status: "paid",
      _source: "manual",
      _actor_user_id: manager.userId,
      _raw_payload: {},
    });
    expect(payError).toBeNull();
    expect((await review(manager.client, FIXTURE.periodSimple))!.digest).toBe(before);

    const svc = await serviceClient();
    const { error: changeError } = await svc
      .from("billing_line_items")
      .update({ total_amount: 2100 })
      .eq("id", FIXTURE.billSimple);
    expect(changeError).toBeNull();
    const changed = (await review(manager.client, FIXTURE.periodSimple))!.digest;
    expect(changed).not.toBe(before);

    // Back to the same figures, back to the same digest.
    await svc.from("billing_line_items").update({ total_amount: 2000 }).eq("id", FIXTURE.billSimple);
    expect((await review(manager.client, FIXTURE.periodSimple))!.digest).toBe(before);
  });

  // ── The close ──────────────────────────────────────────────────────────────

  it("refuses a digest of other totals, and leaves the period a draft", async () => {
    const r = (await review(manager.client, FIXTURE.periodMixed))!;
    const stale = `v1:${"0".repeat(64)}`;
    for (const digest of [stale, "", null]) {
      const { error } = await close(manager.client, FIXTURE.periodMixed, digest, r.acknowledgements);
      expectRefused(error, "23514", "billing_close_totals_changed");
    }
    expect((await periodRow(FIXTURE.periodMixed)).status).toBe("draft");
  });

  it("refuses a close missing any required acknowledgement", async () => {
    const r = (await review(manager.client, FIXTURE.periodMixed))!;
    // A null counts as no acknowledgement, not as every one.
    for (const acknowledged of [
      [],
      ["totals_reviewed"],
      ["totals_reviewed", "tenants_without_bills"],
      [null],
      ["totals_reviewed", "tenants_without_bills", null],
    ] as string[][]) {
      const { error } = await close(manager.client, FIXTURE.periodMixed, r.digest, acknowledged);
      expectRefused(error, "23514", "billing_close_acknowledgement_missing");
    }
    expect((await periodRow(FIXTURE.periodMixed)).status).toBe("draft");
  });

  it("refuses another organization's manager as not found", async () => {
    const r = (await review(manager.client, FIXTURE.periodMixed))!;
    const { error } = await close(other.client, FIXTURE.periodMixed, r.digest, r.acknowledgements);
    expectRefused(error, "P0002", "billing_period_not_found");
    expect((await periodRow(FIXTURE.periodMixed)).status).toBe("draft");
  });

  it("closes with the current digest and every acknowledgement, and records both", async () => {
    const r = (await review(manager.client, FIXTURE.periodMixed))!;
    const { data, error } = await close(manager.client, FIXTURE.periodMixed, r.digest, [
      "bills_without_usage",
      "totals_reviewed",
      "tenants_without_bills",
    ]);
    expect(error).toBeNull();
    expect(data).toMatchObject([{ id: FIXTURE.periodMixed, status: "closed" }]);
    const row = await periodRow(FIXTURE.periodMixed);
    expect(row.status).toBe("closed");
    expect(row.closed_at).not.toBeNull();

    const svc = await serviceClient();
    const { data: audit, error: auditError } = await svc
      .from("billing_audit_log")
      .select("actor_user_id, actor_kind, details")
      .eq("billing_period_id", FIXTURE.periodMixed)
      .eq("event_type", "period_closed");
    expect(auditError).toBeNull();
    expect(audit).toEqual([
      {
        actor_user_id: manager.userId,
        actor_kind: "human",
        details: {
          digest: r.digest,
          acknowledged: ["totals_reviewed", "tenants_without_bills", "bills_without_usage"],
          bill_count: 2,
          total_amount: 5000,
          currency: "UGX",
          unresolved: [{ tenantId: FIXTURE.tUnbilled, tenantName: "CB unbilled" }],
          unmetered: [{ tenantId: FIXTURE.tUnmetered, tenantName: "CB unmetered" }],
        },
      },
    ]);
  });

  it("refuses to close a period that is already closed", async () => {
    const r = (await review(manager.client, FIXTURE.periodMixed))!;
    expect(r.status).toBe("closed");
    const { error } = await close(manager.client, FIXTURE.periodMixed, r.digest, r.acknowledgements);
    expectRefused(error, "23514", "billing_period_closed");
  });

  it("a close waiting on a bill being written refuses the digest taken before the bill", async () => {
    const r = (await review(manager.client, FIXTURE.periodRace))!;
    expect(r.unbilled).toEqual([{ tenantId: FIXTURE.tRaceLate, tenantName: "CB race late" }]);
    const race = await raceAgainstHeldTransaction(
      [
        // The insert's foreign key check takes FOR KEY SHARE on the period
        // row, so the close's FOR UPDATE waits for it.
        `  INSERT INTO billing_line_items (billing_period_id, tenant_id, usage_kwh, total_amount, tier_breakdown)`,
        `  VALUES ('${FIXTURE.periodRace}', '${FIXTURE.tRaceLate}', 2, 1000, '[{"label":"T1","kwh":2,"amount":1000}]');`,
      ].join("\n"),
      () => close(manager.client, FIXTURE.periodRace, r.digest, r.acknowledgements),
    );
    expect(race.holder.ok, race.holder.output).toBe(true);
    expectRefused(race.contender.error, "23514", "billing_close_totals_changed");
    expect((await periodRow(FIXTURE.periodRace)).status).toBe("draft");

    // Reviewed again, the new bill is in the totals and the close goes through.
    const again = (await review(manager.client, FIXTURE.periodRace))!;
    expect(again).toMatchObject({ billCount: 2, totalAmount: 2500, unbilled: [], acknowledgements: ["totals_reviewed"] });
    const { error } = await close(manager.client, FIXTURE.periodRace, again.digest, again.acknowledgements);
    expect(error).toBeNull();
    expect((await periodRow(FIXTURE.periodRace)).status).toBe("closed");
  }, 30_000);

  it("a close waiting on a bill being deleted, or its total updated, refuses the stale digest", async () => {
    const r = (await review(manager.client, FIXTURE.periodRaceDelete))!;
    expect(r.billCount).toBe(2);
    const deleted = await raceAgainstHeldTransaction(
      `  DELETE FROM billing_line_items WHERE id = '${FIXTURE.billRaceDelete2}';`,
      () => close(manager.client, FIXTURE.periodRaceDelete, r.digest, r.acknowledgements),
    );
    expect(deleted.holder.ok, deleted.holder.output).toBe(true);
    expectRefused(deleted.contender.error, "23514", "billing_close_totals_changed");
    expect((await periodRow(FIXTURE.periodRaceDelete)).status).toBe("draft");

    const afterDelete = (await review(manager.client, FIXTURE.periodRaceDelete))!;
    expect(afterDelete).toMatchObject({ billCount: 1, totalAmount: 1500 });
    const updated = await raceAgainstHeldTransaction(
      `  UPDATE billing_line_items SET total_amount = 1600 WHERE id = '${FIXTURE.billRaceDelete1}';`,
      () => close(manager.client, FIXTURE.periodRaceDelete, afterDelete.digest, afterDelete.acknowledgements),
    );
    expect(updated.holder.ok, updated.holder.output).toBe(true);
    expectRefused(updated.contender.error, "23514", "billing_close_totals_changed");
    expect((await periodRow(FIXTURE.periodRaceDelete)).status).toBe("draft");
  }, 60_000);

  it("a bill delete waiting on a close is refused once the period is closed", async () => {
    const claims = JSON.stringify({ sub: manager.userId, role: "authenticated" });
    const race = await raceAgainstHeldTransaction(
      [
        // fn_close_billing_period as the manager, the way PostgREST runs it.
        `  PERFORM set_config('request.jwt.claims', '${claims}', true);`,
        `  SET LOCAL ROLE authenticated;`,
        `  PERFORM fn_close_billing_period('${FIXTURE.periodRaceClose}', r->>'digest',`,
        `    ARRAY(SELECT jsonb_array_elements_text(r->'acknowledgements')))`,
        `  FROM fn_billing_period_close_review('${FIXTURE.periodRaceClose}') AS r;`,
      ].join("\n"),
      () => manager.client.from("billing_line_items").delete().eq("id", FIXTURE.billRaceClose2),
    );
    expect(race.holder.ok, race.holder.output).toBe(true);
    expect(race.contender.error?.code).toBe("23514");
    expect(race.contender.error?.details).toBe("closed");
    expect((await periodRow(FIXTURE.periodRaceClose)).status).toBe("closed");
    const svc = await serviceClient();
    const { data } = await svc.from("billing_line_items").select("id").eq("billing_period_id", FIXTURE.periodRaceClose);
    expect(data).toHaveLength(2);
  }, 30_000);

  // ── Status written only through the close ──────────────────────────────────

  it("refuses a direct status or closed_at update on a draft", async () => {
    for (const change of [{ status: "closed" }, { status: "closed", closed_at: new Date().toISOString() }, { closed_at: new Date().toISOString() }]) {
      const { error } = await manager.client.from("billing_periods").update(change).eq("id", FIXTURE.periodSimple);
      expectRefused(error, "42501", "billing_period_status_via_close");
    }
    expect(await periodRow(FIXTURE.periodSimple)).toEqual({ status: "draft", closed_at: null });
  });

  it("accepts a resend of the same status and closed_at", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .update({ status: "draft", closed_at: null })
      .eq("id", FIXTURE.periodSimple);
    expect(error).toBeNull();
  });

  it("refuses inserting a period that is closed or has a closed_at, and accepts a draft", async () => {
    const base = { microgrid_id: FIXTURE.mgSimple, start_date: "2027-01-01", end_date: "2027-01-31" };
    for (const extra of [{ status: "closed" }, { closed_at: new Date().toISOString() }]) {
      const { error } = await manager.client.from("billing_periods").insert({ ...base, ...extra });
      expectRefused(error, "42501", "billing_period_status_via_close");
    }
    const { error } = await manager.client.from("billing_periods").insert(base);
    expect(error).toBeNull();
  });

  it("refuses moving a closed period's closed_at", async () => {
    const { error } = await manager.client
      .from("billing_periods")
      .update({ closed_at: "2026-01-01T00:00:00Z" })
      .eq("id", FIXTURE.periodMixed);
    expectRefused(error, "42501", "billing_period_status_via_close");
  });

  it("still refuses reopening with the stays-closed code", async () => {
    const { error } = await manager.client.from("billing_periods").update({ status: "draft" }).eq("id", FIXTURE.periodMixed);
    expect(error?.code).toBe("23514");
    expect(error?.message?.startsWith("billing_period_closed:")).toBe(true);
  });

  it("leaves service_role exempt, for fixtures, imports and restores", async () => {
    const svc = await serviceClient();
    const { error } = await svc.from("billing_periods").insert({
      microgrid_id: FIXTURE.mgSimple,
      start_date: "2027-02-01",
      end_date: "2027-02-28",
      status: "closed",
      closed_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
  });

  // ── Grants ─────────────────────────────────────────────────────────────────

  it("anon executes neither function", async () => {
    const anon = clientAs(process.env.MGM_PUBLIC_SUPABASE_ANON_KEY ?? "");
    for (const [fn, args] of [
      ["fn_billing_period_close_review", { _period_id: FIXTURE.periodSimple }],
      ["fn_close_billing_period", { _period_id: FIXTURE.periodSimple, _digest: "v1:x", _acknowledged: [] }],
    ] as const) {
      const { error } = await anon.rpc(fn, args);
      expect(
        error?.code === "42501" || error?.message?.toLowerCase().includes("permission denied") || error?.code === "PGRST202",
        `${fn}: ${error?.code} ${error?.message}`,
      ).toBe(true);
    }
  });

  it("grants the functions to the signed-in and service roles only, and drops the old close", () => {
    const query = runAsDatabaseOwner(
      `SELECT f AS fn,
              has_function_privilege('anon', f, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', f, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', f, 'EXECUTE') AS service_role
       FROM unnest(ARRAY[
         'fn_billing_period_close_review(uuid)',
         'fn_close_billing_period(uuid,text,text[])',
         'fn_billing_period_transitions_by_close()'
       ]) AS f
       UNION ALL
       SELECT 'old close', to_regprocedure('fn_close_billing_period(uuid,boolean)') IS NOT NULL, NULL, NULL`,
    );
    expect(query.ok, query.output).toBe(true);
    expect(JSON.parse(query.stdout)).toEqual([
      { fn: "fn_billing_period_close_review(uuid)", anon: false, authenticated: true, service_role: true },
      { fn: "fn_close_billing_period(uuid,text,text[])", anon: false, authenticated: true, service_role: true },
      { fn: "fn_billing_period_transitions_by_close()", anon: false, authenticated: false, service_role: true },
      { fn: "old close", anon: false, authenticated: null, service_role: null },
    ]);
  });
});

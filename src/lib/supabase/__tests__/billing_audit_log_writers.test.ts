/**
 * billing_audit_log_writers.test.ts (migration 20261124160000)
 *
 * trg_billing_audit_log_written_by_functions and the four billing functions
 * that set mgm.billing_audit_writer around their audit insert, against a live
 * local Supabase through PostgREST:
 *   - an org manager's direct insert into billing_audit_log is refused, for a
 *     human row (own actor or another) and for a system row;
 *   - service_role inserts directly;
 *   - fn_create_billing_period, fn_record_first_line_item_with_audit,
 *     fn_record_line_item_with_audit and fn_close_billing_period, called by
 *     the manager, each write their audit row;
 *   - fn_record_first_line_item_with_audit and fn_record_line_item_with_audit,
 *     called by the manager, write only a row naming the manager: another
 *     user or a system actor is refused, and the call writes nothing;
 *   - the setting is cleared when a function returns, so a direct insert
 *     later in the same transaction is refused.
 *
 * And, for migration 20261124170000, the same two functions called by the
 * manager:
 *   - a manual bill entered by another user, or by nobody, is refused and
 *     the call writes nothing; one entered by the manager is written;
 *   - the audit row's details are the function's: built from the bill and
 *     the bill it replaces (previous_snapshot as stored), whatever the
 *     caller sends; a key an app never sent, or details that are not an
 *     object, are refused and the call writes nothing;
 *   - service_role still writes the entered-by and details it is given.
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
  runAsDatabaseOwner,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[billing_audit_log_writers] SKIP_RLS_TESTS=1 — skipping suite.");
}

const F = {
  org: "a0d17000-0000-4000-8000-00000000000a",
  otherOrg: "a0d17000-0000-4000-8000-00000000000b",
  community: "a0d17000-0000-4000-8001-00000000000a",
  otherCommunity: "a0d17000-0000-4000-8001-00000000000b",
  mg: "a0d17000-0000-4000-8002-00000000000a",
  rate: "a0d17000-0000-4000-8005-00000000000a",
  tenant: "a0d17000-0000-4000-8007-000000000001",
  // A draft the manager bills and closes.
  draft: "a0d17000-0000-4000-8006-000000000001",
  // A draft the direct inserts name.
  direct: "a0d17000-0000-4000-8006-000000000002",
  // A draft the manager bills with forged inputs (20261124170000).
  inputs: "a0d17000-0000-4000-8006-000000000003",
  // A draft every refused call names; it never gets a bill.
  refused: "a0d17000-0000-4000-8006-000000000004",
};

const STAMP = Date.now();
const EMAIL = {
  manager: `balw-mgr-${STAMP}@test.local`,
  other: `balw-other-${STAMP}@test.local`,
};

let manager: TestUser;
let other: TestUser;

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(`[billing_audit_log_writers] fixture insert failed on ${table}: ${error.message}`);
  }
}

async function auditRows(filter: { period?: string; lineItem?: string; marker?: string; reason?: string }) {
  const svc = await serviceClient();
  let query = svc.from("billing_audit_log").select("event_type, actor_user_id, actor_kind, actor_ref, details");
  if (filter.period) query = query.eq("billing_period_id", filter.period);
  if (filter.lineItem) query = query.eq("billing_line_item_id", filter.lineItem);
  if (filter.marker) query = query.eq("details->>marker", filter.marker);
  if (filter.reason) query = query.eq("details->>manual_reason", filter.reason);
  const { data, error } = await query.order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The engine's arguments for a bill, as generate.ts sends them. */
function billArgs(over: Record<string, unknown> = {}) {
  return {
    _billing_period_id: F.draft,
    _tenant_id: F.tenant,
    _device_id: null,
    _usage_kwh: 10,
    _start_kwh: 100,
    _end_kwh: 110,
    _tier_breakdown: [{ label: "T1", kwh: 10, amount: 2500 }],
    _total_amount: 2500,
    _reading_source: "manual",
    _entered_by_user_id: manager.userId,
    _manual_reason: "meter offline",
    _actor_user_id: manager.userId,
    _audit_details: null,
    _rate_schedule_id: F.rate,
    ...over,
  };
}

/** The details the functions build for billArgs' bill (20261124170000). */
function builtDetails(over: Record<string, unknown> = {}) {
  return {
    tenant_name: "AW Tenant",
    previous_total_amount: null,
    new_total_amount: 2500,
    previous_reading_source: null,
    new_reading_source: "manual",
    manual_reason: "meter offline",
    rate_schedule_id: F.rate,
    ...over,
  };
}

type Refusal = { code?: string; message?: string; details?: string } | null;

function expectEnteredByRefused(error: Refusal) {
  expect(error?.code).toBe("42501");
  expect(error?.message).toMatch(/^billing_entered_by_is_caller/);
  expect(error?.details).toBe("entered_by_is_caller");
}

function expectDetailsRefused(error: Refusal) {
  expect(error?.code).toBe("42501");
  expect(error?.message).toMatch(/^billing_audit_details_from_function/);
  expect(error?.details).toBe("audit_details_from_function");
}

/** A bill as stored, in the shape of details.previous_snapshot. */
async function snapshotOf(lineItemId: string) {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("start_kwh, end_kwh, usage_kwh, tier_breakdown, device_id, entered_by_user_id, entered_at, manual_reason, total_amount, reading_source")
    .eq("id", lineItemId)
    .single();
  if (error) throw new Error(error.message);
  const { total_amount, reading_source, ...snapshot } = data;
  return { snapshot, total_amount: Number(total_amount), reading_source };
}

function expectActorRefused(error: { code?: string; message?: string; details?: string } | null) {
  expect(error?.code).toBe("42501");
  expect(error?.message).toMatch(/^billing_audit_actor_is_caller/);
  expect(error?.details).toBe("audit_actor_is_caller");
}

async function billsOf(period: string) {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("id, usage_kwh, total_amount")
    .eq("billing_period_id", period)
    .eq("tenant_id", F.tenant);
  if (error) throw new Error(error.message);
  return data ?? [];
}

function expectRefusedByTrigger(error: { code?: string; message?: string; details?: string } | null) {
  expect(error?.code).toBe("42501");
  expect(error?.message).toMatch(/^billing_audit_log_via_function/);
  expect(error?.details).toBe("audit_via_function");
}

async function cleanupFixtures(): Promise<void> {
  await cleanupTestData({ orgIds: [F.org, F.otherOrg], userEmails: Object.values(EMAIL) });
}

desc("20261124160000_billing_audit_log_written_by_functions.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();
    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: F.org, name: "Audit Writers Org" },
      { id: F.otherOrg, name: "Audit Writers Other Org" },
    ]);
    await insertOrThrow(svc, "communities", [
      { id: F.community, org_id: F.org, name: "AW Comm" },
      { id: F.otherCommunity, org_id: F.otherOrg, name: "AW Other Comm" },
    ]);
    await insertOrThrow(svc, "microgrids", { id: F.mg, community_id: F.community, name: "AW MG", currency: "UGX" });
    await insertOrThrow(svc, "tenants", {
      id: F.tenant,
      microgrid_id: F.mg,
      display_name: "AW Tenant",
      primary_phone: "+256700099001",
    });
    await insertOrThrow(svc, "rate_schedules", {
      id: F.rate,
      microgrid_id: F.mg,
      tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 250 }],
      service_charge: 0,
      tax_rate: 0,
    });
    await insertOrThrow(svc, "billing_periods", [
      { id: F.draft, microgrid_id: F.mg, start_date: "2025-01-01", end_date: "2025-01-31", rate_schedule_id: F.rate },
      { id: F.direct, microgrid_id: F.mg, start_date: "2025-02-01", end_date: "2025-02-28", rate_schedule_id: F.rate },
      { id: F.inputs, microgrid_id: F.mg, start_date: "2025-05-01", end_date: "2025-05-31", rate_schedule_id: F.rate },
      { id: F.refused, microgrid_id: F.mg, start_date: "2025-06-01", end_date: "2025-06-30", rate_schedule_id: F.rate },
    ]);

    manager = await createTestUser({ email: EMAIL.manager, role: "org_manager", scopeId: F.org });
    other = await createTestUser({ email: EMAIL.other, role: "org_manager", scopeId: F.otherOrg });
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  describe("a direct insert", () => {
    it.each([
      ["a human row (other actor)", () => ({ actor_kind: "human", actor_user_id: other.userId, actor_ref: null })],
      ["a human row (own actor)", () => ({ actor_kind: "human", actor_user_id: manager.userId, actor_ref: null })],
      ["a system row", () => ({ actor_kind: "system", actor_user_id: null, actor_ref: "direct-insert" })],
    ] as const)("by an org manager is refused: %s", async (label, actor) => {
      const marker = `direct-${label}`;
      const { error } = await manager.client.from("billing_audit_log").insert({
        billing_period_id: F.direct,
        event_type: "billing_period_created",
        details: { marker },
        ...actor(),
      });
      expectRefusedByTrigger(error);
      expect(await auditRows({ marker })).toEqual([]);
    });

    it("by service_role is written", async () => {
      const svc = await serviceClient();
      const marker = "direct-service-role";
      const { error } = await svc.from("billing_audit_log").insert({
        billing_period_id: F.direct,
        event_type: "billing_period_created",
        actor_kind: "system",
        actor_user_id: null,
        actor_ref: "audit-writers-test",
        details: { marker },
      });
      expect(error).toBeNull();
      expect(await auditRows({ marker })).toMatchObject([{ actor_kind: "system", actor_ref: "audit-writers-test" }]);
    });
  });

  describe("the line-item functions, called by an org manager, record the manager as the actor", () => {
    const ACTORS = [
      ["other actor", () => ({ _actor_user_id: other.userId })],
      ["system actor", () => ({ _actor_user_id: null, _actor_kind: "system", _actor_ref: "audit-writers-test" })],
    ] as const;
    const FUNCTIONS = ["fn_record_first_line_item_with_audit", "fn_record_line_item_with_audit"] as const;
    const CASES = FUNCTIONS.flatMap((fn) => ACTORS.map(([label, actor]) => [fn, label, actor] as const));

    it.each(CASES)("%s with a new bill, %s: refused, nothing written", async (fn, label, actor) => {
      const marker = `actor-new-${fn}-${label}`;
      const { data, error } = await manager.client.rpc(
        fn,
        billArgs({ _billing_period_id: F.direct, _manual_reason: marker, ...actor() }),
      );
      expect(data).toBeNull();
      expectActorRefused(error);
      expect(await billsOf(F.direct)).toEqual([]);
      expect(await auditRows({ reason: marker })).toEqual([]);
    });

    it.each(ACTORS)("fn_record_line_item_with_audit on an existing bill, %s: refused, bill unchanged", async (label, actor) => {
      const marker = `actor-existing-${label}`;
      if ((await billsOf(F.direct)).length === 0) {
        const first = await manager.client.rpc(
          "fn_record_first_line_item_with_audit",
          billArgs({ _billing_period_id: F.direct }),
        );
        expect(first.error).toBeNull();
      }
      const [before] = await billsOf(F.direct);
      const auditBefore = await auditRows({ lineItem: before.id });
      expect(auditBefore.map((r) => r.event_type)).toEqual(["line_item_generated"]);

      // The bill's current figures: a regeneration that changes nothing.
      const { data, error } = await manager.client.rpc(
        "fn_record_line_item_with_audit",
        billArgs({ _billing_period_id: F.direct, _manual_reason: marker, ...actor() }),
      );
      expect(data).toBeNull();
      expectActorRefused(error);
      expect(await billsOf(F.direct)).toEqual([before]);
      expect(await auditRows({ lineItem: before.id })).toEqual(auditBefore);
    });
  });

  describe("the line-item functions, called by an org manager, record who entered the bill and build its audit details (20261124170000)", () => {
    const FUNCTIONS = ["fn_record_first_line_item_with_audit", "fn_record_line_item_with_audit"] as const;

    async function expectNothingWritten() {
      expect(await billsOf(F.refused)).toEqual([]);
      expect(await auditRows({ period: F.refused })).toEqual([]);
    }

    const ENTERED_BY = [
      ["another user", () => other.userId],
      ["nobody", () => null],
    ] as const;
    it.each(FUNCTIONS.flatMap((fn) => ENTERED_BY.map(([label, who]) => [fn, label, who] as const)))(
      "%s, a manual bill entered by %s: refused, nothing written",
      async (fn, _label, who) => {
        const { data, error } = await manager.client.rpc(
          fn,
          billArgs({ _billing_period_id: F.refused, _entered_by_user_id: who() }),
        );
        expect(data).toBeNull();
        expectEnteredByRefused(error);
        await expectNothingWritten();
      },
    );

    const DETAILS = [
      ["a key no app sends", { marker: "forged" }],
      ["a key no app sends beside the ones it did", { tenant_name: "Forged", period_was_closed: true }],
      ["details that are not an object", ["forged"]],
    ] as const;
    it.each(FUNCTIONS.flatMap((fn) => DETAILS.map(([label, details]) => [fn, label, details] as const)))(
      "%s, %s: refused, nothing written",
      async (fn, _label, details) => {
        const { data, error } = await manager.client.rpc(
          fn,
          billArgs({ _billing_period_id: F.refused, _audit_details: details }),
        );
        expect(data).toBeNull();
        expectDetailsRefused(error);
        await expectNothingWritten();
      },
    );

    let billId: string;

    it("a manual bill entered by the manager is written, entered by the manager", async () => {
      const { data, error } = await manager.client.rpc(
        "fn_record_first_line_item_with_audit",
        billArgs({ _billing_period_id: F.inputs }),
      );
      expect(error).toBeNull();
      billId = (data as { id: string; entered_by_user_id: string }).id;
      expect((data as { entered_by_user_id: string }).entered_by_user_id).toBe(manager.userId);
      expect(await auditRows({ lineItem: billId })).toMatchObject([{ details: builtDetails() }]);
    });

    it("forged values for the keys an app sent are replaced by the function's, previous_snapshot included", async () => {
      const prior = await snapshotOf(billId);
      const { error } = await manager.client.rpc(
        "fn_record_line_item_with_audit",
        billArgs({
          _billing_period_id: F.inputs,
          _usage_kwh: 12,
          _end_kwh: 112,
          _total_amount: 3000,
          _manual_reason: "re-read",
          _audit_details: {
            tenant_name: "Forged",
            previous_total_amount: 1,
            new_total_amount: 2,
            previous_reading_source: "edge",
            new_reading_source: "edge",
            manual_reason: "forged",
            previous_snapshot: { start_kwh: 0, end_kwh: 0, usage_kwh: 0, entered_by_user_id: other.userId, manual_reason: "forged" },
          },
        }),
      );
      expect(error).toBeNull();
      const rows = await auditRows({ lineItem: billId });
      expect(rows.map((r) => r.event_type)).toEqual(["line_item_generated", "line_item_regenerated"]);
      expect(rows[1].details).toEqual(
        builtDetails({
          previous_total_amount: 2500,
          previous_reading_source: "manual",
          new_total_amount: 3000,
          manual_reason: "re-read",
          previous_snapshot: prior.snapshot,
        }),
      );
      expect(prior.snapshot).toMatchObject({ start_kwh: 100, end_kwh: 110, usage_kwh: 10, entered_by_user_id: manager.userId, manual_reason: "meter offline" });
    });

    it("service_role still writes the entered-by and details it is given", async () => {
      const svc = await serviceClient();
      const forged = { marker: "service-role", previous_snapshot: { manual_reason: "given" } };
      const { data, error } = await svc.rpc(
        "fn_record_line_item_with_audit",
        billArgs({
          _billing_period_id: F.inputs,
          _usage_kwh: 14,
          _end_kwh: 114,
          _total_amount: 3500,
          _entered_by_user_id: other.userId,
          _actor_user_id: other.userId,
          _audit_details: forged,
        }),
      );
      expect(error).toBeNull();
      expect((data as { entered_by_user_id: string }).entered_by_user_id).toBe(other.userId);
      expect(await auditRows({ marker: "service-role" })).toEqual([
        {
          event_type: "line_item_regenerated",
          actor_user_id: other.userId,
          actor_kind: "human",
          actor_ref: null,
          details: { ...forged, rate_schedule_id: F.rate },
        },
      ]);
    });
  });

  describe("the billing functions, called by an org manager, write their audit rows", () => {
    it("fn_create_billing_period: billing_period_created", async () => {
      const { data, error } = await manager.client.rpc("fn_create_billing_period", {
        _microgrid_id: F.mg,
        _start_date: "2025-03-01",
        _end_date: "2025-03-31",
      });
      expect(error).toBeNull();
      const created = (data as { id: string }[])[0];
      expect(await auditRows({ period: created.id })).toEqual([
        {
          event_type: "billing_period_created",
          actor_user_id: manager.userId,
          actor_kind: "human",
          actor_ref: null,
          details: { start_date: "2025-03-01", end_date: "2025-03-31" },
        },
      ]);
    });

    let billId: string;

    it("fn_record_first_line_item_with_audit: line_item_generated", async () => {
      const { data, error } = await manager.client.rpc("fn_record_first_line_item_with_audit", billArgs());
      expect(error).toBeNull();
      billId = (data as { id: string }).id;
      expect(await auditRows({ lineItem: billId })).toEqual([
        {
          event_type: "line_item_generated",
          actor_user_id: manager.userId,
          actor_kind: "human",
          actor_ref: null,
          details: builtDetails(),
        },
      ]);
    });

    it("fn_record_line_item_with_audit: line_item_regenerated", async () => {
      const prior = await snapshotOf(billId);
      const { data, error } = await manager.client.rpc(
        "fn_record_line_item_with_audit",
        billArgs({ _usage_kwh: 12, _end_kwh: 112, _total_amount: 3000 }),
      );
      expect(error).toBeNull();
      expect((data as { id: string }).id).toBe(billId);
      const rows = await auditRows({ lineItem: billId });
      expect(rows.map((r) => r.event_type)).toEqual(["line_item_generated", "line_item_regenerated"]);
      expect(rows[1]).toMatchObject({ actor_user_id: manager.userId, actor_kind: "human" });
      expect(rows[1].details).toEqual(
        builtDetails({
          previous_total_amount: prior.total_amount,
          previous_reading_source: prior.reading_source,
          new_total_amount: 3000,
          previous_snapshot: prior.snapshot,
        }),
      );
    });

    it("fn_close_billing_period: period_closed", async () => {
      const review = await manager.client.rpc("fn_billing_period_close_review", { _period_id: F.draft });
      expect(review.error).toBeNull();
      const r = review.data as { digest: string; acknowledgements: string[] };
      const { error } = await manager.client.rpc("fn_close_billing_period", {
        _period_id: F.draft,
        _digest: r.digest,
        _acknowledged: r.acknowledgements,
      });
      expect(error).toBeNull();
      const closed = (await auditRows({ period: F.draft })).filter((row) => row.event_type === "period_closed");
      expect(closed).toMatchObject([{ actor_user_id: manager.userId, actor_kind: "human", details: { digest: r.digest } }]);
    });
  });

  it("clears the setting when a function returns, so a later direct insert in the same transaction is refused", () => {
    const claims = JSON.stringify({ sub: manager.userId, role: "authenticated" });
    // Rolled back at the end by the final RAISE, which reports what happened.
    const result = runAsDatabaseOwner(
      [
        "DO $t$",
        "DECLARE",
        "  v_period uuid;",
        "  v_refused text := 'accepted';",
        "BEGIN",
        `  PERFORM set_config('request.jwt.claims', '${claims}', true);`,
        "  SET LOCAL ROLE authenticated;",
        `  SELECT id INTO v_period FROM fn_create_billing_period('${F.mg}', '2025-04-01', '2025-04-30');`,
        "  BEGIN",
        "    INSERT INTO billing_audit_log (billing_period_id, event_type, actor_user_id, actor_kind, details)",
        `    VALUES (v_period, 'billing_period_created', '${manager.userId}', 'human', '{}'::jsonb);`,
        "  EXCEPTION WHEN insufficient_privilege THEN",
        "    v_refused := SQLERRM;",
        "  END;",
        "  RAISE EXCEPTION 'audit-writers-probe period=% flag=[%] insert=%',",
        "    (v_period IS NOT NULL)::text, coalesce(current_setting('mgm.billing_audit_writer', true), ''), v_refused;",
        "END",
        "$t$",
      ].join("\n"),
    );
    expect(result.ok, result.output).toBe(false);
    expect(result.output).toMatch(
      /audit-writers-probe period=true flag=\[\] insert=billing_audit_log_via_function/,
    );
  });
});

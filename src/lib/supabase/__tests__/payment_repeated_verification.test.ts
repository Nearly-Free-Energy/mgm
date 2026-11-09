/**
 * payment_repeated_verification.test.ts (migrations 00065 and 20261010202643)
 *
 * Verifies, against a live local Supabase through PostgREST, that checking
 * the same payment again records it once. Each time a household opens the
 * payment return page, or the provider resends its notification, the
 * Payments capability's handleNotification makes the same two writes for a
 * completed payment: fn_payment_enqueue_notification for the notification,
 * then fn_payment_commit_verification with the provider's evidence. Here
 * those two calls run three times with the same merchant reference and
 * tracking id, as the repository makes them
 * (src/lib/payments/infrastructure/supabase-repository.ts), and the suite
 * checks there is one notification, one receipt, one payment event, and a
 * bill marked paid once. If the repository's calls change, change these
 * with them.
 *
 * The provider call in between is not exercised; capability.test.ts covers
 * what the capability does with the provider's answer.
 *
 * Self-fixturing; honors `SKIP_RLS_TESTS=1` for runs without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertEnvironmentReady, shouldSkip, serviceClient, cleanupTestData } from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[payment_repeated_verification] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  org: "ca11bac0-0000-4000-8000-00000000000a",
  community: "ca11bac0-0000-4000-8001-00000000000a",
  microgrid: "ca11bac0-0000-4000-8002-00000000000a",
  household: "ca11bac0-0000-4000-8005-00000000000a",
  period: "ca11bac0-0000-4000-8006-00000000000a",
  bill: "ca11bac0-0000-4000-8007-00000000000a",
  merchant: "ca11bac0-0000-4000-8008-00000000000a",
  attempt: "ca11bac0-0000-4000-8009-00000000000a",
};

const REFERENCE = `RV-${FIXTURE.attempt}`;
const TRACKING = "ca11bac0-tracking-0001";
const AMOUNT = 5000;
const TAPS = 3;

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(`[payment_repeated_verification] fixture insert failed on ${table}: ${error.message}`);
  }
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const svc = await serviceClient();
  const { count, error } = await svc.from(table).select("id", { count: "exact", head: true }).eq(column, value);
  if (error) throw new Error(`[payment_repeated_verification] count on ${table} failed: ${error.message}`);
  return count ?? 0;
}

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first. A paid bill keeps the organization from an
// ordinary delete, so cleanupTestData purges it as the database owner.
async function cleanupFixtures(): Promise<void> {
  const svc = await serviceClient();
  const { error } = await svc.from("payment_merchant_versions").delete().eq("org_id", FIXTURE.org);
  if (error) throw new Error(`[payment_repeated_verification] cleanup failed: ${error.message}`);
  await cleanupTestData({ orgIds: [FIXTURE.org], userEmails: [] });
}

desc("repeated checks of one payment", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", { id: FIXTURE.org, name: "Repeated Verification Org" });
    await insertOrThrow(svc, "communities", { id: FIXTURE.community, org_id: FIXTURE.org, name: "RV Comm" });
    await insertOrThrow(svc, "microgrids", {
      id: FIXTURE.microgrid,
      community_id: FIXTURE.community,
      name: "RV MG",
      currency: "UGX",
    });
    await insertOrThrow(svc, "households", {
      id: FIXTURE.household,
      microgrid_id: FIXTURE.microgrid,
      display_name: "RV household",
      primary_phone: "+256700000401",
    });
    await insertOrThrow(svc, "billing_periods", {
      id: FIXTURE.period,
      microgrid_id: FIXTURE.microgrid,
      start_date: "2026-01-01",
      end_date: "2026-01-31",
      status: "draft",
      closed_at: null,
    });
    await insertOrThrow(svc, "billing_line_items", {
      id: FIXTURE.bill,
      billing_period_id: FIXTURE.period,
      household_id: FIXTURE.household,
      usage_kwh: 10,
      total_amount: AMOUNT,
      payment_status: "unpaid",
      paid_at: null,
    });
    const { data: bill, error: billError } = await svc
      .from("billing_line_items")
      .select("updated_at")
      .eq("id", FIXTURE.bill)
      .single<{ updated_at: string }>();
    if (billError || !bill) throw new Error(`[payment_repeated_verification] bill read failed: ${billError?.message}`);

    // Merchant account first: the payment_account_snapshot trigger writes the
    // version row that payment_attempt_scope requires.
    await insertOrThrow(svc, "payment_merchant_accounts", {
      id: FIXTURE.merchant,
      org_id: FIXTURE.org,
      display_name: "RV merchant",
    });
    // The attempt as a checkout leaves it once the provider's tracking id is
    // bound: same amount and bill revision as the bill, so a completed
    // payment settles it.
    await insertOrThrow(svc, "payment_attempts", {
      id: FIXTURE.attempt,
      org_id: FIXTURE.org,
      line_item_id: FIXTURE.bill,
      community_id: FIXTURE.community,
      merchant_account_id: FIXTURE.merchant,
      merchant_account_version: 1,
      amount: AMOUNT,
      currency: "UGX",
      bill_revision_total: AMOUNT,
      bill_revision_updated_at: bill.updated_at,
      merchant_reference: REFERENCE,
      provider_tracking_id: TRACKING,
    });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  it("records a completed payment once, however many times it is checked", async () => {
    const svc = await serviceClient();
    for (let tap = 1; tap <= TAPS; tap += 1) {
      const { error: notificationError } = await svc.rpc("fn_payment_enqueue_notification", {
        _org: FIXTURE.org,
        _tracking: TRACKING,
        _reference: REFERENCE,
        _payload: { OrderTrackingId: TRACKING, OrderMerchantReference: REFERENCE },
      });
      expect(notificationError, `notification, check ${tap}`).toBeNull();
      const { error: commitError } = await svc.rpc("fn_payment_commit_verification", {
        _attempt_id: FIXTURE.attempt,
        _amount: AMOUNT,
        _currency: "UGX",
        _status: "completed",
        _tracking: TRACKING,
        _confirmation: "RV-CONFIRMATION",
        _method: "MobileMoney",
        _payload: { status: "completed" },
      });
      expect(commitError, `verification, check ${tap}`).toBeNull();
    }

    expect(await countRows("payment_notifications", "tracking_id", TRACKING)).toBe(1);
    expect(await countRows("payment_receipts", "attempt_id", FIXTURE.attempt)).toBe(1);
    expect(await countRows("payment_events", "line_item_id", FIXTURE.bill)).toBe(1);

    const { data: bill } = await svc
      .from("billing_line_items")
      .select("payment_status")
      .eq("id", FIXTURE.bill)
      .single<{ payment_status: string }>();
    expect(bill?.payment_status).toBe("paid");
    const { data: attempt } = await svc
      .from("payment_attempts")
      .select("status")
      .eq("id", FIXTURE.attempt)
      .single<{ status: string }>();
    expect(attempt?.status).toBe("verified");
  });
});

/**
 * The twice-sent cases of the payments plugin's actions (../repeat.db.test.ts),
 * with their fixture: one organization with a draft period of four bills, a
 * default Pesapal merchant account with an encrypted secret (so the attempts'
 * account version decrypts), and an attempt on each bill.
 *
 * The provider is a stub: the root payment-provider registry's forAccount is
 * replaced for this merchant account only, which works because Payments asks
 * the registry on each call (PaymentsPlugin in src/lib/payments/compose.ts);
 * if Payments comes to keep a provider between calls, revisit. Its base URL
 * is unresolvable, and the test refuses any request that leaves the local
 * Supabase.
 */
import { vi, type MockInstance } from "vitest";
import type { PaymentProviderClient, TransactionSnapshot } from "@/lib/payments/providers/types";
import type { MgmRuntime } from "@/lib/runtime/root";
import type { PaymentProviderRegistry } from "@/lib/runtime/services";
import { cleanupTestData, createTestUser, serviceClient } from "@/lib/supabase/__tests__/rls.helpers";
import type { CaseModule, Fixture } from "./harness";

const ORG = "e2761000-0000-4000-8000-000000000001";
const COMMUNITY = "e2761000-0000-4000-8001-000000000001";
const MG = "e2761000-0000-4000-8002-000000000001";
const SCHEDULE = "e2761000-0000-4000-8006-000000000001";
const PERIOD = "e2761000-0000-4000-8003-000000000001";
const MERCHANT = "e2761000-0000-4000-8007-000000000001";
const tenant = (n: number) => `e2761000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const bill = (n: number) => `e2761000-0000-4000-8005-${String(n).padStart(12, "0")}`;
const attempt = (n: number) => `e2761000-0000-4000-8008-${String(n).padStart(12, "0")}`;
const EMAIL = "repeat-payments-manager@test.local";

/** Bill 1 (15,000): a checkout the provider reports completed. */
const DONE = attempt(1);
/** Bill 2 (15,000): a checkout the provider reports still pending. */
const WAITING = attempt(2);
/** Bill 3 (5,000): held, with a receipt of 3,000. */
const SHORT = attempt(3);
/** Bill 4 (3,000): held, with a receipt of exactly 3,000. */
const EXACT = attempt(4);

const reference = (n: number) => `MGM-repeat-${n}`;

/** What the stub provider answers for each tracking id. */
const TRANSACTIONS: Readonly<Record<string, TransactionSnapshot>> = {
  "trk-done": {
    trackingId: "trk-done",
    status: "completed",
    amount: 15000,
    currency: "UGX",
    merchantReference: reference(1),
    confirmationCode: "CONF-REPEAT-1",
    paymentMethod: "MTN",
    raw: {},
  },
  "trk-wait": { trackingId: "trk-wait", status: "pending", raw: {} },
};

const unused = () => {
  throw new Error("[repeat payments] the stub provider does not do this");
};
const stub: PaymentProviderClient = {
  provider: "pesapal",
  testConnection: unused,
  createCheckout: unused,
  parseNotification: unused,
  getTransaction: async (trackingId) => {
    const found = TRANSACTIONS[trackingId];
    if (!found) throw new Error(`[repeat payments] no transaction ${trackingId}`);
    return found;
  },
};

let spy: MockInstance<PaymentProviderRegistry["forAccount"]> | null = null;

export const PAYMENTS_CASES: CaseModule = {
  cases: {
    "payments.refresh-attempt": [
      // The receipt is already recorded: fn_payment_commit_verification
      // inserts it ON CONFLICT DO NOTHING and returns when nothing was
      // inserted, so the second send writes nothing: 200. If that function
      // stops returning on a conflicting receipt, this case's second send
      // writes, and the case fails.
      { label: "the provider reports it completed", as: "manager", params: { id: DONE }, body: () => ({}), first: 200, second: 200 },
      // The attempt is already waiting for confirmation: 200.
      {
        label: "the provider reports it still pending",
        as: "manager",
        params: { id: WAITING },
        body: () => ({}),
        first: 200,
        second: 200,
        ignore: [
          // The refresh rewrites this pending attempt with the same status and
          // failure fields, and trg_payment_attempts_updated_at stamps every
          // update. Read only for failed and held attempts (listAttention and
          // the attention signals), never this one's; the other attempts' are
          // still compared. If it comes to be read for a pending attempt,
          // remove this, and make the refresh skip an attempt already in that
          // state instead.
          { column: "payment_attempts.updated_at", row: { id: WAITING }, reason: "stamped on every update, not read for a pending attempt" },
        ],
      },
    ],
    // The attempt no longer needs reconciliation: 409.
    "payments.record-adjustment": [
      {
        as: "manager",
        params: { id: SHORT },
        body: () => ({
          action: "record_external",
          externalAmount: 2000,
          externalReference: "MTN-CASH-REPEAT",
          notes: "Collected in cash",
          confirmation: { acknowledged: [], typed: "Tenant 3" },
        }),
        first: 200,
        second: 409,
      },
    ],
    "payments.accept-receipts": [{ as: "manager", params: { id: EXACT }, body: () => ({ action: "accept_exact" }), first: 200, second: 409 }],
  },

  async cleanup() {
    spy?.mockRestore();
    spy = null;
    // payment_merchant_versions references organizations without ON DELETE
    // CASCADE, so its rows go first; the closed and paid billing is purged
    // as the database owner by cleanupTestData.
    const svc = await serviceClient();
    const { error } = await svc.from("payment_merchant_versions").delete().eq("org_id", ORG);
    if (error) throw new Error(`[repeat payments] payment_merchant_versions: ${error.message}`);
    await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
  },

  async seed(runtime: MgmRuntime): Promise<Fixture> {
    const svc = await serviceClient();
    const insert = async (table: string, value: Record<string, unknown> | Record<string, unknown>[]) => {
      const { error } = await svc.from(table).insert(value);
      if (error) throw new Error(`[repeat payments] ${table}: ${error.message}`);
    };
    const totals = [15000, 15000, 5000, 3000];
    await insert("organizations", { id: ORG, name: "Repeat Payments Org" });
    await insert("communities", { id: COMMUNITY, org_id: ORG, name: "Repeat Payments Community" });
    await insert("microgrids", { id: MG, community_id: COMMUNITY, name: "Repeat Payments site", currency: "UGX", timezone: "Africa/Kampala" });
    await insert("rate_schedules", {
      id: SCHEDULE,
      microgrid_id: MG,
      tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }],
      service_charge: 0,
      tax_rate: 0,
    });
    await insert(
      "tenants",
      totals.map((_, i) => ({ id: tenant(i + 1), microgrid_id: MG, display_name: `Tenant ${i + 1}`, primary_phone: `+256700277${String(i + 1).padStart(3, "0")}` })),
    );
    await insert("billing_periods", {
      id: PERIOD,
      microgrid_id: MG,
      start_date: "2026-08-01",
      end_date: "2026-08-31",
      timezone: "Africa/Kampala",
      status: "draft",
      rate_schedule_id: SCHEDULE,
    });
    await insert(
      "billing_line_items",
      totals.map((total, i) => ({
        id: bill(i + 1),
        billing_period_id: PERIOD,
        tenant_id: tenant(i + 1),
        start_kwh: 0,
        end_kwh: total / 500,
        usage_kwh: total / 500,
        total_amount: total,
        reading_source: "manual",
      })),
    );
    const encrypted = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: "repeat-db-secret" });
    if (encrypted.error || !encrypted.data) throw new Error(`[repeat payments] fn_ems_encrypt_secret: ${encrypted.error?.message ?? "no data"}`);
    // The insert trigger records version 1, with the secret, for the attempts.
    await insert("payment_merchant_accounts", {
      id: MERCHANT,
      org_id: ORG,
      provider: "pesapal",
      is_default: true,
      sandbox: true,
      consumer_key: "repeat-db-key",
      secret_encrypted: encrypted.data,
      base_url: "https://pesapal.invalid",
      ipn_id: "ipn-repeat",
      last_test_status: "success",
    });
    // Each checkout carries its bill's revision, so a verified receipt that
    // matches settles the bill rather than waiting for reconciliation.
    const revisions = await svc.from("billing_line_items").select("id, updated_at").eq("billing_period_id", PERIOD);
    if (revisions.error) throw new Error(`[repeat payments] revisions: ${revisions.error.message}`);
    const revision = new Map((revisions.data ?? []).map((r) => [r.id as string, r.updated_at as string]));
    const checkout = (n: number, tracking: string, status: string) => ({
      id: attempt(n),
      org_id: ORG,
      line_item_id: bill(n),
      community_id: COMMUNITY,
      merchant_account_id: MERCHANT,
      merchant_account_version: 1,
      amount: totals[n - 1],
      currency: "UGX",
      bill_revision_total: totals[n - 1],
      bill_revision_updated_at: revision.get(bill(n)),
      merchant_reference: reference(n),
      provider_tracking_id: tracking,
      status,
      failure_code: status === "needs_reconciliation" ? "balance_mismatch" : null,
    });
    await insert("payment_attempts", [
      checkout(1, "trk-done", "pending"),
      checkout(2, "trk-wait", "pending"),
      checkout(3, "trk-short", "needs_reconciliation"),
      checkout(4, "trk-exact", "needs_reconciliation"),
    ]);
    const receipt = (n: number, amount: number, tracking: string) => ({
      org_id: ORG,
      attempt_id: attempt(n),
      amount,
      currency: "UGX",
      provider: "pesapal",
      provider_status: "completed",
      provider_tracking_id: tracking,
      raw_payload: {},
    });
    await insert("payment_receipts", [receipt(3, 3000, "trk-short"), receipt(4, 3000, "trk-exact")]);

    const registry = runtime.paymentProviders;
    const original = registry.forAccount;
    spy = vi.spyOn(registry, "forAccount").mockImplementation(async (account) =>
      account.id === MERCHANT ? { ok: true, provider: stub } : original(account),
    );
    return {
      orgId: ORG,
      users: { manager: await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG }) },
    };
  },
};

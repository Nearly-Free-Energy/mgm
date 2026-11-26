/**
 * actor_client_id on the audit tables (#272; RFC #259 § 2; ADR-008,
 * Consequences: the audit column for the client id), on the job's own
 * Supabase. Migration 20261126180000_audit_actor_client_id.sql.
 *
 * An operator client signs in through Supabase Auth's OAuth server as
 * bearer-session.db.test.ts signs one in (authorize, the person's approval
 * with their browser session, the approval record MGM's consent page
 * writes, written here with the service role, and the code exchanged with
 * its PKCE verifier). Its token then goes straight to the database API.
 *
 * Cases:
 * - billing_audit_log: fn_create_billing_period, which runs as the caller,
 *   records the client's id for the client's token and NULL for the same
 *   person's browser session;
 * - mgm_plugin_audit_log: fn_mgm_set_plugin_enabled, a SECURITY DEFINER
 *   function that runs as its owner, records the client's id too, so the
 *   claims, not the role the insert runs as, decide;
 * - payment_events: a direct insert by the person (their FOR ALL policy
 *   allows it) that names another client gets the token's own client, or
 *   NULL for the browser session; an update that names the column keeps the
 *   recorded value; the service role's value is kept as given; and
 *   fn_payment_reconcile, which MGM calls on the service role for a
 *   manager, records the client it is passed.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  LOCAL_SUPABASE_URL,
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  mintServiceRoleJwt,
  serviceClient,
  shouldSkip,
  testAnonKey,
} from "./rls.helpers";

const skip = shouldSkip();
const REDIRECT_URI = "http://127.0.0.1:3000/oauth/test-code";

const F = {
  org: "27210000-0000-4000-8000-000000000001",
  community: "27210000-0000-4000-8001-000000000001",
  microgrid: "27210000-0000-4000-8002-000000000001",
  period: "27210000-0000-4000-8003-000000000001",
  unit: "27210000-0000-4000-8004-000000000001",
  unit2: "27210000-0000-4000-8004-000000000002",
  bill: "27210000-0000-4000-8005-000000000001",
  heldBill: "27210000-0000-4000-8005-000000000002",
  schedule: "27210000-0000-4000-8006-000000000001",
  merchant: "27210000-0000-4000-8007-000000000001",
  held: "27210000-0000-4000-8008-000000000001",
};
const EMAIL = "audit-client-id-staff@test.local";
/** Another client's id, which a statement tries to record. */
const OTHER_CLIENT = "27210000-0000-4000-8009-000000000001";

let svc: SupabaseClient;
let userId = "";
let browserToken = "";
let clientId = "";
/** The person through the operator client, and through their browser session. */
let viaClient: SupabaseClient;
let viaBrowser: SupabaseClient;

const anonClient = () =>
  createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });

const asToken = (token: string) =>
  createClient(LOCAL_SUPABASE_URL, testAnonKey()!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

async function auth(method: string, path: string, opts: { token?: string; json?: object; form?: Record<string, string>; apikey?: string } = {}) {
  const headers: Record<string, string> = { apikey: opts.apikey ?? testAnonKey()! };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1${path}`, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

async function admin(method: string, path: string, json?: object) {
  const key = await mintServiceRoleJwt();
  return auth(method, path, { token: key, apikey: key, json });
}

/** A client sign-in for the person, ending in the client's access token. */
async function signIn(): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    scope: "email",
  });
  const authorize = await auth("GET", `/oauth/authorize?${query}`);
  expect(authorize.status, JSON.stringify(authorize.body)).toBeGreaterThanOrEqual(300);
  const authorizationId = new URL(authorize.headers.get("location")!).searchParams.get("authorization_id")!;
  const details = await auth("GET", `/oauth/authorizations/${authorizationId}`, { token: browserToken });
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  let redirect = details.body.redirect_url as string | undefined;
  if (!redirect) {
    const consent = await auth("POST", `/oauth/authorizations/${authorizationId}/consent`, {
      token: browserToken,
      json: { action: "approve" },
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(200);
    redirect = consent.body.redirect_url as string;
  }
  // The record MGM's consent page writes when the person clicks (ADR-008 decision 2).
  const { error } = await svc.from("mgm_client_approvals").insert({ user_id: userId, client_id: clientId });
  expect(error).toBeNull();
  const token = await auth("POST", "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: new URL(redirect).searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
  });
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  return token.body.access_token as string;
}

/** A payment event the person records directly, naming `claimed` as its client. */
const manualEvent = (claimed: string | null) => ({
  line_item_id: F.bill,
  from_status: "unpaid",
  to_status: "unpaid",
  source: "manual",
  actor_user_id: userId,
  actor_kind: "human",
  raw_payload: { note: `audit client id ${randomUUID()}` },
  actor_client_id: claimed,
});

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first; payment records are kept with their bill
// (20261103160000), so cleanupTestData purges the organization as the
// database owner.
async function cleanup() {
  const s = await serviceClient();
  const versions = await s.from("payment_merchant_versions").delete().eq("org_id", F.org);
  if (versions.error) throw new Error(`[audit_client_id] payment_merchant_versions: ${versions.error.message}`);
  await cleanupTestData({ orgIds: [F.org], userEmails: [EMAIL] });
}

describe.skipIf(skip)("actor_client_id on the audit tables (#272)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    svc = await serviceClient();
    await cleanup();

    const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
      ["organizations", { id: F.org, name: "Audit client id org" }],
      ["communities", { id: F.community, org_id: F.org, name: "Audit client id community" }],
      ["microgrids", { id: F.microgrid, community_id: F.community, name: "Audit client id grid", currency: "UGX", timezone: "Africa/Kampala" }],
      ["rate_schedules", { id: F.schedule, microgrid_id: F.microgrid, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 }],
      [
        "tenants",
        [
          { id: F.unit, microgrid_id: F.microgrid, display_name: "Akello Grace", primary_phone: "+256700002721" },
          { id: F.unit2, microgrid_id: F.microgrid, display_name: "Okello James", primary_phone: "+256700002722" },
        ],
      ],
      ["billing_periods", { id: F.period, microgrid_id: F.microgrid, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: F.schedule }],
      [
        "billing_line_items",
        [
          { id: F.bill, billing_period_id: F.period, tenant_id: F.unit, start_kwh: 0, end_kwh: 10, usage_kwh: 10, total_amount: 5000, reading_source: "manual" },
          { id: F.heldBill, billing_period_id: F.period, tenant_id: F.unit2, start_kwh: 0, end_kwh: 6, usage_kwh: 6, total_amount: 3000, reading_source: "manual" },
        ],
      ],
      ["payment_merchant_accounts", { id: F.merchant, org_id: F.org, provider: "pesapal", is_default: true, sandbox: true, last_test_status: "success", ipn_id: "ipn-test" }],
      [
        "payment_attempts",
        {
          id: F.held,
          org_id: F.org,
          line_item_id: F.heldBill,
          community_id: F.community,
          merchant_account_id: F.merchant,
          merchant_account_version: 1,
          amount: 3000,
          currency: "UGX",
          bill_revision_total: 3000,
          merchant_reference: `MGM-${F.held}`,
          provider_tracking_id: "trk-audit-client-id",
          status: "needs_reconciliation",
          failure_code: "balance_mismatch",
        },
      ],
      [
        "payment_receipts",
        { org_id: F.org, attempt_id: F.held, amount: 3000, currency: "UGX", provider: "pesapal", provider_status: "completed", provider_tracking_id: "trk-audit-client-id", raw_payload: {} },
      ],
    ];
    for (const [table, value] of rows) {
      const { error } = await svc.from(table).insert(value);
      if (error) throw new Error(`[audit_client_id] ${table}: ${error.message}`);
    }

    userId = (await createTestUser({ email: EMAIL, role: "org_manager", scopeId: F.org })).userId;
    // The person's browser session, made as MGM makes one: an emailed link.
    const { data: link, error: linkError } = await svc.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
    expect(linkError).toBeNull();
    const { data: session, error: verifyError } = await anonClient().auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
    expect(verifyError).toBeNull();
    browserToken = session.session!.access_token;
    viaBrowser = asToken(browserToken);

    // Registered and listed as docs/setup.md registers and lists the CLI.
    const created = await admin("POST", "/admin/oauth/clients", {
      client_name: "mgm-audit-client-id-test",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    clientId = created.body.client_id as string;
    const { error } = await svc.from("mgm_clients").insert({ client_id: clientId, kind: "operator", label: "MGM CLI (audit test)" });
    expect(error).toBeNull();
    viaClient = asToken(await signIn());
  }, 90_000);

  afterAll(async () => {
    if (svc && clientId) await svc.from("mgm_clients").delete().eq("client_id", clientId);
    if (clientId) await admin("DELETE", `/admin/oauth/clients/${clientId}`);
    if (svc) await cleanup();
  }, 60_000);

  it("records the client on a billing audit row a client's token writes, and NULL for a browser session", async () => {
    const byClient = await viaClient.rpc("fn_create_billing_period", { _microgrid_id: F.microgrid, _start_date: "2026-01-01", _end_date: "2026-01-31" });
    expect(byClient.error).toBeNull();
    const byBrowser = await viaBrowser.rpc("fn_create_billing_period", { _microgrid_id: F.microgrid, _start_date: "2026-02-01", _end_date: "2026-02-28" });
    expect(byBrowser.error).toBeNull();
    const periodOf = (data: unknown) => (Array.isArray(data) ? data[0] : data) as { id: string };

    const { data, error } = await svc
      .from("billing_audit_log")
      .select("billing_period_id, actor_user_id, actor_client_id")
      .eq("event_type", "billing_period_created")
      .in("billing_period_id", [periodOf(byClient.data).id, periodOf(byBrowser.data).id]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    const row = (id: string) => data!.find((r) => r.billing_period_id === id);
    expect(row(periodOf(byClient.data).id)).toEqual({ billing_period_id: periodOf(byClient.data).id, actor_user_id: userId, actor_client_id: clientId });
    expect(row(periodOf(byBrowser.data).id)).toEqual({ billing_period_id: periodOf(byBrowser.data).id, actor_user_id: userId, actor_client_id: null });
  });

  it("records the client on a plugin audit row written inside a SECURITY DEFINER function", async () => {
    const on = await viaClient.rpc("fn_mgm_set_plugin_enabled", { _org_id: F.org, _plugin_name: "operations", _plugin_version: "0.1.0", _enabled: true });
    expect(on.error).toBeNull();
    const off = await viaBrowser.rpc("fn_mgm_set_plugin_enabled", { _org_id: F.org, _plugin_name: "operations", _plugin_version: "0.1.0", _enabled: false });
    expect(off.error).toBeNull();

    const { data, error } = await svc
      .from("mgm_plugin_audit_log")
      .select("action, actor_user_id, actor_client_id")
      .eq("org_id", F.org)
      .eq("plugin_name", "operations")
      .order("created_at", { ascending: true });
    expect(error).toBeNull();
    expect(data).toEqual([
      { action: "enabled", actor_user_id: userId, actor_client_id: clientId },
      { action: "disabled", actor_user_id: userId, actor_client_id: null },
    ]);
  });

  it("records the token's own client on a payment event that names another, and NULL for a browser session", async () => {
    const byClient = await viaClient.from("payment_events").insert(manualEvent(OTHER_CLIENT)).select("id, actor_client_id").single();
    expect(byClient.error).toBeNull();
    expect(byClient.data!.actor_client_id).toBe(clientId);

    const byBrowser = await viaBrowser.from("payment_events").insert(manualEvent(OTHER_CLIENT)).select("id, actor_client_id").single();
    expect(byBrowser.error).toBeNull();
    expect(byBrowser.data!.actor_client_id).toBeNull();
  });

  it("keeps the recorded client when a person's update names the column", async () => {
    const inserted = await viaClient.from("payment_events").insert(manualEvent(null)).select("id").single();
    expect(inserted.error).toBeNull();
    const id = inserted.data!.id as string;
    for (const who of [viaClient, viaBrowser]) {
      const { data, error } = await who.from("payment_events").update({ actor_client_id: OTHER_CLIENT }).eq("id", id).select("actor_client_id").single();
      expect(error).toBeNull();
      expect(data!.actor_client_id).toBe(clientId);
    }
  });

  it("keeps the value the service role supplies", async () => {
    const { data, error } = await svc.from("payment_events").insert(manualEvent(OTHER_CLIENT)).select("actor_client_id").single();
    expect(error).toBeNull();
    expect(data!.actor_client_id).toBe(OTHER_CLIENT);
  });

  it("records the client fn_payment_reconcile is passed, as MGM calls it on the service role for a manager", async () => {
    const { error } = await svc.rpc("fn_payment_reconcile", {
      _attempt_id: F.held,
      _action: "accept_exact",
      _external_amount: 0,
      _reference: null,
      _notes: null,
      _actor: userId,
      _actor_client_id: clientId,
    });
    expect(error).toBeNull();
    const events = await svc.from("payment_events").select("source, actor_kind, actor_user_id, actor_client_id").eq("line_item_id", F.heldBill);
    expect(events.error).toBeNull();
    expect(events.data).toEqual([{ source: "manual", actor_kind: "human", actor_user_id: userId, actor_client_id: clientId }]);
  });
});

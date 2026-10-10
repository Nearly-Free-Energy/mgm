/**
 * GET /api/organizations/[id]/payment-accounts — list org merchant accounts
 * (redacted: readiness + test results, never saved secrets).
 *
 * POST — create/update the organization-default Pesapal account. Supports
 * sandbox/live mode, encrypted credentials, connection testing and
 * notification registration. Managers see readiness and test results, never
 * saved secrets.
 *
 * Body: { displayName?, consumerKey, consumerSecret?, sandbox }
 * - consumerSecret blank + existing account → preserve + re-test.
 * - First configuration requires a secret.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { testMerchantConfiguration } from "@/lib/payments/infrastructure/merchant-configuration";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redact<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row };
  delete (copy as Record<string, unknown>).secret_encrypted;
  return copy;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: orgId } = await params;
  if (!UUID_RE.test(orgId)) {
    return NextResponse.json({ error: "Invalid organization id." }, { status: 400 });
  }
  const supabase = await createClient();
  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  const { data, error } = await supabase
    .from("payment_merchant_accounts")
    .select(
      "id, org_id, provider, display_name, sandbox, consumer_key, base_url, ipn_id, ipn_url, version, is_default, disabled, last_tested_at, last_test_status, last_test_message, created_at, updated_at"
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) {
    if (error.code === "42P01") {
      return NextResponse.json({ accounts: [], readiness: "unconfigured" });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ accounts: (data ?? []).map(redact) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: orgId } = await params;
  if (!UUID_RE.test(orgId)) {
    return NextResponse.json({ error: "Invalid organization id." }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
  }
  const consumerKey =
    typeof body.consumerKey === "string" ? body.consumerKey.trim() : "";
  if (typeof body.sandbox !== "boolean") return NextResponse.json({ error: "sandbox must be boolean" }, { status: 400 });
  const sandbox = body.sandbox;
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim().slice(0, 120)
      : body.createOverride === true ? "Optional Pesapal account" : "Default Pesapal account";
  const submittedSecret =
    typeof body.consumerSecret === "string" ? body.consumerSecret : "";
  if (!consumerKey) {
    return NextResponse.json(
      { error: "consumerKey must be a non-empty string.", reason: "invalid_config" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const accountId = typeof body.accountId === "string" ? body.accountId : null;
  if (accountId && !UUID_RE.test(accountId)) return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  const query = supabase.from("payment_merchant_accounts").select("id, version, is_default").eq("org_id", orgId);
  const { data: existing, error: accountError } = await (accountId ? query.eq("id", accountId) : body.createOverride === true ? query.eq("id", "00000000-0000-0000-0000-000000000000") : query.eq("is_default", true)).maybeSingle<{ id: string; version: number; is_default: boolean }>();
  if (accountError || (accountId && !existing)) return NextResponse.json({ error: "Merchant account unavailable" }, { status: 404 });

  let effectiveSecret = submittedSecret;
  if (!effectiveSecret && existing) {
    // Secret-preserve: decrypt via the service-role accessor after the
    // RLS-gated read above authorized this caller.
    const service = createServiceClient();
    const { data: decrypted } = await service.rpc("fn_get_payment_merchant_secret", {
      _account_id: existing.id,
    });
    if (typeof decrypted !== "string" || !decrypted) {
      return NextResponse.json(
        { error: "Could not retrieve the existing secret. Re-enter the consumer secret." },
        { status: 500 }
      );
    }
    effectiveSecret = decrypted;
  }
  if (!effectiveSecret) {
    return NextResponse.json(
      { error: "A consumer secret is required for the first configuration." },
      { status: 400 }
    );
  }

  const tested = await testMerchantConfiguration({ consumerKey, consumerSecret: effectiveSecret, sandbox });
  if (!tested.ok) return NextResponse.json({ error: tested.message, reason: tested.reason }, { status: 503 });
  const { baseUrl, ipnId, ipnUrl } = tested;
  // Encrypt + persist (version bump binds future attempts to this config).
  const { data: enc, error: encErr } = await supabase.rpc("fn_ems_encrypt_secret", {
    p_plaintext: effectiveSecret,
  });
  if (encErr || !enc) {
    return NextResponse.json(
      { error: `Failed to encrypt secret: ${encErr?.message ?? "no data"}` },
      { status: 500 }
    );
  }
  const service = createServiceClient();
  const payload: Record<string, unknown> = {
    org_id: orgId,
    provider: "pesapal",
    display_name: displayName,
    is_default: existing?.is_default ?? body.createOverride !== true,
    sandbox,
    consumer_key: consumerKey,
    secret_encrypted: enc,
    base_url: baseUrl,
    ipn_id: ipnId,
    ipn_url: ipnUrl,
    disabled: false,
    last_tested_at: new Date().toISOString(),
    last_test_status: "success",
    last_test_message: "Connected. Pesapal authentication succeeded.",
  };
  const { data: saved, error: saveError } = await service.rpc("fn_payment_save_account", { _payload: payload, _account_id: existing?.id ?? null, _expected_version: existing?.version ?? null });
  if (saveError) return NextResponse.json({ error: "Account changed or could not be saved. Reload and try again." }, { status: 409 });
  return NextResponse.json({ status: "success", message: "Connected. Pesapal authentication succeeded.", accountId: saved });
}

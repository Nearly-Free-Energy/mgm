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
import {
  PesapalPaymentProvider,
  baseUrlForSandbox,
} from "@/lib/payments/providers/pesapal/provider";
import { PesapalClient } from "@/lib/payments/pesapal/client";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

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
      "id, org_id, provider, display_name, sandbox, consumer_key, base_url, ipn_id, ipn_url, version, disabled, last_tested_at, last_test_status, last_test_message, created_at, updated_at"
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
  const sandbox = body.sandbox === true;
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim().slice(0, 120)
      : "Default Pesapal account";
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

  const { data: existing } = await supabase
    .from("payment_merchant_accounts")
    .select("id, version")
    .eq("org_id", orgId)
    .eq("provider", "pesapal")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; version: number }>();

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

  const baseUrl = baseUrlForSandbox(sandbox);
  const probe = new PesapalPaymentProvider({
    consumerKey,
    consumerSecret: effectiveSecret,
    baseUrl,
    ipnId: "00000000-0000-0000-0000-000000000000",
  });
  // Connection test first (auth). The probe above skips ipn validation by
  // carrying a dummy GUID — testConnection only touches RequestToken.
  const tested = await probe.testConnection();
  if (!tested.ok) {
    await persistTestResult(supabase, orgId, existing?.id ?? null, tested.reason, tested.message, {
      consumerKey,
      sandbox,
      baseUrl,
    });
    const scrubbed = scrubSecretValues({ event: "payment.account_test", orgId }, { extra: [effectiveSecret] });
    console.info(JSON.stringify(scrubbed));
    return NextResponse.json(
      { error: tested.message, reason: tested.reason },
      { status: 503 }
    );
  }

  // Notification registration.
  const callbackBase = (process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL ?? "").trim();
  if (!callbackBase) {
    return NextResponse.json(
      {
        error: "Server configuration error: NEXT_PUBLIC_PAYMENT_CALLBACK_URL is not set.",
        reason: "callback_url_unknown",
      },
      { status: 503 }
    );
  }
  const ipnUrl = `${callbackBase.replace(/\/+$/, "")}/api/payments/ipn`;
  let ipnId: string;
  try {
    const client = new PesapalClient({
      consumerKey,
      consumerSecret: effectiveSecret,
      baseUrl,
    });
    const token = await client.getAccessToken();
    ipnId = (await client.registerIpn(token, ipnUrl, "POST")).ipn_id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await persistTestResult(supabase, orgId, existing?.id ?? null, "register_ipn_failed", message, {
      consumerKey,
      sandbox,
      baseUrl,
    });
    return NextResponse.json(
      { error: "Pesapal accepted the credentials but rejected the IPN registration.", reason: "register_ipn_failed" },
      { status: 503 }
    );
  }

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
  if (existing) {
    const { data: current } = await service
      .from("payment_merchant_accounts")
      .select("version")
      .eq("id", existing.id)
      .maybeSingle<{ version: number }>();
    const { error: updErr } = await service
      .from("payment_merchant_accounts")
      .update({ ...payload, version: (current?.version ?? 1) + 1 })
      .eq("id", existing.id);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  } else {
    const { error: insErr } = await service.from("payment_merchant_accounts").insert(payload);
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }
  // Mirror into the legacy community columns so invoices/public links that
  // still read `communities.payment_provider*` keep working during rollout.
  await mirrorLegacyCommunityConfig(service, orgId, {
    consumerKey,
    baseUrl,
    sandbox,
    ipnId,
    secret: enc as string,
  });

  console.info(JSON.stringify(scrubSecretValues({ event: "payment.account_saved", orgId }, { extra: [effectiveSecret] })));
  return NextResponse.json({ status: "success", message: "Connected. Pesapal authentication succeeded." });
}

async function persistTestResult(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  accountId: string | null,
  status: string,
  message: string,
  partial: { consumerKey: string; sandbox: boolean; baseUrl: string }
): Promise<void> {
  try {
    if (!accountId) return;
    const service = createServiceClient();
    await service
      .from("payment_merchant_accounts")
      .update({
        consumer_key: partial.consumerKey,
        sandbox: partial.sandbox,
        base_url: partial.baseUrl,
        last_tested_at: new Date().toISOString(),
        last_test_status: status,
        last_test_message: message.slice(0, 500),
      })
      .eq("id", accountId)
      .eq("org_id", orgId);
  } catch {
    // best-effort
  }
}

async function mirrorLegacyCommunityConfig(
  service: ReturnType<typeof createServiceClient>,
  orgId: string,
  cfg: { consumerKey: string; baseUrl: string; sandbox: boolean; ipnId: string; secret: string }
): Promise<void> {
  try {
    const { data: communities } = await service
      .from("communities")
      .select("id")
      .eq("org_id", orgId);
    for (const row of (communities ?? []) as { id: string }[]) {
      await service
        .from("communities")
        .update({
          payment_provider: "pesapal",
          payment_provider_config: {
            consumer_key: cfg.consumerKey,
            base_url: cfg.baseUrl,
            sandbox: cfg.sandbox,
            ipn_id: cfg.ipnId,
          },
          payment_provider_secret_encrypted: cfg.secret,
          payment_last_configured_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
  } catch {
    // best-effort compat mirror
  }
}

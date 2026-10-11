import "server-only";
import { PesapalPaymentProvider, baseUrlForSandbox } from "../providers/pesapal/provider";
import { PesapalClient } from "../pesapal/client";

export async function testMerchantConfiguration(input: { consumerKey: string; consumerSecret: string; sandbox: boolean }) {
  const baseUrl = baseUrlForSandbox(input.sandbox);
  const probe = new PesapalPaymentProvider({ ...input, baseUrl, ipnId: "00000000-0000-0000-0000-000000000000" });
  const tested = await probe.testConnection();
  if (!tested.ok) return { ok: false as const, reason: tested.reason, message: tested.message };
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL;
  if (!origin) return { ok: false as const, reason: "callback_url_unknown", message: "Application URL is not configured." };
  try {
    const ipnUrl = new URL("/api/payments/ipn", origin).toString();
    const client = new PesapalClient({ ...input, baseUrl });
    const token = await client.getAccessToken();
    const ipnId = (await client.registerIpn(token, ipnUrl, "POST")).ipn_id;
    if (!ipnId) throw new Error("Missing IPN identity");
    return { ok: true as const, baseUrl, ipnId, ipnUrl };
  } catch { return { ok: false as const, reason: "register_ipn_failed", message: "Could not register the payment notification URL. Active configuration was preserved." }; }
}

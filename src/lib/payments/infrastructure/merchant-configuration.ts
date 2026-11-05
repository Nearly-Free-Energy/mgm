import "server-only";
import { PesapalPaymentProvider, baseUrlForSandbox } from "../providers/pesapal/provider";
import { PesapalClient } from "../pesapal/client";
import { appUrl } from "@/lib/config/app-url";
import { RuntimeConfigError } from "@/lib/config/public-runtime-config";

export async function testMerchantConfiguration(input: { consumerKey: string; consumerSecret: string; sandbox: boolean }) {
  const baseUrl = baseUrlForSandbox(input.sandbox);
  const probe = new PesapalPaymentProvider({ ...input, baseUrl, ipnId: "00000000-0000-0000-0000-000000000000" });
  const tested = await probe.testConnection();
  if (!tested.ok) return { ok: false as const, reason: tested.reason, message: tested.message };
  // Notification target from the server-only MGM_APP_URL (#46).
  let ipnUrl: string;
  try {
    ipnUrl = appUrl("/api/payments/ipn");
  } catch (error) {
    // RuntimeConfigError messages name the variable and never its value.
    const message = error instanceof RuntimeConfigError ? error.message : "Application URL is not configured.";
    return { ok: false as const, reason: "callback_url_unknown", message };
  }
  try {
    const client = new PesapalClient({ ...input, baseUrl });
    const token = await client.getAccessToken();
    const ipnId = (await client.registerIpn(token, ipnUrl, "POST")).ipn_id;
    if (!ipnId) throw new Error("Missing IPN identity");
    return { ok: true as const, baseUrl, ipnId, ipnUrl };
  } catch { return { ok: false as const, reason: "register_ipn_failed", message: "Could not register the payment notification URL. Active configuration was preserved." }; }
}

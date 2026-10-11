/**
 * Pesapal status mapping — stays inside the Pesapal provider plugin.
 *
 * Follows https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/gettransactionstatus:
 * customer redirects alone never mark a bill paid; only a server-side
 * GetTransactionStatus lookup determines the outcome.
 */
import type { VerifiedProviderStatus } from "../types";

export function mapPesapalStatus(
  description: string | null | undefined
): VerifiedProviderStatus {
  const normalized = (description ?? "").trim().toUpperCase();
  if (normalized === "COMPLETED") return "completed";
  if (normalized === "FAILED") return "failed";
  if (normalized === "REVERSED") return "reversed";
  if (normalized === "PENDING") return "pending";
  return "unknown";
}

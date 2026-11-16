import "server-only";
/**
 * Sign-in by email link or code (RFC #186 § 4). Runs before any session
 * exists, on the service client:
 *
 *   issueSignInLink — claim the rate limit, look up a person with an MGM
 *   role, ask Supabase Auth for a one-time token (generateLink sends
 *   nothing), and email the link and its 6-digit code through the
 *   deployment's sender. Never an organization's sender: whoever runs that
 *   server could read the link (decision 5).
 *
 *   claimCodeAttempt / recordCodeOutcome — the 5-tries-per-code limit around
 *   verifyOtp, which the verify-code route calls on its own cookie client.
 *
 * Supabase Auth still issues, expires and verifies the token, and owns the
 * session. Logs carry an outcome, never the address, link, code or token.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/config/app-url";
import { getDeploymentSender } from "@/lib/config/mail-sender";
import { RuntimeConfigError } from "@/lib/config/public-runtime-config";
import { safeReturnPath } from "@/lib/auth/return-path";
import type { MailTransportRegistry } from "@/lib/runtime/services";

/** How long a link and its code are good for; Supabase's email OTP expiry must match. */
export const SIGN_IN_LINK_MINUTES = 15;

export function hashForLimit(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export type SignInLinkOutcome = "limited" | "no_access" | "sent" | "send_failed";

export function signInEmail(input: { to: string; link: string; code: string }) {
  return {
    to: input.to,
    subject: "Your MGM sign-in link",
    text: [
      "Use this link to sign in to MGM (Microgrid Manager):",
      "",
      input.link,
      "",
      `Or enter this code on the sign-in page: ${input.code}`,
      "",
      `The link and the code work once, for ${SIGN_IN_LINK_MINUTES} minutes. Asking for a new one cancels this one.`,
      "",
      "If you did not ask to sign in, you can ignore this email: nobody can sign in without it.",
    ].join("\n"),
  };
}

function log(event: string, outcome: string): void {
  console.info(JSON.stringify({ event, outcome }));
}

export async function issueSignInLink(input: {
  service: SupabaseClient;
  transports: MailTransportRegistry;
  email: string;
  ip: string | null;
  next: string | null;
}): Promise<SignInLinkOutcome> {
  const { service, transports } = input;
  const email = input.email.trim().toLowerCase();

  const { data: claimId, error: claimError } = await service.rpc("fn_auth_claim_sign_in_request", {
    _email_hash: hashForLimit(email),
    _ip_hash: input.ip ? hashForLimit(input.ip) : null,
  });
  if (claimError) throw new Error(`sign-in claim failed: ${claimError.code ?? "unknown"}`);
  if (claimId === null) {
    log("auth.sign_in_link", "limited");
    return "limited";
  }
  const record = async (outcome: SignInLinkOutcome) => {
    await service.from("auth_sign_in_requests").update({ outcome }).eq("id", claimId);
    log("auth.sign_in_link", outcome);
    return outcome;
  };

  // Never call generateLink for an address without an MGM role: it would
  // create an account for it.
  const { data: userId, error: targetError } = await service.rpc("fn_auth_sign_in_target", { _email: email });
  if (targetError) throw new Error(`sign-in lookup failed: ${targetError.code ?? "unknown"}`);
  if (!userId) return record("no_access");

  let settings;
  let link: string;
  try {
    // Read first, so a deployment without a mail sender issues no token.
    settings = getDeploymentSender();
    const { data, error } = await service.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !data.properties?.hashed_token || !data.properties.email_otp) return record("send_failed");
    const query = new URLSearchParams({ token_hash: data.properties.hashed_token });
    const next = input.next ? safeReturnPath(input.next) : null;
    if (next && next !== "/") query.set("next", next);
    // The link is a credential, so its host comes from configuration
    // (MGM_APP_URL), never from the request's headers.
    link = appUrl(`/auth/confirm?${query.toString()}`);
    const sent = await transports
      .create(settings)
      .send(signInEmail({ to: email, link, code: data.properties.email_otp }));
    return record(sent.ok ? "sent" : "send_failed");
  } catch (error) {
    // A RuntimeConfigError names the missing or invalid setting, never its
    // value; any other error is logged by name only.
    const detail = error instanceof RuntimeConfigError ? error.message : (error as Error).name;
    console.error(JSON.stringify({ event: "auth.sign_in_link", outcome: "send_failed", error: detail }));
    await service.from("auth_sign_in_requests").update({ outcome: "send_failed" }).eq("id", claimId);
    return "send_failed";
  }
}

/** The attempt's id, or null when this address (or IP) has used up its tries. */
export async function claimCodeAttempt(service: SupabaseClient, email: string, ip: string | null): Promise<number | null> {
  const { data, error } = await service.rpc("fn_auth_claim_code_attempt", {
    _email_hash: hashForLimit(email),
    _ip_hash: ip ? hashForLimit(ip) : null,
  });
  if (error) throw new Error(`code claim failed: ${error.code ?? "unknown"}`);
  return data ?? null;
}

export async function recordCodeOutcome(
  service: SupabaseClient,
  attemptId: number,
  outcome: "verified" | "wrong_code"
): Promise<void> {
  await service.from("auth_sign_in_requests").update({ outcome }).eq("id", attemptId);
  log("auth.sign_in_code", outcome);
}

/** The caller's IP as the platform reports it, for rate limits only. */
export function requestIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || null;
}

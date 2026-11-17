import "server-only";
/**
 * Sign-in by email link (RFC #186 § 4). Runs before any session exists, on
 * the service client: claim the rate limit, look up a person with an MGM
 * role, ask Supabase Auth for a one-time token (generateLink sends nothing),
 * and email the link through the deployment's sender. Never an
 * organization's sender: whoever runs that server could read the link
 * (decision 5). The email carries the link only, no code to type
 * (decision 6).
 *
 * Supabase Auth still issues, expires and verifies the token, and owns the
 * session. Logs carry an outcome, never the address, link or token.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/config/app-url";
import { getDeploymentSender } from "@/lib/config/mail-sender";
import { RuntimeConfigError } from "@/lib/config/public-runtime-config";
import { safeReturnPath } from "@/lib/auth/return-path";
import type { MailTransportRegistry } from "@/lib/runtime/services";

/** How long a link is good for; Supabase's email OTP expiry must match. */
export const SIGN_IN_LINK_MINUTES = 15;

export function hashForLimit(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export type SignInLinkOutcome = "limited" | "no_access" | "sent" | "send_failed";

export function signInEmail(input: { to: string; link: string }) {
  return {
    to: input.to,
    subject: "Your MGM sign-in link",
    text: [
      "Use this link to sign in to MGM (Microgrid Manager):",
      "",
      input.link,
      "",
      `The link works once, for ${SIGN_IN_LINK_MINUTES} minutes, on the device where you open it. Asking for a new one cancels this one.`,
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
    if (error || !data.properties?.hashed_token) return record("send_failed");
    const query = new URLSearchParams({ token_hash: data.properties.hashed_token });
    const next = input.next ? safeReturnPath(input.next) : null;
    if (next && next !== "/") query.set("next", next);
    // The link is a credential, so its host comes from configuration
    // (MGM_APP_URL), never from the request's headers.
    link = appUrl(`/auth/confirm?${query.toString()}`);
    const sent = await transports
      .create(settings)
      .send(signInEmail({ to: email, link }));
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

/**
 * The caller's IP for the rate limits, from a value the client cannot set:
 * Vercel's own `x-vercel-forwarded-for`, which the platform overwrites; else
 * the right-most `x-forwarded-for` entry, which the nearest proxy appended
 * (the left-most is whatever the client sent). If MGM runs behind more than
 * one proxy, the right-most entry is the inner proxy's view; revisit then.
 */
export function requestIp(headers: Headers): string | null {
  const vercel = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel) return vercel;
  const forwarded = headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean);
  return forwarded?.at(-1) ?? null;
}

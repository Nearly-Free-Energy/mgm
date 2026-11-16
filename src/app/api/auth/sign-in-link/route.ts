/**
 * POST /api/auth/sign-in-link — email a sign-in link and code (RFC #186 § 4).
 *
 * Body: { email, next? }. Answers 202 with the same body whether or not the
 * address has an MGM account. The lookup and the send run in after(), once
 * the response has gone, so its timing does not tell either. A malformed
 * address answers 422 and a burst from one IP 429; neither depends on any
 * account.
 *
 * Public: no session exists yet. It uses the service role only through
 * issueSignInLink (src/lib/auth/sign-in-link.ts): the rate-limit claim, the
 * role lookup, generateLink, and the send through the deployment's sender.
 * It decrypts no stored credential.
 */
import { after, NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getMgmRuntime } from "@/lib/runtime/root";
import { checkRateLimit } from "@/lib/rate-limit/in-memory";
import { issueSignInLink, requestIp } from "@/lib/auth/sign-in-link";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address.", field: "email" }, { status: 422 });
  }
  const next = typeof body?.next === "string" ? body.next : null;

  const ip = requestIp(request.headers);
  // A first, per-instance check; the limits that hold across instances are
  // in the database (fn_auth_claim_sign_in_request).
  const burst = checkRateLimit(`sign-in-link:${ip ?? "unknown"}`, 10, 60_000);
  if (!burst.ok) {
    return NextResponse.json(
      { error: "Too many requests. Wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(burst.retryAfter ?? 60) } }
    );
  }

  after(async () => {
    try {
      const runtime = await getMgmRuntime();
      await issueSignInLink({ service: createServiceClient(), transports: runtime.mailTransports, email, ip, next });
    } catch (error) {
      console.error(JSON.stringify({ event: "auth.sign_in_link", outcome: "error", error: (error as Error).message }));
    }
  });

  return NextResponse.json(
    { message: "If this address has access to MGM, a sign-in email is on its way." },
    { status: 202 }
  );
}

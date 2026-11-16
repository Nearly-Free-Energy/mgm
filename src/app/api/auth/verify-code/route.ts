/**
 * POST /api/auth/verify-code — sign in with the 6-digit code from the
 * sign-in email (RFC #186 § 4).
 *
 * Body: { email, code, next? }. Each attempt is claimed first
 * (fn_auth_claim_code_attempt): 5 tries per issued code, after which the
 * address must ask for a new link, and 30 an hour per IP. Supabase's own
 * verification limit counts per IP only, so without this a 6-digit code
 * could be guessed from many addresses. Then Supabase Auth verifies the code
 * on the cookie client, which sets the session cookies.
 *
 * Public: no session exists yet. The service client only claims and records
 * attempts; it decrypts no stored credential and issues no session.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { safeReturnPath } from "@/lib/auth/return-path";
import { claimCodeAttempt, recordCodeOutcome, requestIp } from "@/lib/auth/sign-in-link";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ error: "Enter a valid email address.", field: "email" }, { status: 422 });
  }
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "Enter the 6-digit code from the email.", field: "code" }, { status: 422 });
  }

  const service = createServiceClient();
  const attemptId = await claimCodeAttempt(service, email, requestIp(request.headers));
  if (attemptId === null) {
    return NextResponse.json(
      { error: "Too many tries with this code. Ask for a new sign-in email.", code: "too_many_attempts" },
      { status: 429 }
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) {
    await recordCodeOutcome(service, attemptId, "wrong_code");
    return NextResponse.json(
      { error: "That code is wrong or has expired.", code: "invalid_code" },
      { status: 401 }
    );
  }
  await recordCodeOutcome(service, attemptId, "verified");
  const next = typeof body?.next === "string" ? body.next : null;
  return NextResponse.json({ next: safeReturnPath(next) });
}

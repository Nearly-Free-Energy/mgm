"use client";

/**
 * /auth/confirm — where the sign-in email's link lands (RFC #186 § 4).
 *
 * The link carries a one-time token hash. Opening the page does not use it:
 * mail scanners (Outlook Safe Links and the like) open links in emails, and
 * would spend the token before the person clicks. The token is verified only
 * when the person presses Continue, then the page goes to the same-site path
 * in ?next=.
 */
import * as React from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { RETURN_PATH_PARAM, safeReturnPath } from "@/lib/auth/return-path";
import { loadPage } from "./load-page";

type Phase = "ready" | "verifying" | "failed" | "missing";

export default function ConfirmSignInPage() {
  const [phase, setPhase] = React.useState<Phase>("ready");
  const [tokenHash, setTokenHash] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Read from the address bar rather than useSearchParams(), which would
    // need a Suspense boundary to build (as the login page does).
    const hash = new URLSearchParams(window.location.search).get("token_hash");
    if (hash) setTokenHash(hash);
    else setPhase("missing");
  }, []);

  async function confirm() {
    if (!tokenHash) return;
    setPhase("verifying");
    const { error } = await createClient().auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    if (error) {
      setPhase("failed");
      return;
    }
    const next = new URLSearchParams(window.location.search).get(RETURN_PATH_PARAM);
    // A full load, not router.replace: a client-side navigation from this
    // page into the (gui) group that the server answers with a redirect to
    // another page of the group never settles (Next.js 16 refetches the
    // target's payload without end). The (gui) layout sends a person whose
    // rows are all tenant rows from "/" to their home (/my), so a tenant's
    // Continue would hang. A full load also renders every layout with the
    // new session. If that redirect goes, or Next.js settles such a
    // navigation, router.replace would do again.
    loadPage(safeReturnPath(next));
  }

  const unusable = phase === "failed" || phase === "missing";
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md rounded-lg bg-card p-8 shadow-md">
        <h1 className="mb-4 text-center text-2xl font-semibold text-foreground">Sign in to MGM</h1>
        {unusable ? (
          <div role="alert" className="space-y-4">
            <p className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
              {phase === "missing"
                ? "This sign-in link is incomplete. Open the link from the email again, or ask for a new one."
                : "This sign-in link has expired or was already used. Ask for a new one."}
            </p>
            <Link
              href="/login"
              className="flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              You asked to sign in to MGM from this email. Continue to sign in on this device.
            </p>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={phase === "verifying" || !tokenHash}
              className="min-h-11 w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === "verifying" ? "Signing in..." : "Continue"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

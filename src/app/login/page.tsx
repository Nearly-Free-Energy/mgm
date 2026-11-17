"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RETURN_PATH_PARAM, safeReturnPath } from "@/lib/auth/return-path";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Sign-in by email link (RFC #186).
  const [linkSent, setLinkSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  /** The same-site page the middleware sent the person here from (#126). */
  function returnPath(): string | null {
    return new URLSearchParams(window.location.search).get(RETURN_PATH_PARAM);
  }

  async function sendLink() {
    setError(null);
    setNotice(null);
    if (!EMAIL_RE.test(email.trim())) {
      setError("Enter your email address first.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/auth/sign-in-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), next: returnPath() }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(value.error ?? "Could not send the sign-in email. Try again.");
        return;
      }
      setLinkSent(true);
      setNotice(value.message ?? "If this address has access to MGM, a sign-in email is on its way.");
    } catch {
      setError("Could not send the sign-in email. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Back to the page the middleware sent the person here from (#126), when
    // it is on this site. Read from the address bar at submit time rather
    // than useSearchParams(), which would need a Suspense boundary to build.
    router.replace(safeReturnPath(returnPath()));
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md rounded-lg bg-card p-8 shadow-md">
        <h1 className="mb-6 text-center text-2xl font-semibold text-foreground">
          Microgrid Manager
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-muted-foreground"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-muted-foreground"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Your password"
            />
            <div className="mt-2 flex justify-end">
              <Link
                href="/forgot-password"
                className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-2 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg"
            >
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="min-h-11 w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <div className="mt-6 border-t border-border pt-6">
          {!linkSent ? (
            <button
              type="button"
              onClick={() => void sendLink()}
              disabled={loading}
              className="min-h-11 w-full rounded-md border border-border px-4 py-2 text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50"
            >
              Email me a sign-in link
            </button>
          ) : (
            <div className="space-y-3">
              {notice && (
                <p role="status" className="text-sm text-muted-foreground">
                  {notice} Open the link in it on this device. It works once, for 15 minutes.
                </p>
              )}
              <button
                type="button"
                onClick={() => void sendLink()}
                disabled={loading}
                className="min-h-11 w-full text-sm text-primary underline-offset-2 hover:underline disabled:opacity-50"
              >
                Send a new email
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

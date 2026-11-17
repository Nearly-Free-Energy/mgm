"use client";

/**
 * /login — sign-in by email link (RFC #186). MGM has no passwords: the
 * person enters their address, POST /api/auth/sign-in-link emails a link
 * through the deployment's sender, and the link's landing page
 * (/auth/confirm) signs them in on the device where they open it.
 */
import { useState } from "react";
import { RETURN_PATH_PARAM } from "@/lib/auth/return-path";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The same-site page the middleware sent the person here from (#126),
   * carried in the link so they land back on it. Read from the address bar
   * rather than useSearchParams(), which would need a Suspense boundary to
   * build; the route and /auth/confirm both pass it through safeReturnPath.
   */
  function returnPath(): string | null {
    return new URLSearchParams(window.location.search).get(RETURN_PATH_PARAM);
  }

  async function sendLink(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setNotice(null);
    if (!EMAIL_RE.test(email.trim())) {
      setError("Enter your email address.");
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md rounded-lg bg-card p-8 shadow-md">
        <h1 className="mb-6 text-center text-2xl font-semibold text-foreground">
          Microgrid Manager
        </h1>
        <form onSubmit={sendLink} className="space-y-4" noValidate>
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
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="you@example.com"
            />
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg"
            >
              {error}
            </div>
          )}
          {linkSent && notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice} Open the link in it on this device. It works once, for 15 minutes.
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="min-h-11 w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Sending..." : linkSent ? "Send a new email" : "Email me a sign-in link"}
          </button>
        </form>
      </div>
    </div>
  );
}

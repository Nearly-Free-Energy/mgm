/**
 * /oauth/code — the sign-in code page (RFC #259 § 1, ADR-008 decision 3,
 * #271): the one return address MGM's clients are registered with
 * (docs/setup.md, "Clients that are not a browser"). After the person
 * approves on /oauth/consent, Supabase Auth sends the browser here with the
 * authorization code and the CLI's state, and the page shows them as one
 * string to paste into the terminal (./code-view.tsx).
 *
 * Public in middleware: it reads no session and nothing from the server, so
 * a session that lapsed between the consent page and here does not send the
 * code through /login?next= and into a sign-in email. It loads nothing from
 * a third party (the root layout's font is served from this site), and sends
 * no referrer.
 */
import type { Metadata } from "next";
import { CodeView } from "./code-view";

export const metadata: Metadata = {
  title: "Sign-in code",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function SignInCodePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-8">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-elev-1 sm:p-8">
        <CodeView />
      </div>
    </main>
  );
}

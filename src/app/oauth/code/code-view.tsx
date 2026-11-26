"use client";

/**
 * The sign-in code, shown once. It is read from the address bar on the first
 * render in the browser, and history.replaceState then takes the query off
 * the address bar and the current history entry, so the code does not show
 * on a shared screen after it is copied, and Back, Forward and a reload no
 * longer bring it back: a reload shows that the link is incomplete, and the
 * person runs mgm login again.
 *
 * That is all replaceState does. The browser's history list and address-bar
 * suggestions still hold the address as Supabase Auth's redirect delivered
 * it, code included, before this page ran. The code is safe there because it
 * works once, only until its authorization expires, and only with the PKCE
 * verifier the CLI holds (ADR-008 decision 3). If a code ever outlives its
 * exchange or its authorization, or a client sends the `plain` challenge
 * method (whose verifier is the challenge, in the authorize address in the
 * same history), revisit this.
 */
import * as React from "react";
import { CODE_PATH } from "@/lib/auth/client-consent";
import { encodePastedCode } from "@/lib/auth/pasted-code";

type Shown =
  | { kind: "reading" }
  | { kind: "code"; text: string }
  | { kind: "refused" }
  | { kind: "failed" }
  | { kind: "missing" };

function readAddress(search: string): Shown {
  const query = new URLSearchParams(search);
  const error = query.get("error");
  if (error === "access_denied") return { kind: "refused" };
  if (error !== null) return { kind: "failed" };
  const text = encodePastedCode({ state: query.get("state") ?? "", code: query.get("code") ?? "" });
  return text ? { kind: "code", text } : { kind: "missing" };
}

export function CodeView() {
  const [shown, setShown] = React.useState<Shown>({ kind: "reading" });
  const [copy, setCopy] = React.useState<"idle" | "copied" | "failed">("idle");
  const read = React.useRef(false);

  React.useEffect(() => {
    if (read.current) return;
    read.current = true;
    setShown(readAddress(window.location.search));
    if (window.location.search) window.history.replaceState(null, "", CODE_PATH);
  }, []);

  async function copyCode(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  if (shown.kind === "reading") {
    return <h1 className="text-headline font-semibold text-foreground">Sign-in code</h1>;
  }

  if (shown.kind !== "code") {
    const message =
      shown.kind === "refused"
        ? "The sign-in was refused, so no app was connected."
        : shown.kind === "failed"
          ? "The sign-in did not finish, so no app was connected. Run mgm login again."
          : "This page's link is incomplete, or the code was already shown. Run mgm login again.";
    return (
      <div className="space-y-4">
        <h1 className="text-headline font-semibold text-foreground">No sign-in code</h1>
        <p role="alert" className="rounded-md bg-destructive-muted p-3 text-body text-destructive-fg">
          {message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-headline font-semibold text-foreground">Your sign-in code</h1>
        <p className="text-body text-muted-foreground">
          Copy this code and paste it into the terminal where you ran <code className="font-mono">mgm login</code>.
        </p>
      </div>

      <p
        aria-label="Sign-in code"
        className="select-all break-all rounded-md border border-border bg-muted p-3 font-mono text-dense text-foreground"
      >
        {shown.text}
      </p>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => void copyCode(shown.text)}
          className="min-h-11 w-full rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card"
        >
          {copy === "copied" ? "Copied" : "Copy code"}
        </button>
        <p aria-live="polite" className="text-dense text-muted-foreground">
          {copy === "failed" ? "Your browser did not allow copying. Select the code and copy it." : null}
        </p>
      </div>

      <div role="note" className="space-y-1 rounded-md border-l-4 border-warning bg-warning-muted p-4 text-warning-fg">
        <p className="text-body font-semibold">Paste it only into the terminal that asked for it</p>
        {/* Ten minutes: Supabase Auth's default authorization lifetime and the
            token hook's record window (20261126090100). If either changes,
            revisit this. */}
        <p className="text-dense">
          Not into a website, a chat or an email. It works once, within ten minutes of running{" "}
          <code className="font-mono">mgm login</code>. If you did not run it, close this page.
        </p>
      </div>
    </div>
  );
}

"use client";

/**
 * Sign out. The Supabase browser client loads only on click, so pages that
 * merely show the button do not carry it (decision 16 on #115).
 */
import { useEffect, useId, useRef, useState } from "react";
import { useKitRuntime } from "../host/client/kit-runtime";
import { ORG_COOKIE } from "../host/shared/org-cookie";

export const SIGN_OUT_FAILED = "Sign-out did not finish. You are still signed in. Check your connection and try again.";

type SignOutCall = () => Promise<{ error: unknown }>;

/** True only when the call resolved without an error, the one case in which the client removed the session. */
async function removedSession(call: SignOutCall): Promise<boolean> {
  try {
    return !(await call()).error;
  } catch {
    return false;
  }
}

/**
 * Ends the session, forgets the last organization, and loads /login afresh.
 * Rejects, and leaves the cookie and the page alone, when the session was
 * not removed.
 *
 * The behaviour this relies on is @supabase/auth-js's `_signOut` (2.99;
 * recheck on an upgrade): signOut does not throw when the logout request
 * fails, it resolves `{ error }`, and a network or 5xx failure leaves the
 * stored session in place. (A token refresh inside signOut that fails for good
 * removes the session before returning its error; the local attempt below
 * then finds nothing to end and resolves without one.) When it resolves
 * without an error the session is gone: the server ended it, or answered 401,
 * 403 or 404, or there was no session to end.
 * `scope: "local"` sends the same request for this session only, so it is a
 * second attempt that does not depend on ending every other session; it is
 * not a way round being offline, where both calls fail and the person stays
 * here, signed in, and is told so.
 */
export async function signOutAndLeave(): Promise<void> {
  // A failed import rejects here, before anything is cleared.
  const { createClient } = await import("@/lib/supabase/client");
  const { auth } = createClient();
  const removed =
    (await removedSession(() => auth.signOut())) || (await removedSession(() => auth.signOut({ scope: "local" })));
  if (!removed) throw new Error("Sign-out did not remove the session");
  document.cookie = `${ORG_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  // A full load, so nothing the client cached for this person survives.
  window.location.assign("/login");
}

export function SignOut({ className }: { className?: string }) {
  const runtime = useKitRuntime();
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const messageId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const busy = state === "busy";
  const failed = state === "failed";
  // A browser moves focus off a button that becomes disabled while focused.
  // Put it back on failure, so a keyboard user can retry at once, unless the
  // person has moved focus somewhere else meanwhile.
  useEffect(() => {
    if (failed && (!document.activeElement || document.activeElement === document.body)) button.current?.focus();
  }, [failed]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-describedby={failed ? messageId : undefined}
        onClick={() => {
          setState("busy");
          void (runtime.signOut ?? signOutAndLeave)().catch(() => setState("failed"));
        }}
      >
        Sign out
      </button>
      {/* Always mounted, so screen readers announce the message when it
          appears; sr-only while empty, so it takes no room beside the button. */}
      <span id={messageId} role="alert" className={failed ? "text-caption text-destructive-fg" : "sr-only"}>
        {failed ? SIGN_OUT_FAILED : ""}
      </span>
    </>
  );
}

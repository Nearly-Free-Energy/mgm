"use client";

/**
 * Sign out. The Supabase browser client loads only on click, so pages that
 * merely show the button do not carry it (decision 16 on #115).
 */
import { useState } from "react";
import { useKitRuntime } from "../host/client/kit-runtime";
import { ORG_COOKIE } from "../host/shared/org-cookie";

/** Ends the session, forgets the last organization, and loads /login afresh. */
export async function signOutAndLeave(): Promise<void> {
  try {
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut();
  } finally {
    document.cookie = `${ORG_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
    // A full load, so nothing the client cached for this person survives.
    window.location.assign("/login");
  }
}

export function SignOut({ className }: { className?: string }) {
  const runtime = useKitRuntime();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setBusy(true);
        void (runtime.signOut ?? signOutAndLeave)().catch(() => setBusy(false));
      }}
    >
      Sign out
    </button>
  );
}

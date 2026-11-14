"use client";

/**
 * no-access-logout.tsx — minimal logout button for /no-access.
 *
 * A dedicated client component rather than the kit's SignOut, so the
 * /no-access route tree is fully standalone: it renders outside the (gui)
 * layout and its KitProvider.
 */
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function NoAccessLogout() {
  const router = useRouter();
  const supabase = createClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      className="inline-flex h-9 items-center rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Log out
    </button>
  );
}

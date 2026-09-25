import { NoAccessLogout } from "./no-access-logout";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMgmReviewer } from "@/lib/mgm/access";

/**
 * /no-access — account exists but has no user_roles rows.
 *
 * Outside the (dashboard) route group so no sidebar / top bar renders.
 *
 * Triggered when:
 *   - An invited user has had their roles revoked (UX5 soft-delete).
 *   - An auth.users row exists but was never granted a role (unusual;
 *     possible if the invite RPC failed after the auth row was created
 *     and cleanup also failed).
 */
export default async function NoAccessPage() {
  // An invited MGM reviewer can arrive here through the inherited MBE root
  // layout. Recover that session without granting any additional data access.
  if (process.env.MGM_PILOT_SURFACE !== "false") {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user && isMgmReviewer(user)) redirect("/review");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="w-full max-w-md rounded-md border border-border bg-card p-8 shadow-elev-1">
        <h1 className="text-xl font-semibold text-foreground">
          No access
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Your account exists but has no access to this system. Contact your
          administrator to request access.
        </p>
        <div className="mt-6">
          <NoAccessLogout />
        </div>
      </div>
    </div>
  );
}

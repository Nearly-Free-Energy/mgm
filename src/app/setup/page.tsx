import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { organizationExists } from "@/lib/mgm/organization-exists";
import { SetupForm } from "./setup-form";

/**
 * /setup — first-run organization bootstrap (Release 1, issue #3).
 *
 * Creates the initial organization and grants the signed-in caller the
 * organization-manager role. The page only exists while no organization
 * exists; afterwards it redirects to the dashboard. The bootstrap API
 * additionally requires MGM_BOOTSTRAP_TOKEN, so knowledge of this URL alone
 * grants nothing.
 */
export default async function SetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (await organizationExists()) redirect("/");

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="w-full max-w-md rounded-md border border-border bg-card p-8 shadow-elev-1">
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">
          MICRO GRID MANAGER
        </p>
        <h1 className="text-xl font-semibold text-foreground">
          Set up your organization
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This creates the first organization and makes you its organization
          manager. You will then be able to create communities, microgrids,
          and households.
        </p>
        <div className="mt-6">
          <SetupForm />
        </div>
      </div>
    </div>
  );
}

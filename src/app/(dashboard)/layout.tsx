import { redirect } from "next/navigation";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { organizationExists } from "@/lib/mgm/organization-exists";
import { LogoutButton } from "./logout-button";
import { preloadSidebarNav, SidebarNav } from "./sidebar-nav";
import { NavigationProgress } from "@/components/ui/navigation-progress";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // SidebarNav renders only after this layout returns. Its reads need nothing
  // from the checks below, so they start now instead of after them.
  preloadSidebarNav();

  // The organization check is global and does not depend on the user, so it
  // runs alongside the user and role read; the redirects below still apply
  // in their original order. A failed check surfaces where it is awaited,
  // after the user check, so a signed-out visitor still goes to /login; the
  // no-op catch only stops it counting as unhandled until then.
  const hasOrganization = organizationExists();
  hasOrganization.catch(() => {});

  // One read of the user and their user_roles rows, shared with SidebarNav
  // and the page in this render (`@/lib/auth/request-access`).
  const { user, roles } = await getRequestUserAccess();

  if (!user) {
    redirect("/login");
  }

  // Release 1 (issue #3) — first-run bootstrap. When no organization exists
  // yet, the signed-in user is eligible to become the initial operator, so
  // send them to /setup instead of /no-access. Once the first organization
  // exists, unassigned users fall through to the revoked-user gate below
  // and /no-access is retained for them.
  if (!(await hasOrganization)) {
    redirect("/setup");
  }

  // UX5 (#79) — gate revoked users. A logged-in auth.users row with no
  // user_roles rows has had their access revoked (or was never granted).
  // Send them to /no-access (outside this route group) so they get a
  // clear message + logout action instead of a broken sidebar. The
  // user_roles "Users can view their own roles" SELECT policy lets the
  // caller see their own rows, so this check is accurate.
  if (roles.length === 0) {
    redirect("/no-access");
  }

  return (
    <div className="flex min-h-screen">
      <NavigationProgress />
      {/* Sidebar */}
      <aside className="flex w-64 flex-col border-r border-border bg-muted">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold text-foreground">MGM</h2>
        </div>
        <SidebarNav />
      </aside>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
          <div />
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user.email}</span>
            <LogoutButton />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { INSTALLED_GUIS } from "@/gui/installed";
import type { GuiName } from "@/gui/meta";
import { rolesAreTenantOnly } from "@/lib/auth/access";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { guiStylesheetHref, readGuiName } from "@/lib/config/gui";
import { HostKitProvider } from "@/lib/gui/host/client/host-kit-provider";
import { getManifest, preloadManifest } from "@/lib/gui/host/server/manifest";
import { requireMiddlewarePath } from "@/lib/gui/host/server/middleware-path";
import { resolveInitialView } from "@/lib/gui/host/server/render-view";
import { isTenantPage } from "@/lib/gui/host/server/tenant-pages";
import { resolveLegacyView } from "@/lib/gui/host/shared/legacy-view";
import { manifestHints } from "@/lib/gui/host/shared/manifest-hints";
import { TENANT_START_PAGE } from "@/lib/gui/host/shared/tenant-units";
import { organizationExists } from "@/lib/mgm/organization-exists";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { NavigationProgress } from "@/components/ui/navigation-progress";

/**
 * Every signed-in page, inside the shell of the GUI MGM_GUI selects. The
 * path and the organization cookie only choose what the shell shows among
 * the organizations and places the caller can see (getManifest); they
 * authorize nothing, and each page still checks access itself. If
 * getManifest or a page starts deciding access from either, revisit. The
 * layout itself refuses one thing by path: a person whose rows are all
 * tenant rows opens tenant pages only (isTenantPage), and goes home from
 * any other. That narrows what they reach; it grants nothing.
 */
export default async function GuiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The request's path and query, which src/middleware.ts forwards; a
  // render the middleware did not see answers 404 here, before any read
  // below (middleware-path.ts says why).
  const [path, requestCookies] = await Promise.all([requireMiddlewarePath(), cookies()]);

  // The organization check is global and does not depend on the user, so it
  // runs alongside the user and role read; the redirects below still apply
  // in their original order. A failed check surfaces where it is awaited,
  // after the user check, so a signed-out visitor still goes to /login; the
  // no-op catch only stops it counting as unhandled until then.
  const hasOrganization = organizationExists();
  hasOrganization.catch(() => {});

  // Read as /go/<nav> reads them (manifest-hints.ts), so the two share one
  // cached manifest.
  const { requested, preferred } = manifestHints(await headers(), requestCookies);

  // An MGM_GUI naming no compiled-in GUI is reported only after the
  // redirects, so a signed-out visitor still reaches /login: the interface
  // pages answer 500 and the pages outside this layout keep working
  // (decision 3 on #115).
  let gui: GuiName | null = null;
  let guiError: unknown = null;
  try {
    gui = readGuiName();
  } catch (error) {
    guiError = error;
  }

  // The shell renders only after this layout returns, and its manifest needs
  // nothing from the checks below, so its reads start now. getManifest reads
  // the session with getUser() before anything else, and a failure surfaces
  // when it is awaited below.
  if (gui) preloadManifest(gui, path, requested, preferred);

  // One read of the user and their user_roles rows, shared with the
  // manifest and the page in this render (`@/lib/auth/request-access`).
  const access = await getRequestUserAccess();
  const { user, roles } = access;

  if (!user) {
    redirect("/login");
  }

  // A person whose rows are all tenant rows (RFC mgm#197 § 4) is signed in
  // to the units they rent: neither a first operator for /setup nor revoked.
  // A tenant row is not staff, so this reads the roles, never their count.
  const tenantOnly = rolesAreTenantOnly(roles);

  // Release 1 (issue #3) — first-run bootstrap. When no organization exists
  // yet, the signed-in user is eligible to become the initial operator, so
  // send them to /setup instead of /no-access. Once the first organization
  // exists, unassigned users fall through to the revoked-user gate below
  // and /no-access is retained for them. A tenant is never eligible.
  if (!tenantOnly && !(await hasOrganization)) {
    redirect("/setup");
  }

  // UX5 (#79) — gate revoked users. A logged-in auth.users row with no
  // user_roles rows has had their access revoked (or was never granted).
  // Send them to /no-access (outside this route group) so they get a
  // clear message + logout action instead of a broken shell. The
  // user_roles "Users can view their own roles" SELECT policy lets the
  // caller see their own rows, so this check is accurate.
  if (roles.length === 0) {
    redirect("/no-access");
  }

  // A person whose rows are all tenant rows sees tenant pages only: the
  // pages a contributed tenant view serves (isTenantPage, which reads the
  // GUI surface, so a new tenant view needs no edit here). Every other path
  // under this layout, the staff start page "/" included, sends them to their
  // home before the manifest is read, so no staff page renders for them with
  // only RLS behind it. Staff, tenant rows or not, are not affected
  // (START_PAGE in @/lib/auth/return-path).
  //
  // The home only while it is a released route a tenant view serves: until
  // then middleware answers it with the static "not in this release" page,
  // which has no script, so no sign-out, and links back to "/", which would
  // send them round again. /no-access has Log out, and like sign-out (a
  // Supabase Auth call from the browser) it is outside this layout, so it
  // cannot send them round either. This reads
  // src/lib/mgm/released-routes.ts, so it follows the release of
  // TENANT_START_PAGE with no edit here.
  if (tenantOnly && !(await isTenantPage(path))) {
    const home = isReleasedRoute(TENANT_START_PAGE) && (await isTenantPage(TENANT_START_PAGE));
    redirect(home ? TENANT_START_PAGE : "/no-access");
  }

  if (!gui) throw guiError;

  // Role rows whose organizations the caller cannot see leave no
  // organization to show, which is no access for this layout, unless the
  // person holds a unit: they get the manifest of their units instead.
  const outcome = await getManifest(gui, path, requested, preferred);
  if (!outcome.ok) redirect(outcome.status === 401 ? "/login" : "/no-access");
  const { manifest } = outcome;
  // A page a contributed view serves gets the view's id, title and trail
  // without loading the view, so the shell paints while the page below
  // loading.tsx waits on the view's loader (render-view.tsx); any other path
  // gets resolveLegacyView's.
  const initial = (await resolveInitialView(path, manifest)) ?? resolveLegacyView(path ?? "/", manifest);
  const { Shell, Overlay, forms } = INSTALLED_GUIS[gui];

  return (
    <>
      {/* React moves the link into <head>. The GUI stylesheet restates
          Tailwind's layer order, so the layers hold in either order against
          globals.css. Within the utilities layer the later stylesheet still
          wins, so the two must not emit the same utility;
          gui-stylesheets.test.ts checks that. */}
      <link rel="stylesheet" href={guiStylesheetHref(gui)} precedence="gui" />
      <NavigationProgress />
      <HostKitProvider manifest={manifest} initial={initial} actions={{ Overlay, forms }}>
        <Shell manifest={manifest} initial={initial}>
          {children}
        </Shell>
      </HostKitProvider>
    </>
  );
}

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { INSTALLED_GUIS } from "@/gui/installed";
import type { GuiName } from "@/gui/meta";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { guiStylesheetHref, readGuiName } from "@/lib/config/gui";
import { HostKitProvider } from "@/lib/gui/host/client/host-kit-provider";
import { getManifest, preloadManifest } from "@/lib/gui/host/server/manifest";
import { resolveLegacyView } from "@/lib/gui/host/shared/legacy-view";
import { ORG_COOKIE } from "@/lib/gui/host/shared/org-cookie";
import { organizationExists } from "@/lib/mgm/organization-exists";
import { NavigationProgress } from "@/components/ui/navigation-progress";

/** The request's path and query, which middleware forwards (src/middleware.ts). */
const MGM_PATH_HEADER = "x-mgm-path";

/** The `?org=` of a path with its query, or null. */
function requestedOrganization(path: string | null): string | null {
  const query = path?.split("#", 1)[0].split("?")[1];
  return query ? new URLSearchParams(query).get("org") : null;
}

/**
 * Every signed-in page, inside the shell of the GUI MGM_GUI selects. The
 * path and the organization cookie only choose what the shell shows among
 * the organizations and places the caller can see (getManifest); they
 * authorize nothing, and each page still checks access itself. If
 * getManifest or a page starts deciding access from either, revisit.
 */
export default async function GuiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The organization check is global and does not depend on the user, so it
  // runs alongside the user and role read; the redirects below still apply
  // in their original order. A failed check surfaces where it is awaited,
  // after the user check, so a signed-out visitor still goes to /login; the
  // no-op catch only stops it counting as unhandled until then.
  const hasOrganization = organizationExists();
  hasOrganization.catch(() => {});

  const [requestHeaders, requestCookies] = await Promise.all([headers(), cookies()]);
  const path = requestHeaders.get(MGM_PATH_HEADER);
  const requested = requestedOrganization(path);
  const preferred = requestCookies.get(ORG_COOKIE)?.value ?? null;

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
  // clear message + logout action instead of a broken shell. The
  // user_roles "Users can view their own roles" SELECT policy lets the
  // caller see their own rows, so this check is accurate.
  if (roles.length === 0) {
    redirect("/no-access");
  }

  if (!gui) throw guiError;

  // Role rows whose organizations the caller cannot see leave no
  // organization to show, which is no access for this layout.
  const outcome = await getManifest(gui, path, requested, preferred);
  if (!outcome.ok) redirect(outcome.status === 401 ? "/login" : "/no-access");
  const { manifest } = outcome;
  const initial = resolveLegacyView(path ?? "/", manifest);
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

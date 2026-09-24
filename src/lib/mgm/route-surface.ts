/** The public MGM deployment exposes only the pilot review workflow. */
export function isMgmPilotRoute(pathname: string, method: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  const verb = method.toUpperCase();

  if (verb === "GET" || verb === "HEAD") {
    return (
      path === "/" ||
      path === "/review" ||
      path === "/login" ||
      path === "/no-access" ||
      path === "/forgot-password" ||
      path === "/reset-password" ||
      path === "/accept-invite" ||
      path === "/api/mgm/health"
    );
  }

  if (verb === "POST") {
    return path === "/api/billing-review/preview";
  }

  return false;
}

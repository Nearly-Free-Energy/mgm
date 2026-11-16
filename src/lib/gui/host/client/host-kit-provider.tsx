"use client";

/**
 * The KitProvider the (gui) layout mounts. A server layout cannot hand
 * KitProvider a function, so this client module supplies `resolve`: after a
 * soft navigation, the view is resolveLegacyView of the new pathname, and a
 * place the manifest does not list rebuilds the manifest once (KitProvider).
 * On a contributed view's page (../server/render-view.tsx) resolveLegacyView
 * gives the place its path names until its ViewBoundary supplies the view.
 *
 * The layout persists across soft navigations and the resolver sees only the
 * pathname, so a navigation that changes only `?org=` (HierarchyNav's
 * organization filter) would leave the shell on the old organization. When
 * `?org=` names another organization the manifest lists, the manifest is
 * rebuilt once for it; the (gui) layout reads `?org=` from x-mgm-path and
 * pickOrganization (../server/organization.ts) compares it trimmed and in
 * lower case, as here. If either stops honouring `?org=`, revisit. The
 * rebuild changes no URL, so the navigation bar, which hides once the URL
 * has changed, is held (announceNavigationHold) from the rebuild until the
 * manifest no longer needs one for the requested organization, or this
 * provider unmounts; its own safety timeout ends a rebuild that never lands.
 *
 * It also remembers the organization the manifest shows in the mgm-org
 * cookie, so the next full load of a page with no organization in its path
 * opens there (the layout reads it as a hint).
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, type ComponentProps } from "react";
import { announceNavigationHold, announceNavigationSettled } from "@/components/ui/navigation-progress";
import { resolveLegacyView } from "../shared/legacy-view";
import { ORG_COOKIE } from "../shared/org-cookie";
import { KitProvider, useRefreshOnce, type ResolveView } from "./kit-provider";

const resolve: ResolveView = (pathname, manifest) => resolveLegacyView(pathname, manifest);

/** How long the last-used organization is remembered: 180 days. */
const REMEMBER_SECONDS = 180 * 24 * 60 * 60;

/** Path=/, no Domain and not HttpOnly, as sign-out's expiry needs (org-cookie.ts). */
function rememberOrganization(id: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${ORG_COOKIE}=${encodeURIComponent(id)}; Max-Age=${REMEMBER_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

export function HostKitProvider(props: Omit<ComponentProps<typeof KitProvider>, "resolve">) {
  const { manifest } = props;
  const organization = manifest?.org.id ?? null;
  useEffect(() => {
    if (organization) rememberOrganization(organization);
  }, [organization]);

  const requested = useSearchParams()?.get("org")?.trim().toLowerCase() ?? null;
  const switched =
    requested !== null && requested !== organization && (manifest?.orgs.some((org) => org.id === requested) ?? false);
  const refreshOnce = useRefreshOnce(organization);
  const holding = useRef(false);
  useEffect(() => {
    if (switched && requested) {
      if (refreshOnce(`org:${requested}`)) {
        holding.current = true;
        announceNavigationHold();
      }
    } else if (holding.current) {
      holding.current = false;
      announceNavigationSettled();
    }
  }, [switched, requested, refreshOnce]);
  useEffect(
    () => () => {
      if (holding.current) announceNavigationSettled();
    },
    [],
  );
  return <KitProvider {...props} resolve={resolve} />;
}

"use client";

/**
 * The KitProvider the (gui) layout mounts. A server layout cannot hand
 * KitProvider a function, so this client module supplies `resolve`: after a
 * soft navigation, the view is resolveLegacyView of the new pathname, and a
 * place the manifest does not list rebuilds the manifest once (KitProvider).
 * When the host serves contributed views on their own pages, their
 * ViewBoundary supplies the view instead.
 *
 * It also remembers the organization the manifest shows in the mgm-org
 * cookie, so the next full load of a page with no organization in its path
 * opens there (the layout reads it as a hint).
 */
import { useEffect, type ComponentProps } from "react";
import { resolveLegacyView } from "../shared/legacy-view";
import { ORG_COOKIE } from "../shared/org-cookie";
import { KitProvider, type ResolveView } from "./kit-provider";

const resolve: ResolveView = (pathname, manifest) => resolveLegacyView(pathname, manifest);

/** How long the last-used organization is remembered: 180 days. */
const REMEMBER_SECONDS = 180 * 24 * 60 * 60;

/** Path=/, no Domain and not HttpOnly, as sign-out's expiry needs (org-cookie.ts). */
function rememberOrganization(id: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${ORG_COOKIE}=${encodeURIComponent(id)}; Max-Age=${REMEMBER_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

export function HostKitProvider(props: Omit<ComponentProps<typeof KitProvider>, "resolve">) {
  const organization = props.manifest?.org.id ?? null;
  useEffect(() => {
    if (organization) rememberOrganization(organization);
  }, [organization]);
  return <KitProvider {...props} resolve={resolve} />;
}

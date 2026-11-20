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
 * A tenant manifest (buildTenantManifestModel) shows the person's current
 * unit as its `org` and their units as places of kind "tenant", and the
 * unit picker on /my changes only `?unit=`. So `?unit=` naming one of those
 * places other than the current unit rebuilds the manifest the same way,
 * and the shell's context, clock time zone and remembered unit follow the
 * chosen one. The server picks the unit with chooseTenantUnit
 * (../shared/tenant-units.ts), which takes exactly one `unit` value and
 * compares it in lower case, untrimmed, as here; if it stops honouring
 * `?unit=`, revisit. A unit beyond the places cap (MAX_PLACES_PER_KIND) is
 * not listed, so choosing it rebuilds nothing until the next full load.
 *
 * It also remembers the organization the manifest shows in the mgm-org
 * cookie, so the next full load of a page with no organization in its path
 * opens there (the layout reads it as a hint). For a tenant manifest that
 * is the current unit, which the tenant manifest reads the same way.
 *
 * It fetches the signals of the organization the manifest shows after the
 * first paint (./signals-feed.ts), or takes them from a view's model that
 * carries them, hands them to KitProvider for useSignals(), and sets the installed app's badge to their count. A tenant
 * manifest gets none, and its badge is cleared: the host builds a staff
 * manifest's `orgs` with the current organization in it and a tenant's with
 * none (buildManifestModel and buildTenantManifestModel,
 * ../shared/manifest-model.ts). If either stops holding, revisit
 * `signalsOrganization`.
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, type ComponentProps } from "react";
import { announceNavigationHold, announceNavigationSettled } from "@/components/ui/navigation-progress";
import { resolveLegacyView } from "../shared/legacy-view";
import { ORG_COOKIE } from "../shared/org-cookie";
import { TENANT_UNIT_PARAM } from "../shared/tenant-units";
import { KitProvider, useRefreshOnce, type ResolveView } from "./kit-provider";
import { useKitRuntime } from "./kit-runtime";
import { useSignalsFeed } from "./signals-feed";

const resolve: ResolveView = (pathname, manifest) => resolveLegacyView(pathname, manifest);

/** How long the last-used organization is remembered: 180 days. */
const REMEMBER_SECONDS = 180 * 24 * 60 * 60;

/** Path=/, no Domain and not HttpOnly, as sign-out's expiry needs (org-cookie.ts). */
function rememberOrganization(id: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${ORG_COOKIE}=${encodeURIComponent(id)}; Max-Age=${REMEMBER_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

/** The organization whose signals the shell shows: a staff manifest's own, never a tenant's unit. */
function signalsOrganization(manifest: ComponentProps<typeof KitProvider>["manifest"]): string | null {
  return manifest && manifest.orgs.some((org) => org.id === manifest.org.id) ? manifest.org.id : null;
}

export function HostKitProvider(props: Omit<ComponentProps<typeof KitProvider>, "resolve" | "signals" | "refreshSignals" | "seedSignals">) {
  const { manifest } = props;
  const organization = manifest?.org.id ?? null;
  const runtime = useKitRuntime();
  const feed = useSignalsFeed(signalsOrganization(manifest), runtime.fetch);
  useEffect(() => {
    if (organization) rememberOrganization(organization);
  }, [organization]);

  const search = useSearchParams();
  const requestedOrg = search?.get("org")?.trim().toLowerCase() ?? null;
  const units = search?.getAll(TENANT_UNIT_PARAM) ?? [];
  const requestedUnit = units.length === 1 ? units[0].toLowerCase() : null;
  const orgSwitch =
    requestedOrg !== null &&
    requestedOrg !== organization &&
    (manifest?.orgs.some((org) => org.id === requestedOrg) ?? false);
  const unitSwitch =
    requestedUnit !== null &&
    requestedUnit !== organization &&
    (manifest?.org.places.some((place) => place.kind === "tenant" && place.id === requestedUnit) ?? false);
  const target = orgSwitch ? `org:${requestedOrg}` : unitSwitch ? `unit:${requestedUnit}` : null;
  const refreshOnce = useRefreshOnce(organization);
  const holding = useRef(false);
  useEffect(() => {
    if (target) {
      if (refreshOnce(target)) {
        holding.current = true;
        announceNavigationHold();
      }
    } else if (holding.current) {
      holding.current = false;
      announceNavigationSettled();
    }
  }, [target, refreshOnce]);
  useEffect(
    () => () => {
      if (holding.current) announceNavigationSettled();
    },
    [],
  );
  return <KitProvider {...props} resolve={resolve} signals={feed.signals} refreshSignals={feed.refresh} seedSignals={feed.seed} />;
}

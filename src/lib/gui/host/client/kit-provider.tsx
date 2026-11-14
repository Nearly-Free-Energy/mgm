"use client";

/**
 * Holds what the kit's hooks read: the manifest, the view the server resolved
 * for the first paint, the model a ViewBoundary published, and the server's
 * clock. The layout that mounts it persists across soft navigations, so after
 * the first paint the view comes from `resolve(pathname)` or the boundary.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CoreEntityKind } from "@/lib/plugins/bundled";
import type { EntityRef, Href, InitialView, Manifest, NavEntry, Signals, ViewModel, ViewState } from "../../contract";
import { isHref } from "../shared/href";
import { ActionHost, type ActionHostSlots } from "./action-host";
import { defaultRuntime, RouterBridge, useKitRuntime, useSearchOrganization } from "./kit-runtime";
import { usePathname } from "./navigation";

/**
 * The view for a pathname; `unplaced` when it names a place the manifest does
 * not list. A Server Component cannot pass a function to KitProvider, so a
 * server layout leaves `resolve` out; it comes from a client module, or
 * becomes a default imported here from a client-safe host/shared module.
 */
export type ResolveView = (pathname: string, manifest: Manifest) => InitialView & { unplaced?: boolean };

export type Boundary = { pathname: string; initial: InitialView; model: ViewModel };

type KitState = {
  manifest: Manifest | null;
  view: InitialView;
  boundary: Boundary | null;
  setBoundary(boundary: Boundary | null): void;
  /** Server time minus device time, in milliseconds. */
  skew: number;
  signals: Signals | null;
};

const KitContext = createContext<KitState | null>(null);

export function useKitState(): KitState | null {
  return useContext(KitContext);
}

/**
 * Rebuilds the manifest (runtime.refresh) at most once per key while the
 * manifest shows `organization`. A manifest for another organization starts
 * afresh, so switching back and forth between organizations rebuilds each
 * time; a rebuild that comes back for the same organization (a place past the
 * places cap, or a hint the server does not follow) adds nothing, so it can
 * never loop. Called from effects.
 */
export function useRefreshOnce(organization: string | null): (key: string) => void {
  const runtime = useKitRuntime();
  const done = useRef<{ organization: string | null; keys: Set<string> }>({ organization, keys: new Set() });
  // Start afresh as soon as a manifest for another organization commits, not
  // only when this hook is next asked to refresh: a switch made through
  // another provider's hook must not leave stale keys here. Layout effects
  // run before the effects that call the returned function in the same commit.
  useLayoutEffect(() => {
    if (done.current.organization !== organization) done.current = { organization, keys: new Set() };
  }, [organization]);
  return useCallback(
    (key: string) => {
      if (done.current.organization !== organization) done.current = { organization, keys: new Set() };
      if (done.current.keys.has(key)) return;
      done.current.keys.add(key);
      runtime.refresh();
    },
    [organization, runtime],
  );
}

export function KitProvider(props: {
  manifest: Manifest | null;
  initial: InitialView;
  resolve?: ResolveView;
  /** The active GUI's Overlay and forms for the page's ActionHost; the kit's are used otherwise. */
  actions?: ActionHostSlots;
  /** What useSignals() returns; null when left out. */
  signals?: Signals | null;
  children: ReactNode;
}) {
  const { manifest, initial, resolve, actions, signals = null, children } = props;
  const runtime = useKitRuntime();
  const pathname = usePathname();
  useSearchOrganization(manifest?.org.id ?? null);
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [skew] = useState(() => (manifest ? Date.parse(manifest.now) - Date.now() : 0) || 0);
  const resolved = useMemo(
    () => (manifest && resolve ? resolve(pathname, manifest) : initial),
    [manifest, resolve, pathname, initial],
  );

  // A place the manifest cannot show means it was built for another
  // organization or past the places cap: rebuild it once per pathname for
  // each organization the manifest shows.
  const refreshOnce = useRefreshOnce(manifest?.org.id ?? null);
  const unplaced = "unplaced" in resolved && resolved.unplaced === true;
  useEffect(() => {
    if (unplaced) refreshOnce(`path:${pathname}`);
  }, [unplaced, pathname, refreshOnce]);

  const state = useMemo<KitState>(
    () => ({ manifest, view: resolved, boundary, setBoundary, skew, signals }),
    [manifest, resolved, boundary, skew, signals],
  );
  return (
    <KitContext.Provider value={state}>
      {runtime === defaultRuntime && <RouterBridge />}
      {children}
      <ActionHost {...actions} model={boundary?.pathname === pathname ? boundary.model : null} />
    </KitContext.Provider>
  );
}

function useRequiredState(hook: string): KitState & { manifest: Manifest } {
  const state = useContext(KitContext);
  if (!state?.manifest) throw new Error(`${hook}() needs a KitProvider with a manifest.`);
  return state as KitState & { manifest: Manifest };
}

export function useManifest(): Manifest {
  return useRequiredState("useManifest").manifest;
}

/** Signals load after the first paint once the host serves them; null until then. */
export function useSignals(): Signals | null {
  return useContext(KitContext)?.signals ?? null;
}

type Scope = Partial<Record<CoreEntityKind, EntityRef>>;

function choicesOf(manifest: Manifest, kind: CoreEntityKind): EntityRef[] {
  if (kind === "organization") return manifest.orgs.map((o) => ({ kind, id: o.id, label: o.name, href: o.href }));
  return manifest.org.places.filter((place) => place.kind === kind);
}

/** Fills a nav pattern's [kind] segments from `pick`, the scope, or the only choice of that kind. */
export function fillNavHref(manifest: Manifest, nav: NavEntry, scope: Scope, pick: Scope = {}): Href | null {
  let missing = false;
  const filled = nav.href.replace(/\[([^\]/]+)\]/g, (_, name: string) => {
    const kind = name as CoreEntityKind;
    const only = choicesOf(manifest, kind);
    const ref =
      pick[kind] ??
      scope[kind] ??
      (kind === "organization" ? { id: manifest.org.id } : only.length === 1 ? only[0] : undefined);
    if (!ref) missing = true;
    return ref ? encodeURIComponent(ref.id) : "";
  });
  return !missing && isHref(filled) ? filled : null;
}

export function useView(): ViewState {
  const { manifest, view, boundary } = useRequiredState("useView");
  const pathname = usePathname();
  return useMemo(() => {
    const current = boundary?.pathname === pathname ? boundary : null;
    const base = current?.initial ?? view;
    return {
      view: base.view,
      title: base.title,
      trail: base.trail,
      tabs: base.tabs,
      scope: base.scope,
      model: current?.model ?? null,
      org: manifest.org,
      href: (nav, pick) => fillNavHref(manifest, nav, base.scope, pick),
      choices: (kind) => choicesOf(manifest, kind),
    };
  }, [manifest, view, boundary, pathname]);
}

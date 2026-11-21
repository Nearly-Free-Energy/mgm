"use client";

/**
 * Holds what the kit's hooks read: the manifest, the view the server resolved
 * for the first paint, the model a ViewBoundary published, and the server's
 * clock. The layout that mounts it persists across soft navigations, so after
 * the first paint the view comes from `resolve(pathname)` or the boundary;
 * on a contributed view's page, the layout's `initial` covers the first paint.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CoreEntityKind } from "@/lib/plugins/bundled";
import type { EntityRef, Href, InitialView, Manifest, NavEntry, Signals, ViewModel, ViewState } from "../../contract";
import { isHref } from "../shared/href";
import { ActionHost, type ActionHostSlots } from "./action-host";
import { defaultRuntime, RouterBridge, useKitRuntime, useSearchOrganization } from "./kit-runtime";
import { usePathname } from "./navigation";
import type { SignalsSource } from "./signals-feed";

/**
 * The view for a pathname; `unplaced` when it names a place the manifest does
 * not list. A Server Component cannot pass a function to KitProvider, so a
 * server layout leaves `resolve` out; it comes from a client module, or
 * becomes a default imported here from a client-safe host/shared module.
 */
export type ResolveView = (pathname: string, manifest: Manifest) => InitialView & { unplaced?: boolean };

/** What a page published: its view and model, or (ViewUnavailable) no view and no model. */
export type Boundary = { pathname: string; initial: InitialView; model: ViewModel | null };

/**
 * The model a ViewBoundary published, held outside React state so that
 * publishing it leaves the kit's context value as it was. A context change
 * reaches every Suspense boundary below the provider that is still waiting
 * to hydrate, and React then drops that boundary's server HTML and renders
 * it afresh on the client: on a first load, a renderer whose chunk is still
 * loading (the site-day renderer's lazy chunk) vanished for a frame and came
 * back. A store update reaches only the components that read it (the
 * shell's window bar, useView's callers, the ActionHost). If the model
 * moves back into the context value, that blank frame returns.
 */
type BoundaryStore = {
  get(): Boundary | null;
  set(boundary: Boundary | null): void;
  subscribe(listener: () => void): () => void;
};

function createBoundaryStore(): BoundaryStore {
  let current: Boundary | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(boundary) {
      if (boundary === current) return;
      current = boundary;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** No model is published while the server renders or the page hydrates. */
const NO_BOUNDARY = () => null;

function useBoundary(store: BoundaryStore): Boundary | null {
  return useSyncExternalStore(store.subscribe, store.get, NO_BOUNDARY);
}

type KitState = {
  manifest: Manifest | null;
  view: InitialView;
  boundaries: BoundaryStore;
  /** Publishes (or, with null, withdraws) a ViewBoundary's model; stable for the provider's life. */
  setBoundary(boundary: Boundary | null): void;
  /** Server time minus device time, in milliseconds. */
  skew: number;
};

const KitContext = createContext<KitState | null>(null);
/**
 * The signals' store (SignalsSource in ./signals-feed.ts), apart from
 * KitContext and never a new value while the feed runs: useSignals() reads
 * it through useSyncExternalStore, so new signals re-render only what reads
 * them (the shell's tray), never the page's views inside the page's
 * Suspense boundary, which may still be dehydrated when they land.
 */
const SignalsContext = createContext<SignalsSource | null>(null);
const NO_SIGNALS: SignalsSource = { get: () => null, subscribe: () => () => {} };
/** A store that always answers `signals`: for a static `signals` prop (tests, the conformance kit). */
const constantSource = (signals: Signals | null): SignalsSource => ({ get: () => signals, subscribe: () => () => {} });

export function useKitState(): KitState | null {
  return useContext(KitContext);
}

/**
 * Rebuilds the manifest (runtime.refresh) at most once per key while the
 * manifest shows `organization`. A manifest for another organization starts
 * afresh, so switching back and forth between organizations rebuilds each
 * time; a rebuild that comes back for the same organization (a place past the
 * places cap, or a hint the server does not follow) adds nothing, so it can
 * never loop. Called from effects; the returned function says whether it
 * started a rebuild.
 */
export function useRefreshOnce(organization: string | null): (key: string) => boolean {
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
      if (done.current.keys.has(key)) return false;
      done.current.keys.add(key);
      runtime.refresh();
      return true;
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
  /** What useSignals() returns; null when left out. Ignored when `signalsSource` is given. */
  signals?: Signals | null;
  /** The signals as a store the host's feed keeps (./signals-feed.ts). */
  signalsSource?: SignalsSource;
  /** Fetches the signals again; called after an action whose result says `signals: true`. */
  refreshSignals?: () => void;
  /** Handed the signals a published view's model carries (a view that takes signals, such as Today). */
  seedSignals?: (signals: Signals) => void;
  children: ReactNode;
}) {
  const { manifest, initial, resolve, actions, signals = null, signalsSource, refreshSignals, seedSignals, children } = props;
  const source = useMemo(() => signalsSource ?? constantSource(signals), [signalsSource, signals]);
  const runtime = useKitRuntime();
  const pathname = usePathname();
  useSearchOrganization(manifest?.org.id ?? null);
  const [boundaries] = useState(createBoundaryStore);
  const boundary = useBoundary(boundaries);
  const [skew] = useState(() => (manifest ? Date.parse(manifest.now) - Date.now() : 0) || 0);
  // A contributed view's `initial` holds for the pathname the layout rendered
  // it for, so the first paint is right before its ViewBoundary publishes:
  // `resolve` gives a page a view serves only its place, with no view
  // (resolveLegacyView), and `initial` alone carries the view id. A new `initial`
  // (the layout rendered again) belongs to the pathname current at the time.
  const [initialAt, setInitialAt] = useState({ initial, pathname });
  if (initialAt.initial !== initial) setInitialAt({ initial, pathname });
  const initialPathname = initialAt.initial === initial ? initialAt.pathname : pathname;
  const resolved = useMemo(
    () =>
      manifest && resolve && !(initial.view !== null && pathname === initialPathname)
        ? resolve(pathname, manifest)
        : initial,
    [manifest, resolve, pathname, initial, initialPathname],
  );

  // A place the manifest cannot show means it was built for another
  // organization or past the places cap: rebuild it once per pathname for
  // each organization the manifest shows.
  const refreshOnce = useRefreshOnce(manifest?.org.id ?? null);
  const shown: InitialView & { unplaced?: boolean } = boundary?.pathname === pathname ? boundary.initial : resolved;
  const unplaced = shown.unplaced === true;
  useEffect(() => {
    if (unplaced) refreshOnce(`path:${pathname}`);
  }, [unplaced, pathname, refreshOnce]);

  // A view that takes signals carries the ones the host collected for it, so
  // the shell's feed need not fetch them again (./signals-feed.ts).
  const modelSignals = boundary?.pathname === pathname ? boundary.model?.signals : undefined;
  useEffect(() => {
    if (modelSignals) seedSignals?.(modelSignals);
  }, [modelSignals, seedSignals]);

  // The published model is left out of this value on purpose (BoundaryStore).
  const state = useMemo<KitState>(
    () => ({ manifest, view: resolved, boundaries, setBoundary: boundaries.set, skew }),
    [manifest, resolved, boundaries, skew],
  );
  return (
    <KitContext.Provider value={state}>
      <SignalsContext.Provider value={source}>
        {runtime === defaultRuntime && <RouterBridge />}
        {children}
        <ActionHost
          {...actions}
          model={boundary?.pathname === pathname ? boundary.model : null}
          onSignals={refreshSignals}
        />
      </SignalsContext.Provider>
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

/** The organization's signals, loaded after the first paint (./signals-feed.ts); null until then and for a tenant. */
export function useSignals(): Signals | null {
  const source = useContext(SignalsContext) ?? NO_SIGNALS;
  return useSyncExternalStore(source.subscribe, source.get, source.get);
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
  const { manifest, view, boundaries } = useRequiredState("useView");
  const boundary = useBoundary(boundaries);
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

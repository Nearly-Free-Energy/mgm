"use client";

/**
 * The kit's side effects in one replaceable object: navigation, refresh,
 * fetches, writes, opening links and sign-out. A test or the conformance kit
 * mounts <KitRuntimeProvider runtime={…}> to record what a GUI does instead
 * of doing it. Links stay real anchors, so their hrefs are read from the DOM.
 * Host-only: a GUI sees GuiKit, never this.
 */
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { announceNavigationStart } from "@/components/ui/navigation-progress";
import type { ActionRef, ActionResult, EntityHit, Href, Json, LinkRef, ViewModel } from "../../contract";
import { isHref } from "../shared/href";
import { openLink } from "./open";

export interface KitRuntime {
  /** A soft navigation to a same-origin page. */
  navigate(href: Href): void;
  /** Re-runs the server components of the current page. */
  refresh(): void;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  act(ref: ActionRef, options?: { initial?: Json }): Promise<ActionResult>;
  open(link: LinkRef): Promise<void>;
  /**
   * Replaces the kit's sign-out, which loads the Supabase client and leaves
   * the page. Rejects when the session was not removed: the button (SignOut
   * in ../../kit/sign-out.tsx) is then enabled again and says that sign-out
   * did not finish; if that component stops catching the rejection, revisit.
   */
  signOut?(): Promise<void>;
  /** The pathname outside the Next.js router, as in jsdom. */
  pathname?: string;
}

type Router = Pick<ReturnType<typeof useRouter>, "push" | "refresh">;
let router: Router | null = null;
let injected: KitRuntime | null = null;
/** The organization the mounted manifest shows, so search asks the host for it. */
let organization: string | null = null;

type Act = KitRuntime["act"];
/** The mounted ActionHost's act (./action-host.tsx); null while none is mounted. */
let actionHost: Act | null = null;

/** Without a mounted ActionHost, act refuses without sending anything. */
const NO_ACTION_HOST: ActionResult = {
  type: "result",
  ok: false,
  status: 0,
  code: "no_action_host",
  message: "Actions are not available on this page.",
};

/** Called by ActionHost when it mounts; returns the unmount. A page has one host. */
export function mountActionHost(act: Act): () => void {
  if (actionHost && process.env.NODE_ENV !== "production") {
    console.warn("[gui] A second ActionHost was mounted; the latest one runs actions.");
  }
  actionHost = act;
  return () => {
    if (actionHost === act) actionHost = null;
  };
}

/** The default runtime's act: the mounted host's, which is the only write path. */
export const hostAct: Act = (ref, options) => (actionHost ? actionHost(ref, options) : Promise.resolve(NO_ACTION_HOST));

export const defaultRuntime: KitRuntime = {
  navigate(href) {
    if (!isHref(href)) return;
    announceNavigationStart(href);
    if (router) router.push(href);
    else window.location.assign(href);
  },
  refresh() {
    router?.refresh();
  },
  fetch: (url, init) => globalThis.fetch(url, init),
  act: hostAct,
  open: (link) => openLink(link, (href) => defaultRuntime.navigate(href)),
};

const RuntimeContext = createContext<KitRuntime | null>(null);

/** The runtime for the kit's plain functions: the mounted provider's, or the browser's. */
export function currentRuntime(): KitRuntime {
  return injected ?? defaultRuntime;
}

export function useKitRuntime(): KitRuntime {
  return useContext(RuntimeContext) ?? defaultRuntime;
}

export function KitRuntimeProvider({ runtime, children }: { runtime: KitRuntime; children: ReactNode }) {
  useLayoutEffect(() => {
    injected = runtime;
    return () => {
      if (injected === runtime) injected = null;
    };
  }, [runtime]);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

/** Hands the Next.js router to the default runtime. Rendered by KitProvider inside the app router only. */
export function RouterBridge() {
  const next = useRouter();
  useLayoutEffect(() => {
    router = next;
    return () => {
      if (router === next) router = null;
    };
  }, [next]);
  return null;
}

/** Keeps the shown organization for search(). Called by KitProvider. */
export function useSearchOrganization(id: string | null): void {
  useLayoutEffect(() => {
    organization = id;
    return () => {
      if (organization === id) organization = null;
    };
  }, [id]);
}

// ── Plain kit functions ──────────────────────────────────────────────────────

export const navigate = (href: Href): void => currentRuntime().navigate(href);
export const refresh = (): void => currentRuntime().refresh();
export const act = (ref: ActionRef, options?: { initial?: Json }): Promise<ActionResult> =>
  currentRuntime().act(ref, options);
export const open = (link: LinkRef): Promise<void> => currentRuntime().open(link);

const failed = (status: number, body: { error?: unknown; code?: unknown } | null): ActionResult => ({
  type: "result",
  ok: false,
  status,
  code: typeof body?.code === "string" ? body.code : "gui_view_failed",
  message: typeof body?.error === "string" ? body.error : "This view could not be loaded.",
});

/** A view's model from the host. Signed out, the page goes to /login. */
export async function loadView(href: Href): Promise<ViewModel | ActionResult> {
  if (!isHref(href)) return failed(400, { code: "gui_bad_href", error: "Not a page on this site." });
  let response: Response;
  try {
    response = await currentRuntime().fetch(`/api/gui/view?href=${encodeURIComponent(href)}`, { cache: "no-store" });
  } catch {
    return failed(0, { code: "network", error: "No connection." });
  }
  if (response.status === 401) {
    window.location.assign("/login");
    return failed(401, { code: "unauthenticated", error: "Signed out." });
  }
  const body = await response.json().catch(() => null);
  if (response.ok && (body?.type === "view" || body?.type === "result")) return body;
  return failed(response.status, body);
}

/** Entities ("@") or views ("#") matching `query` (2 to 64 characters); none on any failure. */
export async function search(query: string, prefix: "@" | "#"): Promise<EntityHit[]> {
  const q = query.trim();
  if (q.length < 2 || q.length > 64) return [];
  try {
    const params = new URLSearchParams({ q, prefix });
    if (organization) params.set("org", organization);
    const response = await currentRuntime().fetch(`/api/gui/search?${params}`, { cache: "no-store" });
    const body = response.ok ? await response.json() : null;
    return Array.isArray(body) ? body.filter((hit: EntityHit) => isHref(hit?.href)) : [];
  } catch {
    return [];
  }
}

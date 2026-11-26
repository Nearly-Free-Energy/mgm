/**
 * MGM GUI contract v0 (experimental): the kit and the GUI-plugin types, which
 * name React types. Everything else in the contract, and everything a client
 * that is not a GUI reads, is in ./contract.ts, which imports no React, so
 * such a client type-checks it without @types/react (A1-5 on #133).
 *
 * Client-safe, like ./contract.ts: it imports only types, and only from react
 * and ./contract (src/lib/gui/__tests__/gui-boundary.test.ts, rule
 * "contract-react"). It re-exports nothing from ./contract, so each name has
 * one home. GUI_CONTRACT in ./contract.ts versions these types too.
 */
import type { ComponentType, ReactNode } from "react";
import type {
  ActionRef,
  ActionResult,
  EntityHit,
  FeedState,
  FormProps,
  GuiMeta,
  Href,
  Id,
  InitialView,
  Json,
  LinkRef,
  LiveState,
  Manifest,
  PublicPage,
  Signals,
  ViewModel,
  ViewProps,
  ViewState,
} from "./contract";

// ── The kit: the only I/O a GUI has ────────────────────────────────────────
// A runtime implements GuiKit with `satisfies GuiKit`, so its shape is
// versioned with these types.

export interface LinkProps {
  href: Href;
  children: ReactNode;
  className?: string;
  current?: boolean;
}
export interface GuiKit {
  useManifest(): Manifest;
  useView(): ViewState;
  useSignals(): Signals | null;
  useLive(model: ViewModel): LiveState;
  useFeed(href: Href): FeedState;
  loadView(href: Href): Promise<ViewModel | ActionResult>;
  search(query: string, prefix: "@" | "#"): Promise<EntityHit[]>;
  Link: ComponentType<LinkProps>;
  navigate(href: Href): void;
  refresh(): void;
  usePathname(): string;
  /** GUI-owned interface state, such as a selection. `ui.*` parameters never reach a loader. */
  useUiParam(name: `ui.${string}`): [string | null, (value: string | null) => void];
  /**
   * The only way to write: the kit runs the form, the confirmation step and
   * the request. Resolves { ok: false, status: 0, code: "cancelled" } when the
   * person cancels.
   */
  act(ref: ActionRef, options?: { initial?: Json }): Promise<ActionResult>;
  open(link: LinkRef): Promise<void>;
  /** Renders all five kinds; a GUI may use it as its View. */
  KitView: SyncComponent<ViewProps>;
  /** The fallback for a kind a GUI does not know. */
  RawView: SyncComponent<ViewProps>;
  SignOut: ComponentType<{ className?: string }>;
}

// ── What a GUI plugin implements ───────────────────────────────────────────

/** A component that renders synchronously, so it works in the browser, in jsdom and inside embeds. */
export type SyncNode = Exclude<ReactNode, Promise<unknown>>;
export type SyncComponent<P> = (props: P) => SyncNode;
/** Shell and PublicFrame may be server components. */
type MaybeServer<P> = (props: P) => ReactNode | Promise<ReactNode>;

export interface ShellProps {
  manifest: Manifest;
  initial: InitialView;
  children: ReactNode;
}
export interface OverlayProps {
  title: string;
  /** "danger" for a DELETE or destructive action, "neutral" for every other, typed and ceremony included. */
  tone: "neutral" | "danger";
  role: "form" | "confirm";
  onDismiss(): void;
  /**
   * Where the kit's step goes; the GUI frames it (dialog, sheet, page) and
   * never alters it. It is an empty slot with no props: the host renders the
   * step into it through a portal, so the step's React events and context do
   * not pass through the Overlay, and an Overlay that closes on an outside
   * click judges "outside" by DOM containment. Put it inside the dialog's
   * content element itself (for Radix, inside Dialog.Content), not in a
   * portal of its own: a modal dialog hides everything outside its content
   * from assistive tech and counts presses there as outside. Holds while ActionHost
   * (host/client/action-host.tsx) portals the step; if the Overlay is ever
   * handed the step itself, revisit.
   */
  children: ReactNode;
}
/** A GUI: its metadata plus its components. */
export interface GuiPlugin extends GuiMeta {
  /** Must: the persistent layout. */
  Shell: MaybeServer<ShellProps>;
  /** Must: renders all five kinds (kit.KitView counts). */
  View: SyncComponent<ViewProps>;
  /** May: bespoke renderers by view id, each listing the `ext` versions it reads. */
  renderers?: Partial<Record<Id, { reads: readonly number[]; Component: SyncComponent<ViewProps> }>>;
  /** May: bespoke forms by action id, for `none` and `confirm` actions only. */
  forms?: Partial<Record<Id, { reads: readonly number[]; Component: SyncComponent<FormProps> }>>;
  /** May: frames the kit's forms and confirmation steps. */
  Overlay?: SyncComponent<OverlayProps>;
  /** May: otherwise a neutral skeleton. */
  Loading?: SyncComponent<Record<string, never>>;
  /** May: a server component around the sign-in pages, with no client imports. */
  PublicFrame?: MaybeServer<{ page: PublicPage; children: ReactNode }>;
}

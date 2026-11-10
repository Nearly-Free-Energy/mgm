/**
 * MGM GUI contract v0 (experimental): the types a GUI renders.
 *
 * A capability plugin describes its screens as data (src/lib/gui/surface.ts,
 * server-only): views with loaders, actions bound to its existing API routes,
 * navigation, signals and search. A GUI plugin presents what it is given,
 * through the types in this file and the kit (GuiKit). This file is
 * client-safe: it imports only types, from react and from the plugin catalog.
 *
 * Nothing here is a rule the server trusts. The middleware, the routes and the
 * database keep enforcing released routes, the plugin gate, roles and
 * row-level security, whatever a GUI or a contribution says. The types make
 * the right thing the easy thing, and src/lib/gui/__tests__/contract-types.test.ts
 * pins the rules they express.
 *
 * Each shape a browser receives also has a strict schema in
 * src/lib/gui/host/server/model-schema.ts. Its test fails to compile while a
 * schema and its type here differ, so change them together.
 *
 * Versioning: GUI_CONTRACT is semver, and a GUI declares the caret range it
 * supports. Through 0.x the contract is experimental: a minor version may
 * change shapes, and a patch only adds optional fields, kinds or values.
 */
import type { ComponentType, ReactNode } from "react";
import type { CoreEntityKind } from "@/lib/plugins/bundled";

/** The contract version (semver). A GUI declares the range it supports, such as "^0.1". */
export const GUI_CONTRACT = "0.1.0";

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** "<alias>.<name>", where the alias is the contributing plugin's catalog alias ("billing", "org"). */
export type Id = `${string}.${string}`;
/**
 * A path on this site. The type only guarantees a leading "/": "//host/x" and
 * "/\\host" still compile, and browsers send both off-site. The host refuses
 * them, and any other path that leaves the site, at run time before a model
 * reaches a browser: the Href schema in src/lib/gui/host/server/model-schema.ts
 * (added with the host schemas, #124). Never rely on the type alone; if that
 * schema stops checking hrefs, revisit.
 */
export type Href = `/${string}`;
/** The only targets outside MGM a view may carry: a WhatsApp chat, a call, an SMS. */
export type OutHref = `https://wa.me/${string}` | `tel:${string}` | `sms:${string}`;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Meaning, not colour. `accent` marks a label, never a state. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";
/** What a person does before a write. A GUI frames the step (GuiPlugin.Overlay) but never runs it. */
export type Confirm = "none" | "confirm" | "typed" | "ceremony";
export type NavGroup = "operate" | "money" | "configure" | "system";
/** A fixed icon vocabulary, so every GUI can map names to its own set. An unknown name renders as text. */
export type Icon =
  | "today" | "live" | "sites" | "communities" | "households" | "devices" | "readings"
  | "billing" | "payments" | "tariff" | "data-source" | "branding" | "accounts" | "plugins"
  | "users" | "profile" | "organizations" | "assistant" | "message" | "alert" | "download"
  | "share" | "contact" | "help";
/**
 * The kinds of core record whose organization MGM resolves, from the plugin
 * catalog. They are the plugin gate's target kinds (GateTarget):
 * contract-types.test.ts fails if the two lists differ.
 */
export type { CoreEntityKind };
/** A core kind, or a plugin's own namespaced kind ("sms-reminders.send"). */
export type EntityKind = CoreEntityKind | `${string}.${string}`;
export interface EntityRef {
  kind: EntityKind;
  id: string;
  label: string;
  href?: Href;
}
export type EntityHit = EntityRef & { href: Href };
export type Trail = { label: string; href: Href }[];

// ── Values: formatted on the server, so a GUI may print `text` as given ────

type ValueMeta = {
  /** Formatted for the locale, currency and time zone; in a bare column, the bare figure "4,216,800". */
  text: string;
  /** Computed rather than measured: mark it. */
  derived?: true;
  /** ISO time of the measurement; age it against Manifest.now. */
  at?: string;
  /** From generated rather than measured data: always labelled. */
  synthetic?: true;
};
export type Value = ValueMeta & (
  | { t: "text" }
  | { t: "empty" }
  | { t: "number"; v: number; unit?: string }
  | { t: "percent"; v: number }
  | { t: "money"; v: number; currency: string } // v: integer minor units (ISO 4217); UGX has none
  | { t: "energy"; v: number; unit: "Wh" | "kWh" }
  | { t: "power"; v: number; unit: "W" | "kW" }
  | { t: "date"; v: string } // YYYY-MM-DD in the entity's time zone
  | { t: "datetime"; v: string; tz: string }
  | { t: "status"; v: string; tone: Tone }
  | { t: "ref"; ref: EntityRef }
);
export type ValueType = Value["t"];

/** Rich text built on the server: paragraphs and list items. */
export type Inline =
  | string
  | { value: Value } // a figure taken from a loader's Value
  | { link: Href; text: string }
  | { unverified: string }; // a figure that matched no Value: render it with an "unverified" mark
export type Rich = ({ p: Inline[] } | { li: Inline[] })[];

/** A GET the person opens, downloads or shares. Never a write, so never confirmed. */
export interface LinkRef {
  id: Id;
  label: string;
  icon?: Icon;
  href: Href | OutHref;
  /** Such as a bill PDF or a CSV export. */
  download?: { mime: string; filename: string };
  share?: { title: string; text: string };
}

// ── Actions, as a GUI sees them ─────────────────────────────────────────────

/** A control, resolved for this person and entity. A GUI renders it and calls `kit.act(ref)`. */
export interface ActionRef {
  action: Id;
  /** Route segments and bound body fields, filled from the entity. */
  params: Record<string, string>;
  label: string;
  /** From role, the plugin gate, the released routes and the action's own `available`. */
  enabled: boolean;
  reason?: string;
  /** Set for typed and ceremony actions, and for every delete or destructive action. */
  tone?: "danger";
  /** Set when another plugin contributed this control, such as "SMS reminders". */
  from?: string;
  /** Parsed against the input schema, with writeOnly fields removed. */
  prefill?: Json;
  /** Present when something other than a person proposed it: render it as proposed. */
  provenance?: { by: "assistant" | "watcher"; proposal?: string; at: string };
}
/** What a bespoke form needs. Fetched when the form opens, never shipped in the manifest. */
export interface ActionSpec {
  type: "spec";
  id: Id;
  title: string;
  confirm: Confirm;
  /** A form declares the versions it reads; on a mismatch the kit's own form is used. */
  inputVersion: number;
  /** JSON Schema of the fields a person enters: bound fields removed, secrets marked writeOnly. */
  input: Json;
}
export type ActionResult =
  | { type: "result"; ok: true; message?: string; href?: Href; next?: ActionRef; signals?: true }
  | { type: "result"; ok: false; status: number; code: string; message: string; field?: string };

// ── The five view kinds, generic over the action type ──────────────────────
// A: ActionRef for GUIs, ActionLink (surface.ts) for loaders. V: what a feed embeds.

export interface Column {
  key: string;
  label: string;
  type: ValueType;
  priority: 1 | 2 | 3;
  /** "bare": copy and print the figure without its currency or unit. */
  copy?: "bare";
}
export interface RowOf<A> {
  id: string;
  entity?: EntityRef;
  related?: EntityRef[];
  href?: Href;
  cells: Record<string, Value>;
  actions: A[];
  links?: LinkRef[];
}
export interface Filter {
  label: string;
  href: Href;
  count?: number;
  current: boolean;
}
export type AuthorKind = "person" | "assistant" | "system";
export type EmbedOf<A, V> =
  | ({ type: "view"; href: Href } & V)
  | { type: "action"; ref: A }
  | { type: "values"; values: Value[] }
  | { type: "steps"; steps: { label: string; ms: number; ok: boolean }[] };
export interface FeedEntryOf<A, V> {
  id: string;
  at: string;
  author: { kind: AuthorKind; name: string };
  text: Rich;
  embed?: EmbedOf<A, V>;
}
/** A free-text input bound to an action. The kit sends the text and the current view. */
export interface ComposeOf<A> {
  action: A;
  textField: string;
  contextField?: string;
  placeholder: string;
}
export interface BodiesOf<A, V> {
  collection: {
    columns: Column[];
    rows: RowOf<A>[];
    /** Rendered below the rows, never as a row. */
    totals?: Record<string, Value>;
    filters?: Filter[];
    next?: Href;
    /** At zero rows the empty state owns the create action. */
    empty: { title: string; text?: string; action?: A };
  };
  record: {
    sections: { title?: string; fields: { key: string; label: string; value: Value }[] }[];
  };
  metrics: {
    tiles: { key: string; label: string; value: Value; status?: Value; hint?: string }[];
    /** A null point is a gap, not a zero. */
    series?: { key: string; label: string; unit: string; points: [string, number | null][] }[];
  };
  feed: { entries: FeedEntryOf<A, V>[]; compose?: ComposeOf<A>; stop?: A; busy?: boolean };
  flow: {
    steps: {
      id: string;
      title: string;
      state: "done" | "current" | "todo" | "blocked";
      detail?: string;
      href?: Href;
      action?: A;
    }[];
  };
}
export type ViewKind = keyof BodiesOf<unknown, unknown>;

export interface ModelBase<K extends ViewKind, A, V> {
  type: "view";
  view: Id;
  kind: K;
  body: BodiesOf<A, V>[K];
  title: string;
  subtitle?: string;
  org: string | null;
  entity?: EntityRef;
  trail: Trail;
  actions: A[];
  links: LinkRef[];
  /** Views attached to this one; the GUI decides how to place them. */
  attached: { view: Id; title: string; href: Href; hint: "section" | "tab" | "tile" }[];
  notice?: { tone: Tone; text: string };
  live?: { refreshSeconds: number; staleAfterSeconds: number };
  /** Extra data for a bespoke renderer that reads this exact version. */
  ext?: { schema: `${Id}@${number}`; data: Json };
}
export interface EmbeddedView {
  model: ViewModel;
}
export type ModelOf<K extends ViewKind> = ModelBase<K, ActionRef, EmbeddedView>;
export type ViewModel = { [K in ViewKind]: ModelOf<K> }[ViewKind];
/** The contract version each kind arrived in, so a GUI is sent only kinds its range covers. */
export const GUI_KINDS_SINCE: Readonly<Record<ViewKind, string>> = {
  collection: "0.1.0",
  record: "0.1.0",
  metrics: "0.1.0",
  feed: "0.1.0",
  flow: "0.1.0",
};

// ── What the Shell receives ─────────────────────────────────────────────────

type SignalBase = {
  id: string;
  source: Id;
  severity: "info" | "warn" | "critical";
  title: string;
  facts?: Value[];
  entity?: EntityRef;
  href: Href;
  at: string;
  due?: string;
};
export type SignalOf<A> =
  | (SignalBase & { kind: "alarm" })
  | (SignalBase & { kind: "your-move" }) // never carries an action: it links to the step that needs the person
  | (SignalBase & { kind: "proposal"; action: A }) // the action carries its provenance: render it as proposed
  | (SignalBase & { kind: "question" }) // answered where `href` points
  | (SignalBase & { kind: "info" });
export type Signal = SignalOf<ActionRef>;
/** Loaded after the first paint, never part of the manifest. */
export interface Signals {
  type: "signals";
  org: string;
  count: number;
  top: Signal[];
  /** Sources that answered, so a GUI can tell "nothing needs you" from "nothing checked". */
  checked: Id[];
  /** Sources that did not answer in time. */
  unchecked: Id[];
}

export interface StatusItemOf<A> {
  id: Id;
  label: string;
  state: "off" | "idle" | "working" | "needs-you";
  /** A feed or page to dock or link. */
  open: Href;
  ask?: ComposeOf<A>;
}
export type StatusItem = StatusItemOf<ActionRef>;
export interface NavEntry {
  id: Id;
  title: string;
  icon: Icon;
  group: NavGroup;
  order: number;
  /** A pattern: ViewState.href fills its [segments] by kind. */
  href: Href;
  /** The context the pattern needs; without it a GUI offers ViewState.choices. */
  needs: CoreEntityKind[];
  /** A released page that is not served through a contributed view. */
  legacy?: true;
}
export interface OrgManifest {
  id: string;
  name: string;
  href: Href;
  timezone: string | null;
  nav: NavEntry[];
  status: StatusItem[];
  /** The organization's communities and microgrids, for context pickers. `parent` is a microgrid's community id. */
  places: (EntityRef & { parent?: string })[];
}
/** Built for the current organization only, and never cached. */
export interface Manifest {
  type: "manifest";
  contract: string;
  /** The MGM release, or null when the build was not stamped with one. */
  release: string | null;
  locale: string;
  /** Server time, so ages are right on a device with a wrong clock. */
  now: string;
  gui: string;
  user: { name: string | null; email: string };
  org: OrgManifest;
  /** The organization switcher. */
  orgs: { id: string; name: string; href: Href }[];
}
/** Resolved from the request path, so the first server render is already right. */
export interface InitialView {
  view: Id | null;
  title: string;
  trail: Trail;
  tabs: { title: string; href: Href; current: boolean }[];
  scope: Partial<Record<CoreEntityKind, EntityRef>>;
}
export interface ViewState extends InitialView {
  /** Null on a page that is not served through a contributed view. */
  model: ViewModel | null;
  org: OrgManifest;
  /** Fills the pattern by kind from scope (or `pick`); null when a needed kind is missing. */
  href(nav: NavEntry, pick?: Partial<Record<CoreEntityKind, EntityRef>>): Href | null;
  /** Candidates for a context picker. */
  choices(kind: CoreEntityKind): EntityRef[];
}

// ── The kit: the only I/O a GUI has ────────────────────────────────────────
// A runtime implements GuiKit with `satisfies GuiKit`, so its shape is
// versioned with these types.

export interface LiveState {
  model: ViewModel;
  ageSeconds(value: Value): number | null;
  stale(value: Value): boolean;
  polling: "on" | "slow" | "paused";
}
export interface FeedState {
  model: ModelOf<"feed"> | null;
  busy: boolean;
  send(text: string): Promise<ActionResult>;
  stop(): void;
}
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
export interface ViewProps {
  model: ViewModel;
}
export interface FormProps {
  spec: ActionSpec;
  actionRef: ActionRef;
  model: ViewModel | null;
  initial: Json | null;
  busy: boolean;
  error: { message: string; field?: string } | null;
  /**
   * Hands the values to the kit, which copies them, then runs the
   * confirmation step and the request; only a none-level action submitted
   * during the person's gesture is sent without the step. A call once the
   * form is off screen or busy does nothing.
   */
  submit(body: Json): void;
  cancel(): void;
}
export interface OverlayProps {
  title: string;
  tone: "neutral" | "danger";
  role: "form" | "confirm";
  onDismiss(): void;
  /**
   * Where the kit's step goes; the GUI frames it (dialog, sheet, page) and
   * never alters it. It is an empty slot with no props: the host renders the
   * step into it through a portal, so the step's React events and context do
   * not pass through the Overlay, and an Overlay that closes on an outside
   * click judges "outside" by DOM containment. Holds while ActionHost
   * (host/client/action-host.tsx) portals the step; if the Overlay is ever
   * handed the step itself, revisit.
   */
  children: ReactNode;
}
export type PublicPage =
  | "login" | "forgot-password" | "reset-password" | "accept-invite" | "no-access" | "setup";

/** A GUI's metadata, read at start-up without importing React. */
export interface GuiMeta {
  /** One identifier: the key the GUI is installed under and its Cordis plugin name. */
  name: string;
  title: string;
  version: string;
  /** A caret range over GUI_CONTRACT, such as "^0.1". */
  contract: string;
  /** The package's stylesheet source. */
  styles: string;
  /** The npm packages the GUI's code imports, so each can be reviewed. */
  dependencies: readonly string[];
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

/**
 * Confirmation shapes. GUIs never receive these: the kit renders them inside
 * a GUI's Overlay. They are here so capabilities and the kit share one type.
 */
export interface Ceremony {
  type: "ceremony";
  statement: string;
  facts: { label: string; value: Value }[];
  warnings: string[];
  /** Rendered verbatim and unticked. */
  acknowledgements: { id: string; label: string }[];
  /** The name a person types. */
  typed?: string;
  digest?: string;
}
export interface Confirmation {
  digest?: string;
  acknowledged: string[];
  typed?: string;
}

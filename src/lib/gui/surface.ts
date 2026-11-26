import "server-only";

/**
 * MGM GUI contract v0 (experimental): what a capability plugin contributes.
 *
 * Server-only. A capability describes its screens as data: views with
 * loaders, actions bound to its existing API routes with a confirmation
 * level, navigation, signals, status and search. It ships no interface code;
 * GUIs render what it describes through the types in ./contract.ts.
 *
 * The confirmation rules below (who may propose an action, what needs
 * `prepare`, what a DELETE needs) are compile-time aids. A widened boolean
 * still satisfies them (contract-types.test.ts shows the case), so whatever
 * accepts a Contribution must check the same rules again when it registers
 * one, and the routes stay the authority for every write.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ZodType } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { UserRoleRecord } from "@/lib/types/domain";
import type {
  ActionRef,
  Ceremony,
  CoreEntityKind,
  EntityHit,
  EntityKind,
  EntityRef,
  GuiMeta,
  Href,
  Icon,
  Id,
  LinkRef,
  ModelBase,
  ModelOf,
  NavGroup,
  Repeat,
  SignalOf,
  Signals,
  StatusItemOf,
  Value,
  ViewKind,
} from "./contract";
import type { StatusKind } from "./status-maps";

/** Builds Values on the server, so every GUI prints the same text. */
export interface Fmt {
  text(s: string): Value;
  empty(): Value;
  number(v: number, unit?: string): Value;
  /**
   * `amount` is the stored amount in major units, as the money columns hold
   * it (NUMERIC: 4216800 UGX, 12.34 USD); Value.money.v is computed from it in
   * integer minor units. If money columns move to minor units, revisit.
   */
  money(amount: number, currency: string, o?: { bare?: true }): Value;
  /**
   * `digits`: decimals shown, 1 unless given; 2 for figures as small as one
   * hour's use, and a meter reading is shown to 3, as the legacy billing
   * table shows it.
   */
  energy(wh: number, o?: { bare?: true; digits?: number; at?: string; derived?: true; synthetic?: true }): Value;
  power(w: number, o?: { at?: string; derived?: true; synthetic?: true }): Value;
  percent(v: number, o?: { at?: string; synthetic?: true }): Value;
  date(isoDate: string): Value;
  datetime(iso: string, tz: string): Value;
  /** The label and tone from STATUS_MAPS; an unknown status shows as itself, neutral. */
  status(map: StatusKind, v: string): Value;
  ref(r: EntityRef): Value;
}

/** One per loader, signal, search or prepare call. */
export interface SurfaceRequest {
  /** This call's own client for the caller's session (row-level security), never the service role. */
  supabase: SupabaseClient;
  /** Already checked with getUser() on this request. */
  user: User;
  roles: UserRoleRecord[];
  /** From the entity, or the validated current organization. */
  organizationId: string;
  params: Record<string, string>;
  /** For a view, only the names in its `query`. Never a `ui.*` parameter. */
  search: URLSearchParams;
  locale: string;
  now: Date;
  fmt: Fmt;
  /**
   * Set only on the request of a view declaring `takesSignals`: the
   * organization's signals, collected by the host as GET /api/gui/signals
   * collects them (ADR-006 decision 9), or null when they could not be
   * collected. Absent on every other request.
   */
  signals?: Signals | null;
}
/** Installation-wide views, such as the super admin's organization list, get no organization. */
export type InstallationRequest = Omit<SurfaceRequest, "organizationId"> & { organizationId: null };
/**
 * A tenant view's request (RFC mgm#197 § 4): about one unit the caller rents,
 * never about an organization's records. The host chose `tenantId` among the
 * caller's own tenant rows (the `unit` query parameter, or their only unit),
 * so `params` is empty. The loader still authorizes the unit itself, through
 * composeTenantApp (@/lib/tenant-app/compose), which settles the session,
 * finds the caller's tenant row and asks the plugin gate of the unit's
 * organization. The host asks no gate for it, so a tenant loader that reads
 * without that composer reads while the tenant app is off.
 */
export type TenantRequest = Omit<SurfaceRequest, "organizationId"> & { organizationId: null; tenantId: string };
export type Loaded<T> =
  | { ok: true; model: T }
  | { ok: false; status: 403 | 404 | 409 | 500 | 503; message: string };

/**
 * What a loader puts where a GUI will see an ActionRef. The label, enabled,
 * reason, tone and from fields are resolved for the person who sees it.
 */
export type ActionLink = Pick<ActionRef, "action" | "params" | "prefill" | "provenance"> & { label?: string };
type HostFilled = "type" | "view" | "kind" | "org" | "trail" | "attached" | "notice" | "live" | "links" | "signals";
export type LoadedModel<K extends ViewKind> = Omit<ModelBase<K, ActionLink, unknown>, HostFilled> & {
  links?: LinkRef[];
  /**
   * The view's own notice, such as the time zone nudge. The host shows its
   * own notice first, the gate's for a disabled plugin or else the one on
   * generated figures, and then this one, in one notice (shownNotice in
   * host/server/view.ts), so neither hides the other.
   */
  notice?: ModelBase<K, ActionLink, unknown>["notice"];
};

interface ViewDefBase<K extends ViewKind> {
  id: Id;
  kind: K;
  /** A page route this plugin owns in the catalog and releases. */
  path: string;
  /** Which segment holds which kind: { id: "microgrid", periodId: "billingPeriod" }. */
  params: Record<string, EntityKind>;
  /** The segment naming this view's own entity. */
  entity?: string;
  /**
   * The search parameters the loader reads; it receives no others. An
   * attached view is given a parameter of the same name from the view it is
   * attached to, so both show the same day or filter.
   */
  query?: readonly string[];
  /**
   * Shown with every view of an entity kind, or with one view. While the
   * plugin gate answers that this view's plugin is off for the organization
   * (its 409), the host still lists a section, so the GUI loads it with the
   * gate's notice, and leaves a tab or tile out unless `whilePluginOff` is
   * "listed" (attachedViews in host/server/view.ts). A gate that cannot be
   * read leaves every one out.
   *
   * `whilePluginOff: "listed"` is for a tab or tile whose loader still works
   * while its plugin is off: gui-surface.test.ts allows it only on a view of
   * a plugin whose write routes may carry a PaymentExemption
   * (src/lib/runtime/__tests__/route-rules.ts), and only while every
   * capability method its surface module may call (LOADER_READS there) runs
   * while that plugin is off. A vendor view is refused while its plugin is
   * off, so it cannot declare it.
   */
  attach?: {
    to: EntityKind | { view: Id };
    order: number;
    hint: "section" | "tab" | "tile";
    whilePluginOff?: "listed";
  };
  /** "vendor": the loader calls an outside system, so it is gated like a write and polled sparingly. */
  cost: "db" | "vendor";
  /**
   * Deny by default: only this lets an assistant read the view, and what an
   * assistant reads is decided by ADR-007, through the host. The view must be
   * on the code-owned list in ./assistant-reads.ts, whose entry pins its
   * declared keys and ext, and contribution-schema.ts refuses the mark,
   * listed or not, where #133's data boundary keeps the view from an
   * assistant (ASSISTANT_READING there).
   */
  agent?: "read";
  /**
   * true: before the loader runs, the host collects the organization's
   * signals, running every watcher whose plugin is on within its own budget,
   * and hands them over as `req.signals` (organizationSignals in
   * host/server/signals.ts). For a view whose body is the signals, as
   * Today's is (org.today). Only an organization's view may declare it, and
   * one that is never attached and does not poll, since each load runs
   * every watcher again (contribution-schema.ts refuses the rest).
   */
  takesSignals?: true;
  live?: { refreshSeconds: number; staleAfterSeconds: number };
  /** Every cell, field, tile and series key the view emits. */
  declares: { keys: readonly string[]; prefixes?: readonly string[] };
  /** Strict objects all the way down. */
  ext?: { schema: `${Id}@${number}`; zod: ZodType };
  /** Fixtures, so every GUI can be tested against the view. */
  examples: readonly ModelOf<K>[];
}
/**
 * A view about the caller's own unit, for the `tenant` nav audience. Its path
 * has no segments, since the unit is the caller's, not a record a path names;
 * it is never attached to another view, and never read by an assistant: it
 * carries a tenant's name and unit, which #133's data boundary keeps from any
 * model (RFC mgm#197 § 3). The host serves it with no actions, since every
 * action is a staff route (dispatchView in host/server/view.ts).
 */
type TenantViewDef<K extends ViewKind> = {
  scope: "tenant";
  params: Record<string, never>;
  entity?: never;
  attach?: never;
  agent?: never;
  load(req: TenantRequest): Promise<Loaded<LoadedModel<K>>>;
};
export type ViewDefOf<K extends ViewKind> = ViewDefBase<K> & (
  | { scope?: "organization"; load(req: SurfaceRequest): Promise<Loaded<LoadedModel<K>>> }
  | { scope: "installation"; load(req: InstallationRequest): Promise<Loaded<LoadedModel<K>>> }
  | TenantViewDef<K>
);
export type ViewDef = { [K in ViewKind]: ViewDefOf<K> }[ViewKind];

/** Builds the confirmation step a person sees before a write, without writing. */
export type Prepare = (
  req: SurfaceRequest,
  input: { params: Record<string, string>; body: unknown },
) => Promise<Loaded<Ceremony>>;
type ActionBase = {
  id: Id;
  title: string;
  /** The entity this action is offered on. */
  target: EntityKind;
  /** The zod schema the route parses its body with. */
  input: ZodType;
  inputVersion: number;
  /**
   * What a second identical send does (Repeat in ./contract). Required, so
   * every action says.
   *
   * Each "safe" action has a case in src/lib/gui/__tests__/repeat.db.test.ts,
   * which sends it twice to its route against a database and fails if the
   * second send changes a row. A billing, payments or Pesapal action is
   * never "unsafe" (gui-surface.test.ts, check 12) unless
   * src/lib/gui/__tests__/repeat/exemptions.ts names the issue building its
   * repeat key. No route takes a repeat key yet, so the twice-sent test
   * refuses "keyed". If either test stops checking this, revisit.
   */
  repeat: Repeat;
  /** An existing route.ts exporting `method`, owned by this plugin and released. */
  path: string;
  /** Filled from the entity and hidden in forms. */
  bind: { path?: Record<string, EntityKind>; body?: Record<string, EntityKind> };
  /** true, or the reason the action is not available for that id. */
  available?(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>>;
  /**
   * false: never appended to another plugin's view of the target by
   * appendTargetedActions; offered only where a loader links it. The host
   * does not check that the linking loader is this plugin's own
   * (resolveOwnAndTargeted resolves any view's links), so a copy another
   * plugin's loader links starts from that loader's prefill, or none; if
   * resolveOwnAndTargeted comes to check the plugin, revisit this sentence.
   *
   * For an action whose form must start from values only its own loader
   * supplies as prefill, such as a PUT that replaces a whole row: `prepare`
   * returns a confirmation, not starting values. If Prepare comes to supply
   * a prefill, such an action can use that instead.
   */
  targeted?: false;
  /**
   * "enabled": the action's route accepts it while the action's plugin is
   * off for the organization, by design, so the host shows it enabled on
   * its own plugin's view and prepares it while the plugin gate answers that
   * the plugin is off (its 409). The gate is still asked, and a gate that
   * cannot be read (its 503, or a throw) still disables and refuses it;
   * available() and prepare still run. Another plugin's view still leaves
   * it out while its plugin is off (actionRef in host/shared/merge-actions.ts).
   *
   * Declared, never inferred: gui-surface.test.ts allows it only on an
   * action whose `METHOD /api/route` is a PaymentExemption in UNGATED_WRITES
   * (src/lib/runtime/__tests__/route-rules.ts), so the host never offers a
   * write the route would refuse. If that exemption is removed, remove this.
   */
  whilePluginOff?: "enabled";
  /**
   * Codes of the route's 409 answers that mean what the person confirmed
   * changed after prepare, such as the figures a ceremony's digest covers.
   * On one, the host prepares the action again with the same ref and shows
   * the new step, with the route's message as its note; it never sends on
   * its own (ADR-006, decision 10). Needs `prepare` and a confirmation step.
   * Each code must be one the route answers in its body's `code`:
   * gui-surface.test.ts checks that it is written in the route or under
   * src/lib, and the route stays the authority, checking the confirmation
   * again on every write.
   */
  prepareAgainOn?: readonly string[];
};
type WriteMethod = "POST" | "PUT" | "PATCH";
type LightLevel =
  | { risk: "write" | "money"; confirm: "none" | "confirm"; method: WriteMethod; prepare?: Prepare }
  // An external action contacts someone outside MGM; `prepare` shows who.
  | { risk: "external"; confirm: "confirm"; method: WriteMethod; prepare: Prepare };
/** The only kind of action an assistant may propose. */
export type ProposableAction = ActionBase & LightLevel & { humanOnly: false };
export type HumanAction = ActionBase & LightLevel & { humanOnly: true };
/** Typed and ceremony actions, and every DELETE or destructive action: human-only and prepared. */
export type GuardedAction = ActionBase & {
  humanOnly: true;
  confirm: "typed" | "ceremony";
  risk: "write" | "money" | "external" | "destructive";
  method: WriteMethod | "DELETE";
  prepare: Prepare;
};
export type ActionDef = ProposableAction | HumanAction | GuardedAction;

/**
 * Who a nav entry is shown to. "staff", the default, is a person holding a
 * role other than tenant (rolesIncludeStaff; staff is an audience here, not
 * a role, as @/lib/roles defines it); "super-admin" only super admins; "tenant" a person
 * with a tenant row, and only for an entry naming a tenant view. A person
 * with both kinds of row sees both groups (RFC mgm#197 § 4). An audience
 * hides an entry; it authorizes nothing.
 */
export type NavAudience = "staff" | "super-admin" | "tenant";

export type NavDef = {
  id: Id;
  title: string;
  icon: Icon;
  group: NavGroup;
  order: number;
  /** Absent means "staff". This hides the entry; it does not authorize anything. */
  audience?: NavAudience;
} & (
  | { view: Id }
  // A legacy page's path. It becomes a NavEntry's Href, so it is one too: see
  // Href for what the type does not check.
  | { href: Href; needs: CoreEntityKind[]; legacy: true }
);
/** What a watcher returns: a Signal without `source`, which the host sets, and with ActionLinks for actions. */
export type SignalOut = SignalOf<ActionLink> extends infer S ? (S extends unknown ? Omit<S, "source"> : never) : never;

/**
 * The most signals one watcher may return. The host refuses a longer answer
 * as invalid rather than cutting it (collectSignals in
 * host/server/signals.ts), so a watcher that can find more stops at this
 * many itself, most urgent first, and `Signals.count` then counts at most
 * this many from that source.
 */
export const MAX_SIGNALS_PER_SOURCE = 50;

/**
 * A watcher: what a plugin reports that needs someone, for one
 * organization (ADR-006 decision 9). The host runs it only for staff of that
 * organization and only while the plugin is on for it, within `budgetMs`
 * (1500 ms unless given), on a request of its own, and lists it as
 * unchecked when it is late, throws or returns anything the host refuses.
 *
 * Each signal's `id` is unique among the watcher's own, and the host sends
 * it prefixed with the watcher's id (`<watcher id>:<id>`), so ids from two
 * watchers never collide. Its `href`, where the person resolves it, is a
 * released page the watcher's own plugin owns. A watcher reads through
 * `req.supabase` or a capability's reads, filters by `req.organizationId`
 * itself (a super admin's row-level security shows every organization), and
 * throws when a read fails, so a failed read shows as unchecked rather than
 * as nothing to do.
 */
export type SignalDef = {
  id: Id;
  budgetMs?: number;
  load(req: SurfaceRequest): Promise<SignalOut[]>;
  /** Fixtures, so every GUI can be tested against the watcher's signals. */
  examples: readonly SignalOut[];
  /**
   * "checked": the host still runs this watcher while the plugin gate
   * answers that its plugin is off for the organization (its 409), because
   * what it reports can still be resolved then. A gate that cannot be read
   * (its 503, or a throw) still lists it as unchecked, without running it.
   *
   * Declared, never inferred: gui-surface.test.ts allows it only on a
   * Payments or Pesapal watcher, and only while every Payments capability
   * method a surface module may call (LOADER_READS there) runs while the
   * plugin is off, as `attach.whilePluginOff` on a view. If the reconcile
   * route stops accepting reconciliation while Payments is off
   * (docs/payments-rollout.md), remove it from `payments.reconcile`.
   */
  whilePluginOff?: "checked";
  /**
   * Deny by default, as on a view: only this lets an assistant read the
   * watcher's signals, and what an assistant reads is decided by ADR-007,
   * through the host. The watcher must be on the code-owned list in
   * ./assistant-reads.ts, and contribution-schema.ts refuses the mark on a
   * watcher of a plugin whose reading it refuses (ASSISTANT_READING there),
   * billing's and payments' included. The host's read interface
   * (readForAssistant in host/server/assistant-read.ts, through
   * assistantSignals in host/server/signals.ts) runs only watchers that are
   * marked and listed, and counts over them alone; an unmarked watcher never
   * runs for an assistant. If another path gives signals to an assistant,
   * it must do the same, and this comment changes with it.
   */
  agent?: "read";
};

export interface Contribution {
  plugin: MgmPluginName;
  nav?: NavDef[];
  views?: ViewDef[];
  actions?: ActionDef[];
  signals?: SignalDef[];
  status?: { id: Id; load(req: SurfaceRequest): Promise<Omit<StatusItemOf<ActionLink>, "id"> | null> }[];
  search?: { prefix: "@" | "#"; entity: EntityKind; find(req: SurfaceRequest, q: string): Promise<EntityHit[]> }[];
  /** The plugin's own entity kinds, and how each resolves to its organization (null: not visible). */
  entities?: {
    kind: `${string}.${string}`;
    organizationOf(req: InstallationRequest, id: string): Promise<string | null>;
  }[];
}

/** The root service that holds capability contributions and installed GUIs. */
export interface MgmSurface {
  /** Registers a capability's contribution; the returned function removes it. Throws on any broken rule. */
  contribute(c: Contribution): () => void;
  /** Installs a compiled-in GUI; the returned function removes it. Throws when its range excludes GUI_CONTRACT. */
  install(gui: GuiMeta): () => void;
}

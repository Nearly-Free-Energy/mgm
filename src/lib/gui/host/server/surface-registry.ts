import "server-only";

/**
 * The GUI surface: every capability's contribution and every installed GUI,
 * held on the runtime root (docs/cordis-runtime.md § "GUI surface").
 *
 * contribute() and install() are deterministic. They read only what they
 * are given and the catalog, never the environment, the network or the
 * database, so the Test gate's root build (runtime.test.ts) refuses exactly
 * what a production start would. A refusal throws, and the platform plugin
 * that called it fails, which stops the runtime.
 *
 * The registry holds definitions, never request data.
 */
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { GUI_CONTRACT, type EntityKind, type GuiMeta, type Id } from "../../contract";
import type { ActionDef, Contribution, InstallationRequest, MgmSurface, NavDef, ViewDef } from "../../surface";
import { satisfiesContract } from "../shared/contract-range";
import {
  SurfaceContributionError,
  parseContribution,
  type ParsedContribution,
  type SurfaceCatalog,
} from "./contribution-schema";
import { guiMetaSchema } from "./model-schema";

type Entry<K extends "signals" | "status" | "search"> = NonNullable<Contribution[K]>[number];

export type RegisteredView = { plugin: MgmPluginName; def: ViewDef };
export type RegisteredAction = { plugin: MgmPluginName; def: ActionDef };
export type RegisteredNav = { plugin: MgmPluginName; def: NavDef };
export type RegisteredSignal = Entry<"signals"> & { plugin: MgmPluginName };
export type RegisteredStatus = Entry<"status"> & { plugin: MgmPluginName };
export type RegisteredSearch = Entry<"search"> & { plugin: MgmPluginName };
export type RegisteredEntity = {
  plugin: MgmPluginName;
  organizationOf(req: InstallationRequest, id: string): Promise<string | null>;
};

/** What the host reads: every registered definition with the plugin that contributed it. */
export interface SurfaceSnapshot {
  views: readonly RegisteredView[];
  actions: ReadonlyMap<Id, RegisteredAction>;
  nav: readonly RegisteredNav[];
  signals: readonly RegisteredSignal[];
  status: readonly RegisteredStatus[];
  search: readonly RegisteredSearch[];
  entities: ReadonlyMap<EntityKind, RegisteredEntity>;
  guis: readonly GuiMeta[];
}

/** The ids one contribution claims, by list, with the field that names each. */
function claims(c: Contribution): { list: string; index: number; field: string; id: string }[] {
  const out: { list: string; index: number; field: string; id: string }[] = [];
  const each = (list: string, items: readonly { id: string }[] = []) =>
    items.forEach((item, index) => out.push({ list, index, field: "id", id: item.id }));
  each("nav", c.nav);
  each("views", c.views);
  each("actions", c.actions);
  each("signals", c.signals);
  each("status", c.status);
  (c.entities ?? []).forEach((e, index) => out.push({ list: "entities", index, field: "kind", id: e.kind }));
  return out;
}

/**
 * A frozen deep copy of the plain objects and arrays in `value`. Functions and
 * class instances (zod schemas) stay shared. The registry parses and keeps this
 * copy, so a later change to the contributor's own objects reaches nothing.
 */
function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozenCopy(v)]))) as T;
    }
  }
  return value;
}

function refuse(plugin: string, path: PropertyKey[], message: string): never {
  throw new SurfaceContributionError(plugin, new z.ZodError([{ code: "custom", path, message, input: undefined }]));
}

export class SurfaceRegistry implements MgmSurface {
  private readonly contributions = new Map<MgmPluginName, ParsedContribution>();
  /** "<list> <id>" → the plugin that registered it. */
  private readonly ids = new Map<string, MgmPluginName>();
  private readonly guis = new Map<string, GuiMeta>();
  private cached: SurfaceSnapshot | null = null;

  constructor(private readonly catalog: SurfaceCatalog) {}

  /**
   * Parses and registers a capability's contribution, or throws
   * SurfaceContributionError naming the plugin and the path. One contribution
   * per plugin, and each id is unique across the registry. Deterministic (see
   * the module header). It keeps a frozen copy of what it checked. Call it
   * inside ctx.effect so unloading removes it.
   */
  contribute(c: Contribution): () => void {
    const parsed = parseContribution(frozenCopy(c), this.catalog);
    const { plugin } = parsed;
    if (this.contributions.has(plugin)) refuse(plugin, ["plugin"], `${plugin} has already contributed`);
    const ids = claims(parsed.contribution);
    for (const { list, index, field, id } of ids) {
      const owner = this.ids.get(`${list} ${id}`);
      if (owner) refuse(plugin, [list, index, field], `"${id}" is already registered by ${owner}`);
    }
    this.contributions.set(plugin, parsed);
    for (const { list, id } of ids) this.ids.set(`${list} ${id}`, plugin);
    this.cached = null;
    return () => {
      if (this.contributions.get(plugin) !== parsed) return;
      this.contributions.delete(plugin);
      for (const { list, id } of ids) this.ids.delete(`${list} ${id}`);
      this.cached = null;
    };
  }

  /**
   * Installs a compiled-in GUI's metadata, or throws when the metadata is
   * malformed, its range excludes GUI_CONTRACT, its name is a catalog
   * plugin's, or a GUI of that name is installed. Deterministic.
   */
  install(gui: GuiMeta): () => void {
    const result = guiMetaSchema.safeParse(gui);
    const name = typeof gui?.name === "string" ? gui.name : "(no name)";
    if (!result.success) throw new Error(`GUI "${name}" metadata refused:\n${z.prettifyError(result.error)}`);
    const meta: GuiMeta = frozenCopy(result.data);
    if (!satisfiesContract(GUI_CONTRACT, meta.contract)) {
      throw new Error(`GUI "${name}" supports GUI contract ${meta.contract}; this MGM provides ${GUI_CONTRACT}`);
    }
    if (this.catalog.plugins.some((p) => p.name === name)) {
      throw new Error(`GUI "${name}" has the name of a plugin in the catalog`);
    }
    if (this.guis.has(name)) throw new Error(`GUI "${name}" is already installed`);
    this.guis.set(name, meta);
    this.cached = null;
    return () => {
      if (this.guis.get(name) !== meta) return;
      this.guis.delete(name);
      this.cached = null;
    };
  }

  gui(name: string): GuiMeta | undefined {
    return this.guis.get(name);
  }

  /** Every registered definition, in registration order. Rebuilt only after a change. */
  snapshot(): SurfaceSnapshot {
    if (this.cached) return this.cached;
    const views: RegisteredView[] = [];
    const actions = new Map<Id, RegisteredAction>();
    const nav: RegisteredNav[] = [];
    const signals: RegisteredSignal[] = [];
    const status: RegisteredStatus[] = [];
    const search: RegisteredSearch[] = [];
    const entities = new Map<EntityKind, RegisteredEntity>();
    for (const { plugin, contribution: c } of this.contributions.values()) {
      for (const def of c.views ?? []) views.push({ plugin, def });
      for (const def of c.actions ?? []) actions.set(def.id, { plugin, def });
      for (const def of c.nav ?? []) nav.push({ plugin, def });
      for (const s of c.signals ?? []) signals.push({ ...s, plugin });
      for (const s of c.status ?? []) status.push({ ...s, plugin });
      for (const s of c.search ?? []) search.push({ ...s, plugin });
      for (const e of c.entities ?? []) entities.set(e.kind, { plugin, organizationOf: e.organizationOf });
    }
    this.cached = Object.freeze({
      views: Object.freeze(views),
      actions,
      nav: Object.freeze(nav),
      signals: Object.freeze(signals),
      status: Object.freeze(status),
      search: Object.freeze(search),
      entities,
      guis: Object.freeze([...this.guis.values()]),
    });
    return this.cached;
  }
}

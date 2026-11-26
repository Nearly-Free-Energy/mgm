import "server-only";

/**
 * How the assistant read interface (./assistant-read.ts) recognises, in a
 * view's model or a signal, a reference #133's data boundary keeps from any
 * model (ADR-007 decisions 6 and 7). A pure rule: it reads only what it is
 * given, the plugin catalog and the contribution check's lists, so the same
 * value always gets the same answer.
 *
 * Refused, at any depth outside the data subtrees (DATA_KEYS in ./parse.ts:
 * `ext`, `prefill`, `params`):
 *
 * - an entity reference (`entity`, each of `related`, and `ref` on a Value
 *   with `t: "ref"`) of a kind in ASSISTANT_REFUSED_KINDS (tenant, device,
 *   rate schedule, billing period, line item, payment attempt, community
 *   management's tenant access, the organization directory's person), or of a
 *   plugin's own kind whose alias names no plugin in the catalog or a plugin
 *   ASSISTANT_READING refuses (./contribution-schema.ts). Devices are refused
 *   because an EntityRef's label is a device's name, which decision 6 keeps
 *   out of every staff view;
 * - an href (HREF_KEYS in ./parse.ts: `href`, `link`, `next`) that is not a
 *   same-origin path, so every OutHref (wa.me, tel:, sms:), which is
 *   contact detail; every /api path, since an assistant is given no action
 *   and no download and an API path can name a tenant or device in a
 *   segment whatever plugin owns it (`/api/tenants/<id>`); a page path with
 *   a fragment, which can name a record; a page path that names no
 *   contributed view and no catalog page; a page path whose view or catalog
 *   page belongs to a plugin ASSISTANT_READING refuses (billing, payments,
 *   Pesapal, the tenant app, operations), bare or with any parameter, since
 *   nobody reviews such a plugin's pages or their `query` against ADR-007
 *   (its views can never be on ASSISTANT_READS) and its parameters can name
 *   a tenant or a bill (`?tenant_id=`, `?bill=`); a tenant view's path (`scope:
 *   "tenant"`), bare or with any parameter (`?unit=` names the unit); a page
 *   path with a segment of a refused kind; and a page path with a search
 *   parameter other than its view's declared `query` names and `org` (a
 *   catalog page that no view serves takes none), since a parameter such as
 *   `?tenant=` names a record the path does not. A declared parameter of a
 *   "per view" plugin's organization view is allowed whatever record it
 *   names, so this holds only while no such view's `query` names a refused
 *   record (see the revisit condition below);
 * - a LinkRef's `share` or `download`, which carry free text.
 *
 * Not covered: `ext.data`, whose fields only the view's own schema names
 * (site-day's `dayHref`, for one). The code-owned list's review and its pin
 * of each view's declaration cover ext (ADR-007 decision 8).
 *
 * The positions are found by property name, as parse.ts finds hrefs, and
 * assistant-references.test.ts walks the model and signal schemas
 * (./model-schema.ts) and fails if an EntityRef or href sits under another
 * name, an EntityRef under `ref` on anything but the `t: "ref"` Value, or
 * one under `related` anywhere but an element of the array it holds.
 * If a model shape gains one there, ASSISTANT_REFUSED_KINDS or
 * ASSISTANT_READING changes, a view of a "per view" plugin whose segments
 * are all allowed declares a `query` parameter naming a tenant, device,
 * person, billing or payment record, or a view scope other than "tenant"
 * comes to be about a tenant's own unit, revisit this rule.
 */
import { CORE_ENTITY_KINDS, getPluginByAlias, matchCatalogPage } from "@/lib/plugins/bundled";
import { isSameOriginPath } from "../shared/href";
import { ASSISTANT_READING, ASSISTANT_REFUSED_KINDS } from "./contribution-schema";
import { matchView } from "./match-view";
import { DATA_KEYS, HREF_KEYS, RECORD_KEYS } from "./parse";
import type { RegisteredView } from "./surface-registry";

/**
 * Why a value was refused, for the server's log: the path of property names,
 * array indices and declared keys, and the kind of reference. Never a value.
 */
export type ReferenceRefusal = {
  path: string;
  /** An entity kind, or what about an href or LinkRef was refused. */
  kind: string;
};

const CORE: ReadonlySet<string> = new Set(CORE_ENTITY_KINDS);

/** Whether an assistant may never be given a reference of entity kind `kind`. */
export function refusedKind(kind: string): boolean {
  // The list holds a plugin kind too, so it is asked before the plugin's reading.
  if (ASSISTANT_REFUSED_KINDS.has(kind)) return true;
  if (CORE.has(kind)) return false;
  const dot = kind.indexOf(".");
  if (dot <= 0) return true;
  const plugin = getPluginByAlias(kind.slice(0, dot));
  return plugin === undefined || refusedPlugin(plugin.name);
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What about `href` is refused, or null when an assistant may be given it. */
export function hrefRefusal(href: string, views: readonly RegisteredView[]): string | null {
  if (!isSameOriginPath(href)) return "outside link";
  const url = new URL(href, "https://host.invalid");
  const path = url.pathname;
  const names = [...new Set(url.searchParams.keys())];
  if (path === "/api" || path.startsWith("/api/")) return "api route";
  // isSameOriginPath allows a fragment; `#` is never part of a path, so any
  // `#` starts one (an empty one too, which url.hash reads as "").
  if (href.includes("#")) return "fragment";
  const view = matchView(views, path);
  if (view) {
    for (const kind of Object.values(view.view.def.params)) if (refusedKind(kind)) return kind;
    // Before the parameters: a refused plugin's view and a tenant view are
    // refused bare, so none of their declared `query` names is ever allowed.
    if (refusedPlugin(view.view.plugin)) return "refused plugin";
    if (view.view.def.scope === "tenant") return "tenant view";
    const allowed = new Set<string>([...(view.view.def.query ?? []), "org"]);
    return names.every((name) => allowed.has(name)) ? null : "search parameter";
  }
  const page = matchCatalogPage(path);
  if (!page) return "unknown page";
  for (const kind of Object.values(page.page.params)) if (refusedKind(kind)) return kind;
  if (refusedPlugin(page.plugin.name)) return "refused plugin";
  return names.length === 0 ? null : "search parameter";
}

/** Whether ASSISTANT_READING refuses `plugin`'s reading; a name missing from it is refused. */
function refusedPlugin(plugin: string): boolean {
  return (ASSISTANT_READING as Readonly<Record<string, string>>)[plugin] !== "per view";
}

function entityRefusal(ref: unknown): string | null {
  if (!isPlain(ref) || typeof ref.kind !== "string") return null;
  return refusedKind(ref.kind) ? ref.kind : null;
}

/**
 * The first reference in `value` an assistant may not be given, or null.
 * `value` is a view model or a signal that has passed its schema.
 */
export function findRefusedReference(value: unknown, views: readonly RegisteredView[]): ReferenceRefusal | null {
  let found: ReferenceRefusal | null = null;
  const refuse = (path: (string | number)[], kind: string) => {
    found ??= { path: path.join(".") || "(value)", kind };
  };
  // Under a record (`keysAreData`), a key is a view's declared key, not a property name.
  const walk = (node: unknown, path: (string | number)[], keysAreData: boolean): void => {
    if (found) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i], false));
      return;
    }
    if (!isPlain(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const at = [...path, key];
      if (!keysAreData) {
        if (DATA_KEYS.has(key)) continue;
        if (key === "share" || key === "download") refuse(at, key);
        if (HREF_KEYS.has(key) && typeof child === "string") {
          const why = hrefRefusal(child, views);
          if (why !== null) refuse(at, why);
          continue;
        }
        if (key === "entity" || (key === "ref" && node.t === "ref")) {
          const kind = entityRefusal(child);
          if (kind !== null) refuse(at, kind);
        }
        if (key === "related" && Array.isArray(child)) {
          child.forEach((ref, i) => {
            const kind = entityRefusal(ref);
            if (kind !== null) refuse([...at, i], kind);
          });
        }
      }
      walk(child, at, !keysAreData && RECORD_KEYS.has(key));
    }
  };
  walk(value, [], false);
  return found;
}

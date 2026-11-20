/**
 * How Gridtop arranges the manifest's apps: the four groups in order, the
 * entries of each by `order`, the apps pinned to the phone dock, and which
 * app the current page belongs to.
 */
import type { Href, Id, Manifest, NavEntry, NavGroup } from "@/lib/gui/contract";

export const GROUPS: readonly { id: NavGroup; title: string }[] = [
  { id: "operate", title: "Operate" },
  { id: "money", title: "Money" },
  { id: "configure", title: "Configure" },
  { id: "system", title: "System" },
];

/**
 * The phone dock's three apps. Nav ids are permanent (decision 10 on #115),
 * so these stay right while the capabilities' surface.ts files keep them.
 */
export const PINNED: readonly Id[] = ["org.today", "metering.operations", "billing.periods"];

/**
 * The phone dock's apps for a tenant (RFC mgm#197 § 4), from the tenant
 * app's surface (src/lib/tenant-app/surface.ts); the third slot is the
 * account menu (./bottom-dock.tsx). If those nav ids change, revisit.
 */
export const TENANT_PINNED: readonly Id[] = ["tenant.home", "tenant.usage"];

/**
 * Whether the manifest is a tenant's: the host builds a tenant manifest with
 * no organization to switch to (buildTenantManifestModel,
 * src/lib/gui/host/shared/manifest-model.ts), and a staff manifest always
 * lists the current organization. A person with staff and tenant rows gets a
 * staff manifest. NavEntry carries no audience on the client. If a staff
 * manifest can ever list no organization, or the contract starts carrying
 * audience, revisit.
 */
export const isTenantManifest = (manifest: Pick<Manifest, "orgs">): boolean => manifest.orgs.length === 0;

const rank = (group: NavGroup) => GROUPS.findIndex((g) => g.id === group);

/** Every entry, in group order and then by `order`. */
export function ordered(nav: readonly NavEntry[]): NavEntry[] {
  return [...nav].sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order || a.id.localeCompare(b.id));
}

/** The groups that have entries, each with its entries in order. */
export function grouped(nav: readonly NavEntry[]): { id: NavGroup; title: string; entries: NavEntry[] }[] {
  const all = ordered(nav);
  return GROUPS.map((g) => ({ ...g, entries: all.filter((e) => e.group === g.id) })).filter((g) => g.entries.length > 0);
}

/** The apps `ids` names (PINNED by default), each absent one replaced by the first entry in group order not already shown. */
export function pinned(nav: readonly NavEntry[], ids: readonly Id[] = PINNED): NavEntry[] {
  const all = ordered(nav);
  const used = new Set(ids.filter((id) => all.some((e) => e.id === id)));
  return ids.flatMap((id) => {
    const own = all.find((e) => e.id === id);
    if (own) return [own];
    const next = all.find((e) => !used.has(e.id));
    if (!next) return [];
    used.add(next.id);
    return [next];
  });
}

const segments = (href: string) => href.split(/[?#]/, 1)[0].split("/").filter(Boolean);

/**
 * The app the page belongs to: the entry whose filled href is the longest
 * segment prefix of the path, "/" matching only itself. It matches hrefs
 * filled from the scope, so it agrees with legacyView's nav
 * (src/lib/gui/host/shared/legacy-view.ts, which a GUI cannot import) while
 * the path names places the manifest holds. For a path naming another place,
 * such as /microgrids/<unknown>/billing, legacyView still names the app
 * (billing.periods) and this names the list (community.microgrids). If the
 * view starts carrying legacyView's nav, use that instead.
 */
export function currentApp(nav: readonly NavEntry[], hrefOf: (entry: NavEntry) => Href | null, pathname: string): Id | null {
  const path = segments(pathname);
  let best: { id: Id; length: number } | null = null;
  for (const entry of nav) {
    const href = hrefOf(entry);
    if (!href) continue;
    const own = segments(href);
    if (own.length > path.length || (own.length === 0 && path.length > 0)) continue;
    if (own.every((s, i) => s === path[i]) && (!best || own.length > best.length)) best = { id: entry.id, length: own.length };
  }
  return best?.id ?? null;
}

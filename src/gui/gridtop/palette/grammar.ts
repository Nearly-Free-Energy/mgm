/**
 * What the command palette lists for what the person has typed. Pure: the
 * palette (./palette.tsx) runs the search and acts on a choice.
 *
 *   empty       Go to (every app), Places, and Organizations when there are several
 *   /…          apps, then the shown view's actions
 *   @…          places matching, then the host's entity search
 *   #…          the host's view search
 *   plain text  apps, places and organizations matching
 *
 * A choice only navigates, asks for a place, or hands the view's own
 * ActionRef to kit.act, so the host's form and confirmation run.
 */
import type { ActionRef, EntityHit, Href, Manifest, NavEntry, ViewState } from "@/lib/gui/contract";
import { ordered } from "../shell/groups";
import { pickStep, type Picked } from "../shell/pick-step";

/** How long typing must pause before the palette asks the host to search. */
export const SEARCH_DELAY_MS = 250;
/** kit.search answers nothing for less (host/client/kit-runtime.tsx); if that changes, revisit. */
export const SEARCH_MIN = 2;
/** No capability contributes "#" search yet. */
export const NOTHING_WITH_HASH = "Nothing to find with # yet";

export type Prefix = "" | "/" | "@" | "#";
export type Choice =
  | { type: "go"; key: string; label: string; detail?: string; href: Href }
  /** An app that needs a place first, or a place that leads to the next pick. */
  | { type: "pick"; key: string; label: string; detail: string; entry: NavEntry; picked: Picked }
  /** `ref` is the view's own object, never a copy. */
  | { type: "act"; key: string; label: string; detail?: string; ref: ActionRef };
export interface Section {
  heading: string;
  choices: Choice[];
}
export interface Listing {
  sections: Section[];
  /** What to say when no section has a choice. */
  empty: string;
}
export interface PaletteContext {
  view: ViewState;
  orgs: Manifest["orgs"];
  /** The organization shown. */
  org: string;
}

export function parse(input: string): { prefix: Prefix; query: string } {
  const text = input.trimStart();
  const first = text.charAt(0);
  if (first === "/" || first === "@" || first === "#") return { prefix: first, query: text.slice(1).trim() };
  return { prefix: "", query: text.trim() };
}

/** The host search to run for this input, or null. */
export function searchFor(input: string): { query: string; prefix: "@" | "#" } | null {
  const { prefix, query } = parse(input);
  return (prefix === "@" || prefix === "#") && query.length >= SEARCH_MIN ? { query, prefix } : null;
}

const words = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u);

/** 0 when the label starts with the query, 1 when a word of it does, 2 when it holds it, 3 when only the detail does. */
function rank(choice: Choice, query: string): number | null {
  const label = choice.label.toLocaleLowerCase();
  if (label.startsWith(query)) return 0;
  if (words(choice.label).some((word) => word.startsWith(query))) return 1;
  if (label.includes(query)) return 2;
  if (choice.detail?.toLocaleLowerCase().includes(query)) return 3;
  return null;
}

/** The choices matching `query`, best first; equal ones keep their order. */
export function matching(choices: Choice[], query: string): Choice[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return choices;
  return choices
    .map((choice, index) => ({ choice, index, rank: rank(choice, q) }))
    .filter((c): c is { choice: Choice; index: number; rank: number } => c.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((c) => c.choice);
}

const many = (kind: string) => (kind === "community" ? "communities" : `${kind}s`);

/** Every app, in the dock's order. One that still needs a place asks for it, by the place picker's rule. */
function apps(view: ViewState): Choice[] {
  return ordered(view.org.nav).flatMap((entry): Choice[] => {
    const key = `nav:${entry.id}`;
    const step = pickStep(view, entry);
    if (step) return [{ type: "pick", key, label: entry.title, detail: `choose a ${step.kind}`, entry, picked: {} }];
    const href = view.href(entry);
    return href ? [{ type: "go", key, label: entry.title, href }] : [];
  });
}

/** Microgrids, each with its community, then communities. */
function places(view: ViewState): Choice[] {
  const all = view.org.places;
  const community = (id: string | undefined) => all.find((p) => p.kind === "community" && p.id === id)?.label;
  const of = (kind: "microgrid" | "community") =>
    all.flatMap((place): Choice[] => {
      if (place.kind !== kind || !place.href) return [];
      const parent = kind === "microgrid" ? community(place.parent) : undefined;
      const detail = kind === "microgrid" ? (parent ? `Microgrid in ${parent}` : "Microgrid") : "Community";
      return [{ type: "go", key: `place:${kind}:${place.id}`, label: place.label, detail, href: place.href }];
    });
  return [...of("microgrid"), ...of("community")];
}

function organizations({ orgs, org }: PaletteContext): Choice[] {
  if (orgs.length < 2) return [];
  return orgs.map((o) => ({
    type: "go",
    key: `org:${o.id}`,
    label: o.name,
    detail: o.id === org ? "Current organization" : "Organization",
    href: o.href,
  }));
}

/** The shown view's actions; a disabled one says why and cannot be chosen. */
function actions(view: ViewState): Choice[] {
  return (view.model?.actions ?? []).map((ref, i) => ({
    type: "act",
    key: `act:${i}:${ref.action}`,
    label: ref.label,
    detail: ref.enabled ? ref.from : (ref.reason ?? "Not available"),
    ref,
  }));
}

function found(hits: readonly EntityHit[], except: Choice[] = []): Choice[] {
  const shown = new Set(except.map((c) => (c.type === "go" ? c.href : "")));
  return hits
    .filter((hit) => !shown.has(hit.href))
    .map((hit) => ({ type: "go", key: `hit:${hit.kind}:${hit.id}:${hit.href}`, label: hit.label, href: hit.href }));
}

const nonEmpty = (sections: Section[]) => sections.filter((s) => s.choices.length > 0);

/** What to list for `input`; `hits` are the host search's answer for searchFor(input). */
export function listing(input: string, context: PaletteContext, hits: readonly EntityHit[] = []): Listing {
  const { prefix, query } = parse(input);
  const { view } = context;
  const empty = query ? `Nothing matches “${query}”` : "Nothing to show";
  if (prefix === "/") {
    return {
      sections: nonEmpty([
        { heading: "Go to", choices: matching(apps(view), query) },
        { heading: "Actions", choices: matching(actions(view), query) },
      ]),
      empty,
    };
  }
  if (prefix === "@") {
    const local = matching(places(view), query);
    return { sections: nonEmpty([{ heading: "Places", choices: local }, { heading: "Found", choices: found(hits, local) }]), empty };
  }
  if (prefix === "#") return { sections: nonEmpty([{ heading: "Found", choices: found(hits) }]), empty: NOTHING_WITH_HASH };
  return {
    sections: nonEmpty([
      { heading: "Go to", choices: matching(apps(view), query) },
      { heading: "Places", choices: matching(places(view), query) },
      { heading: "Organizations", choices: matching(organizations(context), query) },
    ]),
    empty,
  };
}

/** The places to pick for `entry`, after `picked`; each opens the app or leads to the next pick. */
export function pickListing(view: ViewState, entry: NavEntry, picked: Picked, input: string): Listing {
  const step = pickStep(view, entry, picked);
  if (!step) return { sections: [], empty: "Nothing to show" };
  const choices = step.places.flatMap((place): Choice[] => {
    const pick = { ...step.chosen, [step.kind]: place };
    const key = `pick:${place.kind}:${place.id}`;
    const next = pickStep(view, entry, pick);
    if (next) return [{ type: "pick", key, label: place.label, detail: `then choose a ${next.kind}`, entry, picked: pick }];
    const href = view.href(entry, pick);
    return href ? [{ type: "go", key, label: place.label, href }] : [];
  });
  const inCommunity = step.kind !== "community" ? step.chosen.community : undefined;
  const where = inCommunity ? ` in ${inCommunity.label}` : "";
  const query = input.trim();
  return {
    sections: nonEmpty([{ heading: `${entry.title}: choose a ${step.kind}${where}`, choices: matching(choices, query) }]),
    empty: query ? `Nothing matches “${query}”` : `No ${many(step.kind)}${where} yet.`,
  };
}

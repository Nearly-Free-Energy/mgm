import { describe, expect, it } from "vitest";
import type { ActionRef, CoreEntityKind, EntityHit, EntityRef, Manifest, NavEntry, ViewModel, ViewState } from "@/lib/gui/contract";
import { listing, matching, NOTHING_WITH_HASH, parse, pickListing, searchFor, type Choice, type PaletteContext } from "../palette/grammar";

type Scope = Partial<Record<CoreEntityKind, EntityRef>>;
type Place = EntityRef & { parent?: string };

const nav = (id: NavEntry["id"], title: string, group: NavEntry["group"], order: number, href: string): NavEntry => ({
  id,
  title,
  icon: "sites",
  group,
  order,
  href: href as NavEntry["href"],
  needs: [...href.matchAll(/\[(\w+)\]/g)].map((m) => m[1] as CoreEntityKind),
});

const NAV = [
  nav("billing.periods", "Billing", "money", 10, "/microgrids/[microgrid]/billing"),
  nav("org.today", "Dashboard", "operate", 10, "/"),
  nav("community.microgrids", "Microgrids", "operate", 20, "/microgrids"),
  nav("org.users", "Users", "system", 20, "/settings/users"),
];

const community = (id: string, label: string): Place => ({ kind: "community", id, label, href: `/communities/${id}` });
const microgrid = (id: string, label: string, parent: string): Place => ({ kind: "microgrid", id, label, href: `/microgrids/${id}`, parent });
const C1 = community("c1", "Kasana");
const C2 = community("c2", "Lugazi");
const M1 = microgrid("m1", "East", "c1");
const M2 = microgrid("m2", "West", "c2");

/** A ViewState that fills a pattern as the kit does: the pick, the scope, then the only place of the kind. */
function viewOf(opts: { nav?: NavEntry[]; places?: Place[]; scope?: Scope; model?: ViewModel | null } = {}): ViewState {
  const places = opts.places ?? [C1, C2, M1, M2];
  const scope = opts.scope ?? {};
  const choices = (kind: CoreEntityKind) => places.filter((p) => p.kind === kind);
  return {
    view: null,
    title: "Dashboard",
    trail: [],
    tabs: [],
    scope,
    model: opts.model ?? null,
    org: { id: "o1", name: "Org One", href: "/organizations/o1", timezone: null, nav: opts.nav ?? NAV, status: [], places },
    choices,
    href(entry, pick = {}) {
      let missing = false;
      const filled = entry.href.replace(/\[(\w+)\]/g, (_, name: CoreEntityKind) => {
        const only = choices(name);
        const ref = pick[name] ?? scope[name] ?? (name === "organization" ? { id: "o1" } : only.length === 1 ? only[0] : undefined);
        if (!ref) missing = true;
        return ref ? ref.id : "";
      });
      return missing ? null : (filled as NavEntry["href"]);
    },
  };
}

const ONE_ORG: Manifest["orgs"] = [{ id: "o1", name: "Org One", href: "/organizations/o1" }];
const context = (view: ViewState, orgs = ONE_ORG): PaletteContext => ({ view, orgs, org: "o1" });

const headings = (l: { sections: { heading: string }[] }) => l.sections.map((s) => s.heading);
const labels = (choices: Choice[]) => choices.map((c) => c.label);
const section = (l: { sections: { heading: string; choices: Choice[] }[] }, heading: string) =>
  l.sections.find((s) => s.heading === heading)?.choices ?? [];

const ACTIONS: ActionRef[] = [
  { action: "community.rename", params: { id: "c1" }, label: "Rename", enabled: true },
  { action: "community.delete", params: { id: "c1" }, label: "Delete", enabled: false, reason: "It still has microgrids", tone: "danger" },
];
const MODEL: ViewModel = {
  type: "view",
  view: "community.community",
  kind: "record",
  title: "Kasana",
  org: "o1",
  trail: [],
  body: { sections: [] },
  actions: ACTIONS,
  links: [],
  attached: [],
};

describe("parse and searchFor", () => {
  it("reads the prefix and trims the query", () => {
    expect(parse("")).toEqual({ prefix: "", query: "" });
    expect(parse("  /ren ")).toEqual({ prefix: "/", query: "ren" });
    expect(parse("@ East")).toEqual({ prefix: "@", query: "East" });
    expect(parse("#x")).toEqual({ prefix: "#", query: "x" });
    expect(parse("bill")).toEqual({ prefix: "", query: "bill" });
  });

  it("searches the host only for @ and # with at least two characters", () => {
    expect(searchFor("@e")).toBeNull();
    expect(searchFor("#")).toBeNull();
    expect(searchFor("/ren")).toBeNull();
    expect(searchFor("east")).toBeNull();
    expect(searchFor("@ea")).toEqual({ query: "ea", prefix: "@" });
    expect(searchFor("# bill ")).toEqual({ query: "bill", prefix: "#" });
  });
});

describe("listing", () => {
  it("lists every app in the dock's order, places, and no organizations when there is one", () => {
    const l = listing("", context(viewOf()));
    expect(headings(l)).toEqual(["Go to", "Places"]);
    expect(labels(section(l, "Go to"))).toEqual(["Dashboard", "Microgrids", "Billing", "Users"]);
    expect(section(l, "Places")).toEqual([
      { type: "go", key: "place:microgrid:m1", label: "East", detail: "Microgrid in Kasana", href: "/microgrids/m1" },
      { type: "go", key: "place:microgrid:m2", label: "West", detail: "Microgrid in Lugazi", href: "/microgrids/m2" },
      { type: "go", key: "place:community:c1", label: "Kasana", detail: "Community", href: "/communities/c1" },
      { type: "go", key: "place:community:c2", label: "Lugazi", detail: "Community", href: "/communities/c2" },
    ]);
  });

  it("marks an app that needs a place, and fills one whose place is known", () => {
    const billing = (view: ViewState) => section(listing("", context(view)), "Go to").find((c) => c.label === "Billing");
    expect(billing(viewOf())).toMatchObject({ type: "pick", detail: "choose a microgrid", picked: {} });
    expect(billing(viewOf({ places: [C1, M1] }))).toMatchObject({ type: "go", href: "/microgrids/m1/billing" });
    expect(billing(viewOf({ scope: { microgrid: M2 } }))).toMatchObject({ type: "go", href: "/microgrids/m2/billing" });
  });

  it("lists organizations when there are several", () => {
    const orgs = [...ONE_ORG, { id: "o2", name: "Org Two", href: "/organizations/o2" }];
    const l = listing("", context(viewOf(), orgs as Manifest["orgs"]));
    expect(section(l, "Organizations")).toEqual([
      { type: "go", key: "org:o1", label: "Org One", detail: "Current organization", href: "/organizations/o1" },
      { type: "go", key: "org:o2", label: "Org Two", detail: "Organization", href: "/organizations/o2" },
    ]);
  });

  it("lists actions only after /, each with the view's own ref", () => {
    const view = viewOf({ model: MODEL });
    for (const input of ["", "re", "@re", "#re"]) {
      expect(listing(input, context(view)).sections.flatMap((s) => s.choices).some((c) => c.type === "act")).toBe(false);
    }
    const l = listing("/", context(view));
    expect(headings(l)).toEqual(["Go to", "Actions"]);
    const [rename, remove] = section(l, "Actions");
    expect(rename.type === "act" && rename.ref).toBe(ACTIONS[0]);
    expect(remove).toMatchObject({ type: "act", label: "Delete", detail: "It still has microgrids" });
    expect(remove.type === "act" && remove.ref).toBe(ACTIONS[1]);
    expect(labels(section(listing("/ren", context(view)), "Actions"))).toEqual(["Rename"]);
  });

  it("has no actions on a page without a view model", () => {
    expect(headings(listing("/", context(viewOf())))).toEqual(["Go to"]);
  });

  it("merges places matching after @ with the host's hits, without repeating a place", () => {
    const hits: EntityHit[] = [
      { kind: "microgrid", id: "m1", label: "East", href: "/microgrids/m1" },
      { kind: "household", id: "h1", label: "East shop", href: "/microgrids/m1/households/h1" },
    ];
    const l = listing("@ea", context(viewOf()), hits);
    expect(headings(l)).toEqual(["Places", "Found"]);
    expect(labels(section(l, "Places"))).toEqual(["East"]);
    expect(section(l, "Found")).toEqual([
      { type: "go", key: "hit:household:h1:/microgrids/m1/households/h1", label: "East shop", href: "/microgrids/m1/households/h1" },
    ]);
  });

  it("says there is nothing to find with # when the host finds nothing", () => {
    expect(listing("#", context(viewOf()))).toEqual({ sections: [], empty: NOTHING_WITH_HASH });
    expect(listing("#bill", context(viewOf()), [])).toEqual({ sections: [], empty: NOTHING_WITH_HASH });
    const hit: EntityHit = { kind: "microgrid", id: "m1", label: "East", href: "/microgrids/m1" };
    expect(labels(section(listing("#ea", context(viewOf()), [hit]), "Found"))).toEqual(["East"]);
  });

  it("matches plain text across apps and places, best match first", () => {
    const l = listing("kas", context(viewOf()));
    // The community by its name, then the microgrid whose community it is.
    expect(labels(section(l, "Places"))).toEqual(["Kasana", "East"]);
    expect(section(l, "Go to")).toEqual([]);
    expect(listing("zzz", context(viewOf()))).toEqual({ sections: [], empty: "Nothing matches “zzz”" });
  });
});

describe("matching", () => {
  const go = (label: string): Choice => ({ type: "go", key: label, label, href: "/" });
  it("puts a label that starts with the query first, then a word that does, then one that holds it", () => {
    const choices = [go("Rebill"), go("Monthly bills"), go("Billing"), go("Users")];
    expect(labels(matching(choices, "BILL"))).toEqual(["Billing", "Monthly bills", "Rebill"]);
    expect(matching(choices, "  ")).toBe(choices);
  });
});

describe("pickListing", () => {
  const AT = nav("billing.community-microgrid", "Site billing", "money", 20, "/communities/[community]/microgrids/[microgrid]/billing");

  it("never pairs a community with another community's microgrid", () => {
    const view = viewOf({ nav: [AT] });
    const first = pickListing(view, AT, {}, "");
    expect(headings(first)).toEqual(["Site billing: choose a community"]);
    const kasana = section(first, "Site billing: choose a community").find((c) => c.label === "Kasana");
    expect(kasana).toMatchObject({ type: "pick", detail: "then choose a microgrid" });
    if (kasana?.type !== "pick") throw new Error("expected a pick");
    const second = pickListing(view, AT, kasana.picked, "");
    expect(second.sections).toEqual([
      {
        heading: "Site billing: choose a microgrid in Kasana",
        choices: [{ type: "go", key: "pick:microgrid:m1", label: "East", href: "/communities/c1/microgrids/m1/billing" }],
      },
    ]);
  });

  it("offers only the microgrids of the community in scope", () => {
    const BILLING = NAV[0];
    const AT_C2 = nav("billing.community", "Site billing", "money", 20, "/communities/[community]/microgrids/[microgrid]/billing");
    const view = viewOf({ nav: [BILLING, AT_C2], scope: { community: C2 }, places: [C1, C2, M1, M2, microgrid("m3", "North", "c2")] });
    expect(labels(section(pickListing(view, AT_C2, {}, ""), "Site billing: choose a microgrid in Lugazi"))).toEqual(["West", "North"]);
  });

  it("narrows by the typed text and says when there is nothing to pick", () => {
    const view = viewOf();
    expect(labels(pickListing(view, NAV[0], {}, "we").sections[0].choices)).toEqual(["West"]);
    expect(pickListing(view, NAV[0], {}, "zz")).toEqual({ sections: [], empty: "Nothing matches “zz”" });
    expect(pickListing(viewOf({ places: [C1] }), NAV[0], {}, "")).toEqual({ sections: [], empty: "No microgrids yet." });
  });
});

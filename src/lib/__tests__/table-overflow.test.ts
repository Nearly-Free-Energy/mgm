/**
 * Wide tables scroll sideways inside their own box.
 *
 * On a phone a table is usually wider than the screen. Inside an element
 * that scrolls sideways (`overflow-x-auto`, `overflow-auto`, ...) it gets a
 * scrollbar of its own. Inside `overflow-hidden` its right-hand columns, often
 * the status and the row actions, are cut off with no way to reach them; with
 * no such element at all it widens the whole page.
 *
 * This test reads every `.tsx` file under src/app and src/components (tests
 * excluded) and checks that each `<table>` has an ancestor element whose
 * className makes it scroll sideways. The nearest ancestor that sets an
 * overflow decides; responsive variants (`md:overflow-x-auto`) are ignored,
 * because the rule is about the narrowest screen. A table drawn by a
 * component declared in the same file (`function BatteryChart()` used as
 * `<BatteryChart />`) takes the state of those uses, the worst one deciding.
 * A `<CopyTable>` counts as contained when the table inside
 * src/components/ui/copy-table.tsx scrolls.
 * A chart drawn with a fixed minimum width (an `<svg>` with a class such as
 * `min-w-[560px]`, like the battery chart on the Operations tab) is held to
 * the same rule.
 *
 * The scan sees one file at a time, so a table may need an EXEMPT entry,
 * keyed by file, with the number of tables it covers and the reason:
 *   - a table component whose caller in another file wraps it: the reason
 *     names that file, and the entry is wrong once that file stops wrapping it;
 *   - markup that never renders in the app's viewport (printed or emailed HTML);
 *   - a table no route renders: the reason says why nothing reaches it.
 * The count must match exactly, so a second table in an exempt file still
 * fails, and an entry that no longer matches a failing table fails as stale.
 * An entry whose file has been deleted is skipped, so deleting a file never
 * turns this test red; take the entry out in the same change.
 *
 * What it cannot see is layout. A scroll container inside a flex or grid item
 * without `min-w-0` can still widen the page, because such an item is at
 * least as wide as its content. Nor does it evaluate conditions: every class
 * string in a className counts, so `cn(open && "overflow-x-auto")` reads as
 * scrolling. Open new tables at 360 px wide as well.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = ["src/app", "src/components"];

/** Components whose own markup puts their table in a scroll container. */
const CONTAINED: Record<string, string> = {
  CopyTable: "src/components/ui/copy-table.tsx",
};

type Exemption = { tables: number; reason: string };

const EXEMPT: Record<string, Exemption> = {
  "src/components/dashboard/TopHouseholdsLeaderboard.tsx": {
    tables: 1,
    reason:
      "Rendered only by the microgrid overview, src/app/(dashboard)/microgrids/[id]/(overview)/page.tsx, " +
      "which no one reaches: src/middleware.ts redirects /microgrids/<id> to one of its tabs. " +
      "If that page renders again, wrap this table instead of keeping this entry.",
  },
};

type State = "scrolls" | "clips" | "uncontained";

type Found = { rel: string; line: number; tag: string; state: State };

function tagOf(el: ts.JsxOpeningLikeElement, sf: ts.SourceFile): string {
  return el.tagName.getText(sf);
}

/** Every class token a className attribute can produce, variants dropped. */
function classTokens(el: ts.JsxOpeningLikeElement): Set<string> {
  const texts: string[] = [];
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== "className") continue;
    const init = attr.initializer;
    if (!init) continue;
    const collect = (n: ts.Node): void => {
      if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n)
      ) {
        texts.push(n.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(init);
  }
  return new Set(
    texts
      .join(" ")
      .split(/\s+/)
      .filter((token) => token && !token.includes(":")),
  );
}

/**
 * What one element's overflow does to a wider child, or null when it leaves
 * overflow alone. Axis-specific classes are read first: Tailwind emits them
 * after the `overflow-*` shorthand, so `overflow-hidden overflow-x-auto`
 * scrolls sideways.
 */
function classify(tokens: Set<string>): State | null {
  const has = (...names: string[]) => names.some((name) => tokens.has(name));
  if (has("overflow-x-auto", "overflow-x-scroll")) return "scrolls";
  if (has("overflow-x-hidden", "overflow-x-clip")) return "clips";
  if (has("overflow-auto", "overflow-scroll")) return "scrolls";
  if (has("overflow-hidden", "overflow-clip")) return "clips";
  // Once overflow-y is auto, scroll or hidden, a visible overflow-x computes to auto.
  if (has("overflow-y-auto", "overflow-y-scroll", "overflow-y-hidden")) return "scrolls";
  return null;
}

/** The name of a function that is a component (capitalised), else null. */
function componentName(n: ts.Node): string | null {
  let name: string | undefined;
  if (ts.isFunctionDeclaration(n)) name = n.name?.text;
  else if (
    (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
    ts.isVariableDeclaration(n.parent) &&
    ts.isIdentifier(n.parent.name)
  ) {
    name = n.parent.name.text;
  }
  return name && /^[A-Z]/.test(name) ? name : null;
}

const NOT_FIXED_MIN_WIDTH = new Set(["min-w-0", "min-w-px", "min-w-auto", "min-w-full", "min-w-min", "min-w-fit"]);

/** A `min-w-*` class that sets a width of its own (`min-w-[560px]`, `min-w-96`), not `min-w-0` or `min-w-full`. */
function isFixedMinWidth(token: string): boolean {
  return token.startsWith("min-w-") && !NOT_FIXED_MIN_WIDTH.has(token);
}

const WORST: State[] = ["clips", "uncontained", "scrolls"];

function stateOf(
  node: ts.Node,
  sf: ts.SourceFile,
  contained: State,
  seen: ReadonlySet<string> = new Set(),
): State {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isJsxElement(n)) {
      if (tagOf(n.openingElement, sf) in CONTAINED) return contained;
      const state = classify(classTokens(n.openingElement));
      if (state) return state;
      continue;
    }
    // The top of a component declared here: follow its uses in this file.
    const name = componentName(n);
    if (name) {
      if (seen.has(name)) return "uncontained";
      const uses: ts.Node[] = [];
      const visit = (u: ts.Node): void => {
        const el = ts.isJsxElement(u)
          ? u.openingElement
          : ts.isJsxSelfClosingElement(u)
            ? u
            : null;
        if (el && tagOf(el, sf) === name) uses.push(u);
        ts.forEachChild(u, visit);
      };
      visit(sf);
      const states = uses.map((u) => stateOf(u, sf, contained, new Set([...seen, name])));
      return WORST.find((s) => states.includes(s)) ?? "uncontained";
    }
  }
  return "uncontained";
}

/**
 * Tables, CopyTables and fixed-width charts in one file, with what their
 * nearest overflow ancestor does. `contained` is the state of the table
 * inside CopyTable, which every `<CopyTable>` inherits.
 */
function scanSource(rel: string, text: string, contained: State): Found[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Found[] = [];
  const visit = (node: ts.Node): void => {
    const el = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (el) {
      const tag = tagOf(el, sf);
      const wide =
        tag === "table" ||
        tag in CONTAINED ||
        (tag === "svg" && [...classTokens(el)].some(isFixedMinWidth));
      if (wide) {
        found.push({
          rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          tag,
          state: tag in CONTAINED ? contained : stateOf(node, sf, contained),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

const copyTableRel = CONTAINED.CopyTable;
const copyTableOwn = scanSource(copyTableRel, read(copyTableRel), "uncontained").filter(
  (f) => f.tag === "table",
);
const copyTableState: State = copyTableOwn.length === 1 ? copyTableOwn[0].state : "uncontained";

const found: Found[] = ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).flatMap(
  (full) => {
    const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
    return scanSource(rel, readFileSync(full, "utf8"), copyTableState);
  },
);

const failing = found.filter((f) => f.state !== "scrolls");

function failingIn(rel: string): Found[] {
  return failing.filter((f) => f.rel === rel);
}

const FIX =
  'Wrap it in <div className="overflow-x-auto">, or change the wrapper\'s overflow-hidden to overflow-x-auto.';

describe("wide tables scroll sideways inside their own box", () => {
  it("finds the tables it is meant to check", () => {
    expect(found.some((f) => f.tag === "table")).toBe(true);
    expect(found.some((f) => f.tag === "CopyTable")).toBe(true);
  });

  it("has exactly one table inside CopyTable, and it scrolls", () => {
    expect(copyTableOwn.map((f) => f.state)).toEqual(["scrolls"]);
  });

  it("every table and fixed-width chart scrolls, apart from the listed exemptions", () => {
    const offenders = [...new Set(failing.map((f) => f.rel))].flatMap((rel) => {
      const tables = failingIn(rel);
      return EXEMPT[rel]?.tables === tables.length ? [] : tables;
    });
    expect(
      offenders.map((f) => `${f.rel}:${f.line} <${f.tag}> ${f.state}`),
      `\nThese would be cut off or widen the page on a narrow screen. ${FIX}\n` +
        `If an exemption already names the file, its table count no longer matches.\n`,
    ).toEqual([]);
  });

  it("has no stale exemption", () => {
    const stale = Object.entries(EXEMPT)
      .filter(([rel]) => existsSync(path.join(REPO_ROOT, rel)))
      .filter(([rel, { tables }]) => failingIn(rel).length !== tables)
      .map(([rel, { tables }]) => `${rel}: exempts ${tables}, found ${failingIn(rel).length}`);
    expect(stale, "\nUpdate or remove these EXEMPT entries.\n").toEqual([]);
  });

  it("gives every exemption a reason", () => {
    for (const [rel, { reason }] of Object.entries(EXEMPT)) {
      expect(reason.trim().length, rel).toBeGreaterThan(20);
    }
  });
});

describe("the table scan", () => {
  const stateIn = (jsx: string) => {
    const tables = scanSource("snippet.tsx", `const x = (${jsx});`, "scrolls").filter(
      (f) => f.tag !== "CopyTable",
    );
    expect(tables).toHaveLength(1);
    return tables[0].state;
  };

  it.each([
    ['<div className="overflow-x-auto"><table /></div>', "scrolls"],
    ['<div className="overflow-hidden rounded-lg"><table /></div>', "clips"],
    ['<div className="rounded-lg"><table /></div>', "uncontained"],
    ['<section>{rows.length > 0 && <table />}</section>', "uncontained"],
    ['<div className="md:overflow-x-auto"><table /></div>', "uncontained"],
    ['<div className="overflow-hidden overflow-x-auto"><table /></div>', "scrolls"],
    ['<div className="overflow-auto overflow-x-hidden"><table /></div>', "clips"],
    ['<div className="overflow-y-auto"><table /></div>', "scrolls"],
    ['<div className="overflow-auto"><div className="overflow-hidden"><table /></div></div>', "clips"],
    ['<div className={cn("rounded-lg", "overflow-x-auto")}><p /><table /></div>', "scrolls"],
    ['<div className={`mt-2 ${x} overflow-x-auto`}><table /></div>', "scrolls"],
    ['<div className="overflow-x-auto">{rows.map((r) => <div key={r}><table /></div>)}</div>', "scrolls"],
    ['<div className="overflow-x-auto"><svg className="w-full min-w-[560px]" /></div>', "scrolls"],
    ['<div><svg className="w-full min-w-[560px]" /></div>', "uncontained"],
  ])("%s → %s", (jsx, state) => {
    expect(stateIn(jsx)).toBe(state);
  });

  it.each([
    [
      "function Chart() { return <svg className='min-w-[560px]' />; }\n" +
        "const x = (<div className='overflow-x-auto'><Chart /></div>);",
      "scrolls",
    ],
    [
      "const Rows = () => (<table />);\nconst x = (<section><Rows /></section>);",
      "uncontained",
    ],
    [
      "function Rows() { return <table />; }\n" +
        "const x = (<div className='overflow-x-auto'><Rows /></div>);\n" +
        "const y = (<div className='overflow-hidden'><Rows /></div>);",
      "clips",
    ],
    ["export function Rows() { return <table />; }", "uncontained"],
  ])("follows a component declared in the same file to its uses: %s", (source, state) => {
    const tables = scanSource("snippet.tsx", source, "scrolls").filter(
      (f) => f.tag !== "Chart" && f.tag !== "Rows",
    );
    expect(tables.map((f) => f.state)).toEqual([state]);
  });

  it.each(["w-full", "w-full min-w-0", "min-w-full", "md:min-w-[560px]"])(
    "does not count an svg without a fixed minimum width: %s",
    (classes) => {
      expect(
        scanSource("snippet.tsx", `const x = (<div><svg className='${classes}' /></div>);`, "scrolls"),
      ).toEqual([]);
    },
  );

  it("gives a CopyTable the state of the table inside CopyTable", () => {
    const [copy] = scanSource("snippet.tsx", "const x = (<div><CopyTable rows={rows} /></div>);", "clips");
    expect(copy).toMatchObject({ tag: "CopyTable", state: "clips" });
  });
});

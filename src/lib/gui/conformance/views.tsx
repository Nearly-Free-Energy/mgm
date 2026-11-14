/**
 * The view checks (3 to 7, and the Shell-free part of 8). Each model is
 * rendered once per width, the way production picks its renderer, and crawled
 * once; checks 3, 4, 5, 6 and 8 all read that one pass. checkModel runs the
 * pass on any model, such as a view's own examples after withPoke().
 */
import { isDeepStrictEqual } from "node:util";
import { setViewportWidth } from "@/test/gui-setup";
import { GUI_CONTRACT, GUI_KINDS_SINCE, type ActionRef, type GuiPlugin, type Value, type ViewModel } from "../contract";
import { parseCaretRange, satisfiesContract } from "../host/shared/contract-range";
import { controlName, CONTROLS, crawl, enabled, type Reachable } from "./crawl";
import { WIDTHS, type CheckId, type Finding } from "./findings";
import { POKE_ACTION, POKE_LABEL, withPoke } from "./fixtures/acme";
import { MANIFEST_FIXTURES } from "./fixtures/manifests";
import { LATE_KIND_MODEL, MODEL_FIXTURES, SIGNALS, UNKNOWN_VALUE_MODEL, UNKNOWN_VALUE_TEXT } from "./fixtures/models";
import { controlIssues, holding, hostHrefs, linksOf, markedNear, pageText, refsOf, valuesOf } from "./inspect";
import { renderModel, renderShell, type Recorded } from "./harness";

type Report = (check: CheckId, message: string) => void;

/**
 * Whether the host would install the GUI at all (decision 7 on #115). A GUI
 * it would refuse is reported by check 1 alone; its views are not checked.
 */
function admits(gui: GuiPlugin): boolean {
  try {
    return satisfiesContract(GUI_CONTRACT, gui.contract);
  } catch {
    return false;
  }
}

/** A kind table in which LATE_KIND_MODEL's kind arrived just after the lowest version the GUI's range admits. */
function lateKinds(range: string) {
  const [major, minor, patch] = parseCaretRange(range).min;
  return { ...GUI_KINDS_SINCE, [LATE_KIND_MODEL.kind]: `${major}.${minor}.${patch + 1}` };
}

const PROPOSED = /proposed/i;
const sameRef = (a: ActionRef) => (b: ActionRef) => isDeepStrictEqual(a, b);

/** Check 6 on a crawl: every act passes one of `refs`, and every href reached is one the host handed out. */
export function exactRefsAndHrefs(reach: Reachable, refs: ActionRef[], allowed: Set<string>): string[] {
  const found: string[] = [];
  for (const { ref } of reach.acted) {
    if (!refs.some(sameRef(ref))) found.push(`called kit.act(${ref.action}) with a ref that is not in the model`);
  }
  for (const href of reach.hrefs) {
    if (!href.startsWith("#") && !allowed.has(href)) found.push(`links or navigates to ${href}, which the host did not hand out`);
  }
  return found;
}

/** Checks 3, 6 and 8 on what the first render shows, before anyone presses anything. */
function onMount(model: ViewModel, log: Recorded, report: Report): void {
  for (const ref of log.act) report("writes", `called kit.act(${ref.action}) without a person asking`);
  for (const message of controlIssues()) report("a11y", message);
  const text = pageText();
  const values = valuesOf(model);
  for (const value of values) {
    if (!value.text) continue;
    const found = holding(value.text);
    if (found.length === 0) {
      report("kinds", `does not show "${value.text}"`);
      continue;
    }
    // A mark beside another value is that value's, not this one's.
    const others = values.map((v) => v.text).filter((t) => t && !value.text.includes(t));
    if (value.synthetic && !found.some((el) => markedNear(el, /synthetic/i, others))) report("kinds", `does not mark "${value.text}" as synthetic`);
    if (value.derived && !found.some((el) => markedNear(el, /≈|derived|estimated/i, others))) report("kinds", `does not mark "${value.text}" as derived`);
  }
  if (model.notice && !text.includes(model.notice.text)) report("kinds", `does not show the notice "${model.notice.text}"`);
  if (model.kind === "collection") {
    const { columns, rows, totals, filters = [], empty } = model.body;
    if (rows.length === 0) {
      if (!text.includes(empty.title)) report("kinds", `does not show the empty state "${empty.title}"`);
      for (const f of filters) if (text.includes(f.label)) report("kinds", `shows the filter "${f.label}" with no rows`);
    }
    for (const column of columns.filter((c) => c.copy === "bare" && c.type === "money")) {
      const cells = rows.flatMap((row) => row.cells[column.key] ?? []);
      const currency = cells.find((v): v is Extract<Value, { t: "money" }> => v.t === "money")?.currency;
      if (!currency) continue;
      if (!holding(column.label).some((el) => el.textContent?.includes(currency))) {
        report("kinds", `does not name ${currency} in the header of the bare column "${column.label}"`);
      }
      for (const cell of cells) {
        const holders = holding(cell.text).map((el) => el.closest('td, th, [role="cell"], [role="gridcell"]') ?? el.parentElement);
        if (holders.some((el) => el?.textContent?.includes(currency))) report("kinds", `prints ${currency} in the bare cell "${cell.text}"`);
      }
    }
    const rowValues = valuesOf(rows);
    for (const total of totals ? Object.values(totals) : []) {
      const last = holding(total.text).at(-1);
      const before = rowValues.find((v) => {
        const first = holding(v.text)[0];
        return last && first && !(first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (before) report("kinds", `shows the total "${total.text}" before the row value "${before.text}"`);
    }
  }
  for (const ref of refsOf(model).filter((r) => !r.enabled)) {
    if (ref.reason && !text.includes(ref.reason)) report("writes", `does not show why "${ref.label}" is unavailable`);
    const offered = [...document.body.querySelectorAll(CONTROLS)].some((el) => enabled(el) && controlName(el).includes(ref.label));
    if (offered) report("writes", `offers "${ref.label}" as an enabled control while it is disabled`);
  }
}

/** Checks 3 to 6 on what the crawl reached. */
function afterCrawl(model: ViewModel, reach: Reachable, log: Recorded, report: Report): void {
  for (const value of valuesOf(model)) {
    if (value.t === "ref" && value.ref.href && !reach.hrefs.has(value.ref.href)) report("kinds", `does not link "${value.text}" to ${value.ref.href}`);
  }
  for (const link of linksOf(model)) {
    if (!reach.hrefs.has(link.href) && !log.open.some((l) => isDeepStrictEqual(l, link))) {
      report("kinds", `does not offer the link "${link.label}" (${link.href})`);
    }
  }
  if (model.kind === "collection" && model.body.rows.length === 0 && model.body.empty.action?.enabled) {
    const action = model.body.empty.action;
    if (!reach.acted.some((a) => isDeepStrictEqual(a.ref, action))) report("kinds", `does not offer the empty state's action "${action.label}"`);
  }
  const refs = refsOf(model);
  for (const ref of refs) {
    const hits = reach.acted.filter((a) => isDeepStrictEqual(a.ref, ref));
    if (ref.action === POKE_ACTION && !hits.some((a) => a.name.includes(POKE_LABEL))) {
      report("targeted", `has no control named "${POKE_LABEL}" that acts on ${Object.values(ref.params).join(", ")}`);
    }
    if (ref.provenance && ref.enabled) {
      if (hits.length === 0) report("proposals", `offers no control for the proposed action "${ref.label}"`);
      else if (!hits.every((a) => PROPOSED.test(`${a.name} ${a.description}`))) report("proposals", `does not mark "${ref.label}" as proposed`);
    }
  }
  const disabled = refs.filter((r) => !r.enabled);
  for (const { ref } of reach.acted) {
    if (disabled.some((d) => d.action === ref.action && isDeepStrictEqual(d.params, ref.params))) {
      report("writes", `called kit.act(${ref.action}) on a disabled action`);
    }
  }
  for (const message of exactRefsAndHrefs(reach, refs, hostHrefs(MANIFEST_FIXTURES[0], model))) report("writes", message);
}

/** Every model check on one model, at each width. */
export async function checkModel(gui: GuiPlugin, model: ViewModel, fixture: string): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const width of WIDTHS) {
    setViewportWidth(width);
    const report: Report = (check, message) => found.push({ check, fixture: `${fixture} at ${width} px`, message });
    const { log, unmount } = await renderModel(gui, model);
    try {
      onMount(model, log, report);
      afterCrawl(model, await crawl(log), log, report);
    } finally {
      unmount();
    }
  }
  return found;
}

const passes = new WeakMap<GuiPlugin, Promise<Finding[]>>();

/** The model checks over every fixture after withPoke(); run once per GUI and shared by checks 3 to 6. */
export function modelFindings(gui: GuiPlugin): Promise<Finding[]> {
  let pass = passes.get(gui);
  if (!pass) {
    pass = (async () => {
      const found: Finding[] = [];
      if (!admits(gui)) return found;
      for (const { name, model } of MODEL_FIXTURES) found.push(...(await checkModel(gui, withPoke(model), name)));
      return found;
    })();
    passes.set(gui, pass);
  }
  return pass;
}

const signalPasses = new WeakMap<GuiPlugin, Promise<Finding[]>>();

/**
 * The Shell given SIGNALS, once per GUI. Check 2: the Needs-you count shows.
 * Check 5: the your-move step is reachable and pressing it acts on nothing;
 * the proposal is reachable as a link to its page or as a control, and a
 * control says "proposed"; nothing acts on a ref no signal carries.
 */
export function signalFindings(gui: GuiPlugin): Promise<Finding[]> {
  let pass = signalPasses.get(gui);
  if (!pass) {
    pass = signalPass(gui);
    signalPasses.set(gui, pass);
  }
  return pass;
}

async function signalPass(gui: GuiPlugin): Promise<Finding[]> {
  const found: Finding[] = [];
  const fixture = { ...MANIFEST_FIXTURES[0], name: "signals", signals: SIGNALS };
  const proposals = SIGNALS.top.flatMap((s) => (s.kind === "proposal" ? [s] : []));
  const count = String(SIGNALS.count);
  for (const width of WIDTHS) {
    setViewportWidth(width);
    const at = `signals at ${width} px`;
    const report = (message: string, check: CheckId = "proposals") => found.push({ check, fixture: at, message });
    const { log, unmount } = await renderShell(gui, fixture, <p>Signals page</p>);
    try {
      const labels = [...document.body.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") ?? "");
      if (!pageText().includes(count) && !labels.some((l) => l.includes(count))) report(`does not show the Needs-you count (${count})`, "manifests");
      const reach = await crawl(log);
      for (const signal of SIGNALS.top) {
        if (signal.kind !== "your-move") continue;
        if (!reach.hrefs.has(signal.href)) report(`does not link to the step "${signal.title}" (${signal.href})`);
        if (reach.acted.some((a) => a.name.includes(signal.title))) report(`calls kit.act from the your-move step "${signal.title}"`);
      }
      for (const signal of proposals) {
        const hits = reach.acted.filter((a) => isDeepStrictEqual(a.ref, signal.action));
        // A Shell may list the proposal as a link to where it is decided, or act on it in place; acting in place must say "proposed".
        if (hits.length === 0 && !reach.hrefs.has(signal.href)) report(`offers neither a link nor a control for the proposal "${signal.title}"`);
        else if (!hits.every((a) => PROPOSED.test(`${a.name} ${a.description}`))) report(`does not mark the proposal "${signal.title}" as proposed`);
      }
      for (const { ref } of reach.acted) {
        if (!proposals.some((s) => isDeepStrictEqual(s.action, ref))) report(`called kit.act(${ref.action}), which no signal carries`);
      }
    } finally {
      unmount();
    }
  }
  return found;
}

/**
 * Check 7: a kind past the GUI's range falls back to RawView, and a value of
 * unknown type prints its text. LATE_KIND_MODEL has no `ext`, so pickRenderer
 * never hands it to the GUI: the first half confirms the host's fallback
 * reaches the page for the GUI's range, and no View can fail it.
 */
export async function unknownFindings(gui: GuiPlugin): Promise<Finding[]> {
  const found: Finding[] = [];
  if (!admits(gui)) return found;
  const kindsSince = lateKinds(gui.contract);
  for (const width of WIDTHS) {
    setViewportWidth(width);
    const report = (fixture: string, message: string) => found.push({ check: "unknowns", fixture: `${fixture} at ${width} px`, message });
    const late = await renderModel(gui, LATE_KIND_MODEL, kindsSince);
    if (!document.body.querySelector("[data-gui-raw]")) report("late kind", "does not fall back to the host's RawView for a kind its range does not cover");
    late.unmount();
    const unknown = await renderModel(gui, UNKNOWN_VALUE_MODEL);
    if (!pageText().includes(UNKNOWN_VALUE_TEXT)) report("unknown value", `does not print "${UNKNOWN_VALUE_TEXT}", a value of a type it does not know`);
    unknown.unmount();
  }
  return found;
}

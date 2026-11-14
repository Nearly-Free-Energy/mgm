/**
 * Each check fails a GUI broken in the way it guards, and no other check
 * does, so a check that cannot fail is caught here.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { ActionRef, GuiMeta, GuiPlugin, OverlayProps, ViewModel, ViewProps } from "../../contract";
import { kit, Overlay } from "../../kit";
import { CHECKS, type CheckId, type CheckOptions, type Finding } from "../checks";
import { CHECK_TIMEOUT_MS, registerConformance } from "../describe";
import { refsOf } from "../inspect";
import { REFERENCE_META, referenceGui } from "./reference-gui";

async function findings(gui: GuiPlugin): Promise<Finding[]> {
  // Installed as declared, so a bad range is the only finding of its case.
  const installed = { reference: { ...REFERENCE_META, contract: gui.contract } };
  const all: Finding[] = [];
  for (const check of Object.values(CHECKS)) all.push(...(await check(gui, { installed })));
  return all;
}

const withView = (View: GuiPlugin["View"]): GuiPlugin => ({ ...referenceGui(), View });

function ActsInEffect({ model }: ViewProps) {
  useEffect(() => void kit.act(model.actions[0]), [model]);
  return <kit.KitView model={model} />;
}
function ActsInLayoutEffect({ model }: ViewProps) {
  useLayoutEffect(() => void kit.act(model.actions[0]), [model]);
  return <kit.KitView model={model} />;
}
function ActsInRender({ model }: ViewProps) {
  void kit.act(model.actions[0]);
  return <kit.KitView model={model} />;
}
function ActsLater({ model }: ViewProps) {
  useEffect(() => {
    // Two timers deep, past the one act() itself waits for.
    let inner: ReturnType<typeof setTimeout> | undefined;
    const outer = setTimeout(() => {
      inner = setTimeout(() => void kit.act(model.actions[0]), 0);
    }, 0);
    return () => {
      clearTimeout(outer);
      clearTimeout(inner);
    };
  }, [model]);
  return <kit.KitView model={model} />;
}

/** A View that draws a changed copy of each model. */
function drawing(change: (model: ViewModel) => ViewModel) {
  return function Changed({ model }: ViewProps) {
    const shown = useMemo(() => change(model), [model]);
    return <kit.KitView model={shown} />;
  };
}
const mapActions = (model: ViewModel, f: (refs: ActionRef[]) => ActionRef[]): ViewModel =>
  model.kind === "collection"
    ? { ...model, actions: f(model.actions), body: { ...model.body, rows: model.body.rows.map((r) => ({ ...r, actions: f(r.actions) })) } }
    : { ...model, actions: f(model.actions) };

const isRef = (v: unknown): v is ActionRef => typeof v === "object" && v !== null && "action" in v && "enabled" in v;
/** The model with every ref `pick` matches taken out, wherever it sits. */
const withoutRefs = (model: ViewModel, pick: (ref: ActionRef) => boolean): ViewModel =>
  JSON.parse(JSON.stringify(model, (_, v) => (Array.isArray(v) ? v.filter((x) => !(isRef(x) && pick(x))) : isRef(v) && pick(v) ? undefined : v)));
/** A View that draws the refs `pick` matches with its own control, acting with the exact ref. */
function replacing(pick: (ref: ActionRef) => boolean, Control: (props: { actionRef: ActionRef }) => ReactNode) {
  return function Replaced({ model }: ViewProps) {
    const shown = useMemo(() => withoutRefs(model, pick), [model]);
    return (
      <>
        <kit.KitView model={shown} />
        {refsOf(model).filter(pick).map((ref, i) => <Control key={i} actionRef={ref} />)}
      </>
    );
  };
}
/** A View that adds `extra` to the models of one kind only, so the Shell's page stays clean. */
function addingTo(kind: ViewModel["kind"], Extra: (props: { model: ViewModel }) => ReactNode) {
  return function Added({ model }: ViewProps) {
    return (
      <>
        <kit.KitView model={model} />
        {model.kind === kind && <Extra model={model} />}
      </>
    );
  };
}
const atZeroRows = (change: (body: Extract<ViewModel, { kind: "collection" }>["body"]) => object) =>
  drawing((m) => (m.kind === "collection" && m.body.rows.length === 0 ? ({ ...m, body: { ...m.body, ...change(m.body) } } as ViewModel) : m));
const stripKey = (key: string) => drawing((m) => JSON.parse(JSON.stringify(m, (k, v) => (k === key ? undefined : v))));

/**
 * A View that draws a record's `flag` values as one plain list whose cells
 * hold their text directly, marking the first of them only; the kit draws
 * the rest of the model.
 */
function marksFirstOnly(flag: "derived" | "synthetic", mark: (text: string) => string) {
  return function MarksFirst({ model }: ViewProps) {
    if (model.kind !== "record") return <kit.KitView model={model} />;
    const flagged = model.body.sections.flatMap((s) => s.fields.filter((f) => f.value[flag]));
    const rest = { ...model, body: { sections: model.body.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => !f.value[flag]) })) } };
    return (
      <>
        <kit.KitView model={rest} />
        <dl>
          {flagged.map((f, i) => (
            <Fragment key={f.key}>
              <dt>{f.label}</dt>
              <dd>{i === 0 ? mark(f.value.text) : f.value.text}</dd>
            </Fragment>
          ))}
        </dl>
      </>
    );
  };
}

const DropsLowPriority = drawing((m) =>
  m.kind === "collection" ? { ...m, body: { ...m.body, columns: m.body.columns.filter((c) => c.priority !== 3) } } : m,
);
function DropsLowPriorityWhenWide({ model }: ViewProps) {
  const shown = useMemo(
    () => (model.kind === "collection" && window.innerWidth >= 800 ? { ...model, body: { ...model.body, columns: model.body.columns.filter((c) => c.priority !== 3) } } : model),
    [model],
  );
  return <kit.KitView model={shown} />;
}
const ChangesParams = drawing((m) =>
  mapActions(m, (refs) => refs.map((r) => (r.from || !r.enabled ? r : { ...r, params: { ...r.params, id: "other" } }))),
);
const ChangesCollectionParams = drawing((m) =>
  m.kind === "collection" ? { ...m, actions: m.actions.map((r) => (r.from ? r : { ...r, params: { ...r.params, microgrid_id: "other" } })) } : m,
);
/** Draws a disabled ref as an enabled button with its reason, acting with the unchanged ref. */
const EnablesDisabled = replacing(
  (r) => !r.enabled,
  ({ actionRef }) => (
    <p>
      <button type="button" onClick={() => void kit.act(actionRef)}>{actionRef.label}</button> {actionRef.reason}
    </p>
  ),
);
const DropsReason = drawing((m) => mapActions(m, (refs) => refs.map((r) => (r.enabled ? r : { ...r, reason: undefined }))));
const PokeNamedOtherwise = replacing(
  (r) => !!r.from,
  ({ actionRef }) => <button type="button" onClick={() => void kit.act(actionRef)}>Do it</button>,
);
const ProposalUnmarked = replacing(
  (r) => !!r.provenance,
  ({ actionRef }) => <button type="button" onClick={() => void kit.act(actionRef)}>{actionRef.label}</button>,
);
const EmptyWithoutTitle = atZeroRows((b) => ({ empty: { ...b.empty, title: "" } }));
const EmptyWithoutAction = atZeroRows((b) => ({ empty: { ...b.empty, action: undefined } }));
const FiltersAtZeroRows = atZeroRows((b) => ({ filters: b.filters?.map((f) => ({ ...f, count: 1 })) }));
const BareHeaderUnnamed = drawing((m) =>
  m.kind === "collection" ? { ...m, body: { ...m.body, columns: m.body.columns.map((c) => (c.copy === "bare" ? { ...c, label: "Owed" } : c)) } } : m,
);
const TotalsFirst = drawing((m) =>
  m.kind === "collection" && m.body.totals
    ? { ...m, body: { ...m.body, totals: undefined, rows: [{ id: "totals", cells: m.body.totals, actions: [] }, ...m.body.rows] } }
    : m,
);
const RefUnlinked = drawing((m) =>
  JSON.parse(JSON.stringify(m, (_, v) => (v && v.t === "ref" ? { ...v, ref: { ...v.ref, href: undefined } } : v))),
);
const LinksOut = addingTo("feed", () => <kit.Link href="/reports">Reports</kit.Link>);
const UnnamedRowButton = addingTo("collection", () => <button type="button" />);
function ActsOnFeed({ model }: ViewProps) {
  useEffect(() => void (model.kind === "feed" && kit.act(model.actions[0])), [model]);
  return <kit.KitView model={model} />;
}
function ActsOnFeedInLayoutEffect({ model }: ViewProps) {
  useLayoutEffect(() => void (model.kind === "feed" && kit.act(model.actions[0])), [model]);
  return <kit.KitView model={model} />;
}
function ActsOnFeedInRender({ model }: ViewProps) {
  if (model.kind === "feed") void kit.act(model.actions[0]);
  return <kit.KitView model={model} />;
}
const DropsTargeted = drawing((m) => mapActions(m, (refs) => refs.filter((r) => !r.from)));
const PrintsCurrencyInBareCells = drawing((m) =>
  m.kind === "collection"
    ? { ...m, body: { ...m.body, rows: m.body.rows.map((r) => ({ ...r, cells: { ...r.cells, owed: { ...r.cells.owed, text: `UGX ${r.cells.owed.text}` } } })) } }
    : m,
);
const DropsNotice = drawing((m) => ({ ...m, notice: undefined }));
const DropsConfirmStep = (p: OverlayProps) => <Overlay {...p}>{p.role === "confirm" ? null : p.children}</Overlay>;
const OutsideOverlay = (p: OverlayProps) => (
  <>
    <Overlay {...p}>{null}</Overlay>
    {p.children}
  </>
);
const DropsLinks = drawing((m) => ({ ...m, links: [] }));
const KNOWN_TYPES = new Set(["text", "empty", "number", "percent", "money", "energy", "power", "date", "datetime", "status", "ref"]);
const DropsUnknown = drawing((m) =>
  m.kind === "record"
    ? { ...m, body: { sections: m.body.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => KNOWN_TYPES.has(f.value.t)) })) } }
    : m,
);

/**
 * Each of these acts on its model's first action: Rename on the Shell's page,
 * and on the view fixtures their own first action, the disabled one included.
 */
const ACTS_UNASKED = /^called kit\.act\([\w.-]+\) (without a person asking|on a disabled action)$/;

const withOverlay = (frame: GuiPlugin["Overlay"]): GuiPlugin => ({ ...referenceGui(), Overlay: frame });

/**
 * The check, what is broken, the GUI, and what its findings say: a pattern
 * every finding matches, or patterns each matched by some finding and
 * together covering all; and optionally a pattern every finding's fixture
 * matches.
 */
type Case = [CheckId, string, GuiPlugin, RegExp | RegExp[], RegExp?];

const BROKEN: Case[] = [
  ["version", "declares a contract range that leaves this version out", { ...referenceGui(), contract: "^0.2" }, /does not admit/],
  ["version", "declares a range the host cannot read", { ...referenceGui(), contract: ">=0.1" }, /does not admit/],
  ["version", "is not installed", { ...referenceGui(), name: "absent" }, /not in the installed GUI metadata/],
  ["manifests", "leaves out a nav entry", referenceGui({ dropNav: "community.communities" }), /nav entry community\.communities/],
  ["manifests", "offers no place for an entry that needs one", referenceGui({ noChoices: true }), /for (First|Second) site/],
  ["manifests", "shows nothing for an entry with no place", referenceGui({ noPlaceControl: true }), /no control named "(Operations|Billing)"/],
  ["manifests", "leaves out the status items", referenceGui({ noStatus: true }), /status item community\.setup/],
  ["manifests", "leaves out the organization switcher", referenceGui({ noOrgSwitch: true }), /organization Second organization/],
  ["manifests", "does not show an unknown entry's title", referenceGui({ hideUnknownTitle: true }), /does not show "Tickets"/],
  ["manifests", "has no sign-out", referenceGui({ noSignOut: true }), /kit\.SignOut/],
  ["writes", "acts in an effect", withView(ActsInEffect), ACTS_UNASKED],
  ["writes", "acts in a layout effect", withView(ActsInLayoutEffect), ACTS_UNASKED],
  ["writes", "acts while it renders", withView(ActsInRender), ACTS_UNASKED],
  ["writes", "acts after a timer", withView(ActsLater), ACTS_UNASKED],
  ["a11y", "has no main landmark", referenceGui({ noMain: true }), /0 main landmarks/],
  ["a11y", "has two main landmarks", referenceGui({ twoMains: true }), /2 main landmarks/],
  ["a11y", "has no navigation landmark", referenceGui({ noNav: true }), /no navigation landmark/],
  ["a11y", "has a button without a name", referenceGui({ unnamedButton: true }), /1 button element\(s\) without an accessible name/],
  ["a11y", "sets a positive tabindex", referenceGui({ positiveTabIndex: true }), /tabindex="1"/],
  ["a11y", "gives a tab an href", referenceGui({ tabWithHref: true }), /role="tab"/],
  ["a11y", "does not mark the current page", referenceGui({ noCurrent: true }), /without aria-current/],
  ["kinds", "drops the priority-3 column", withView(DropsLowPriority), /does not show "Meter [ABC]\d\d"/],
  ["kinds", "leaves out the synthetic marks", withView(stripKey("synthetic")), [/^does not mark "1\.4 kW" as synthetic$/, /^does not mark "2\.6 kWh" as synthetic$/, /^does not mark "12\.3 kWh" as synthetic$/]],
  ["kinds", "leaves out the derived marks", withView(stripKey("derived")), [/^does not mark "12\.5 %" as derived$/, /^does not mark "41\.2 kWh" as derived$/]],
  ["kinds", "marks one synthetic value and not its neighbour", withView(marksFirstOnly("synthetic", (t) => `${t} Synthetic`)), /^does not mark "2\.6 kWh" as synthetic$/, /^record of every value/],
  ["kinds", "marks one derived value and not its neighbour", withView(marksFirstOnly("derived", (t) => `≈ ${t}`)), /^does not mark "41\.2 kWh" as derived$/, /^record of every value/],
  ["kinds", "leaves out the empty state's title", withView(EmptyWithoutTitle), /^does not show the empty state "No households yet"$/, /^collection with no rows/],
  ["kinds", "leaves out the empty state's action", withView(EmptyWithoutAction), /^does not offer the empty state's action "Add household"$/, /^collection with no rows/],
  ["kinds", "shows the filters with no rows", withView(FiltersAtZeroRows), [/^shows the filter "Every household" with no rows$/, /^shows the filter "Owing only" with no rows$/], /^collection with no rows/],
  ["kinds", "does not name the currency in a bare column's header", withView(BareHeaderUnnamed), /^does not name UGX in the header of the bare column "Owed \(UGX\)"$/],
  ["kinds", "shows the totals above the rows", withView(TotalsFirst), /^shows the total "(5,639,300|67\.7 kWh)" before the row value/, /^collection at/],
  ["kinds", "does not link a ref value", withView(RefUnlinked), /^does not link "Main grid site" to \/microgrids\//, /^record of every value/],
  ["kinds", "prints the currency in a bare column's cells", withView(PrintsCurrencyInBareCells), /prints UGX in the bare cell/],
  ["kinds", "leaves out the notice", withView(DropsNotice), /does not show the notice/],
  ["kinds", "leaves out the model's links", withView(DropsLinks), /does not offer the link/],
  ["targeted", "leaves out other plugins' actions", withView(DropsTargeted), /no control named "Poke · Acme"/],
  ["targeted", "names other plugins' actions otherwise", withView(PokeNamedOtherwise), /^has no control named "Poke · Acme"/],
  ["proposals", "draws a proposal signal like any other action", referenceGui({ unmarkedProposal: true }), /does not mark the proposal/],
  ["proposals", "draws a proposed action like any other", withView(ProposalUnmarked), /^does not mark "Send reminders" as proposed$/, /^flow with a proposal/],
  ["proposals", "draws a your-move signal as text", referenceGui({ yourMoveText: true }), /^does not link to the step "Readings due"/],
  ["proposals", "acts from a your-move signal", referenceGui({ yourMoveActs: true }), [/^calls kit\.act from the your-move step "Readings due"$/, /which no signal carries$/]],
  ["proposals", "leaves out the proposal signal", referenceGui({ dropProposal: true }), /^offers neither a link nor a control for the proposal "Remind two households"$/],
  ["proposals", "links to a proposal and also acts on it unmarked", referenceGui({ proposalLinkAndUnmarked: true }), /^does not mark the proposal "Remind two households" as proposed$/],
  ["proposals", "acts on a ref no signal carries", referenceGui({ actsOffSignal: true }), /^called kit\.act\(community\.rename\), which no signal carries$/],
  ["manifests", "leaves out the Needs-you count", referenceGui({ noCount: true }), /^does not show the Needs-you count \(7\)$/, /^signals at/],
  ["writes", "acts with a copy of a ref whose params it changed", withView(ChangesParams), /with a ref that is not in the model/],
  ["writes", "changes the params of a ref only on a view's own page", withView(ChangesCollectionParams), /^called kit\.act\(community\.add-household\) with a ref that is not in the model$/, /^collection at/],
  ["writes", "acts in the Shell with a ref the page never sent", referenceGui({ forgedAct: true }), /^called kit\.act\(community\.rename\) with a ref that is not in the model$/, /^(one-org|two-orgs|billing-off|empty-org|unknown-plugin|legacy-nav|missing-context) at/],
  ["writes", "draws a disabled action as an enabled button", withView(EnablesDisabled), [/^offers "Close period" as an enabled control while it is disabled$/, /^called kit\.act\(billing\.close-period\) on a disabled action$/]],
  ["writes", "leaves out a disabled action's reason", withView(DropsReason), /^does not show why "Close period" is unavailable$/],
  ["writes", "navigates to a path the host never handed out", referenceGui({ hardCodedHref: true }), /navigates to \/reports,/],
  ["writes", "opens a link the host never handed out", referenceGui({ openedHref: true }), /navigates to \/reports,/],
  ["writes", "links a view to a path the host never handed out", withView(LinksOut), /^links or navigates to \/reports,/, /^feed at/],
  ["writes", "acts on mount in one view only", withView(ActsOnFeed), /^called kit\.act\(acme\.poke\) without a person asking$/, /^feed at/],
  ["writes", "acts in a layout effect in one view only", withView(ActsOnFeedInLayoutEffect), /^called kit\.act\(acme\.poke\) without a person asking$/, /^feed at/],
  ["writes", "acts while it renders in one view only", withView(ActsOnFeedInRender), /^called kit\.act\(acme\.poke\) without a person asking$/, /^feed at/],
  ["a11y", "has an unnamed button in a view", withView(UnnamedRowButton), /^has 1 button element\(s\) without an accessible name$/, /^collection/],
  ["unknowns", "prints nothing for a value of unknown type", withView(DropsUnknown), /Gauge at 42 of 100/],
  ["frames", "has an Overlay that leaves out the host's step", referenceGui({ overlayDropsStep: true }), /host's/],
  ["frames", "has an Overlay that never calls onDismiss", withOverlay((p) => <Overlay {...p} onDismiss={() => {}} />), /onDismiss/],
  ["frames", "has an Overlay that does not name its dialog", withOverlay((p) => <Overlay {...p} title="" />), /no dialog named/],
  ["frames", "has a PublicFrame without a main landmark", referenceGui({ publicNoMain: true }), /no main landmark/],
  ["frames", "has an Overlay that leaves out the confirm step only", withOverlay(DropsConfirmStep), /host's/, /^Overlay, confirm/],
  ["frames", "has an Overlay that shows the host's step outside its dialog", withOverlay(OutsideOverlay), [/step inside the dialog$/, /^does not hold the host's/]],
  ["frames", "has a PublicFrame that leaves out its children", referenceGui({ publicNoChildren: true }), /^does not render its children$/],
  ["frames", "has a Loading that throws", referenceGui({ loadingThrows: true }), /^throws while rendering: Loading failed$/, /^Loading/],
];

describe("each check fails a GUI broken in the way it guards", () => {
  it.each(BROKEN)("%s: a GUI that %s", async (check, _, gui, expected, fixture) => {
    const found = await findings(gui);
    expect([...new Set(found.map((f) => f.check))]).toEqual([check]);
    const patterns = [expected].flat();
    for (const f of found) expect(patterns.some((p) => p.test(f.message)), f.message).toBe(true);
    for (const p of patterns) expect(found.some((f) => p.test(f.message)), String(p)).toBe(true);
    if (fixture) for (const f of found) expect(f.fixture).toMatch(fixture);
  });

  it("kinds: a View that drops priority-3 text at 800 px and wider, at those widths", async () => {
    const found = await findings(withView(DropsLowPriorityWhenWide));
    expect(new Set(found.map((f) => f.check))).toEqual(new Set(["kinds"]));
    const widths = new Set(found.map((f) => f.fixture.replace(/^.* at (\d+) px$/, "$1")));
    expect(widths).toEqual(new Set(["800", "1366"]));
  });

  it("manifests: a GUI that drops status items at one width only, at that width", async () => {
    const found = await findings(referenceGui({ narrowNoStatus: true }));
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(`${f.check} ${f.fixture} ${f.message}`).toMatch(/^manifests .* at 360 px status item/);
  });

  it.each([["name", "other"], ["title", "Other"], ["version", "0.0.1"], ["contract", "^0.1.0"], ["styles", "./other.css"], ["dependencies", ["x"]]] as const)(
    "version: a GUI whose %s differs from its installed entry",
    async (key, value) => {
      const gui = { ...referenceGui(), [key]: value } as GuiPlugin;
      const installed: Record<string, GuiMeta> = { [gui.name]: REFERENCE_META };
      expect((await CHECKS.version(gui, { installed })).map((f) => f.message)).toEqual([
        "differs from its installed metadata (src/gui/meta.ts)",
      ]);
    },
  );

  it("passes the reference GUI with no findings", async () => {
    expect(await findings(referenceGui())).toEqual([]);
  });

  it("proposals: accepts a proposal listed as a link to its page", async () => {
    expect(await CHECKS.proposals(referenceGui({ proposalAsLink: true }), {})).toEqual([]);
  });
});

describe("describeGuiConformance", () => {
  /** The cases registerConformance (what describeGuiConformance calls) registers. */
  function cases(gui: GuiPlugin, options: CheckOptions) {
    const found: { name: string; run: () => Promise<void>; timeout?: number }[] = [];
    registerConformance(gui, options, { describe: (_, body) => body(), it: (name, run, timeout) => void found.push({ name, run, timeout }) });
    return found;
  }
  const installed = { reference: REFERENCE_META };

  it("registers one case per check, and fails the case of the broken check only", async () => {
    const registered = cases(referenceGui({ noMain: true }), { installed });
    expect(registered.map((c) => c.name)).toEqual(Object.keys(CHECKS));
    expect(registered.every((c) => c.timeout === CHECK_TIMEOUT_MS)).toBe(true);
    for (const { name, run } of registered) {
      if (name === "a11y") await expect(run()).rejects.toThrow(/0 main landmarks/);
      else await expect(run()).resolves.toBeUndefined();
    }
  });

  it("checks against GUI_META when no table is given", async () => {
    const [version] = cases(referenceGui(), {});
    await expect(version.run()).rejects.toThrow(/not in the installed GUI metadata/);
  });
});

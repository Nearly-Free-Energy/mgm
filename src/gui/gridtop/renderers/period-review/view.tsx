"use client";

/**
 * Gridtop's drawing of `billing.period-review@1`, one billing period's
 * bills: the host's notice, the period's own actions and links, then the
 * bills as a copy table from 600 px up and as cards below it, and the
 * totals under both. At zero rows the empty state owns its action, so the
 * toolbar leaves that action out. The window bar leaves the period's
 * controls to this view (PLACE_PAGE_CONTROLS in ../index.ts). It prints the
 * text the server formatted, copies the ext's figures, and writes only
 * through kit.act. What an action answered is shown under the control that
 * ran it: a failure, or the message its route gave with a success. A model whose ext it cannot read is drawn by the kit's
 * view instead.
 *
 * Loaded on demand by ./index.tsx, which hands it the kit. These files
 * import nothing else of Gridtop's or the kit's, so this chunk shares no
 * module with the shell's: a shared one makes the bundler split the shell's
 * chunks again (about 650 first-load bytes when measured for the site-day
 * renderer). If a shared import is added, measure the budgets again.
 */
import { useCallback, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { GuiKit, ModelOf, SyncNode, ViewProps } from "@/lib/gui/contract";
import { BillCards } from "./cards";
import { ActionControl, ControlList, OutcomeLine, TONE, type ActionOutcome } from "./controls";
import { useCopier } from "./copy";
import { CopyTable } from "./copy-table";
import { cls, readPeriodReviewExt } from "./ext";
import { Totals } from "./totals";

type Props = ViewProps & { kit: GuiKit };

/** Appended to an announcement that repeats the last one. */
export const REPEAT = "\u00a0";

type Speaker = { say(message: string): void };

/**
 * The live region, with its own state, so an announcement (each move of the
 * table's cursor) redraws this paragraph rather than the bills.
 */
function LiveRegion({ speaker }: { speaker: Ref<Speaker> }) {
  const [said, setSaid] = useState("");
  // A message equal to the last one would leave the live region unchanged,
  // and a screen reader silent, so a repeat alternates a trailing no-break
  // space, which changes the text without changing what is read.
  useImperativeHandle(speaker, () => ({ say: (message) => setSaid((last) => (last === message ? `${message}${REPEAT}` : message)) }), []);
  return (
    <p aria-live="polite" className="gt:sr-only">
      {said}
    </p>
  );
}

/** The empty state, which owns the action it offers; the review keeps that action's outcome. */
function Empty({
  empty,
  kit,
  outcome,
  onOutcome,
}: {
  empty: ModelOf<"collection">["body"]["empty"];
  kit: GuiKit;
  outcome: ActionOutcome;
  onOutcome(outcome: ActionOutcome): void;
}) {
  return (
    <section className="gt:flex gt:flex-col gt:items-center gt:gap-3 gt:rounded-lg gt:border gt:border-dashed gt:border-border gt:bg-card gt:px-6 gt:py-10 gt:text-center">
      <h2 className="gt:text-title gt:font-semibold gt:text-foreground">{empty.title}</h2>
      {empty.text && <p className="gt:max-w-prose gt:text-body gt:text-muted-foreground">{empty.text}</p>}
      {empty.action && <ActionControl actionRef={empty.action} onResult={onOutcome} kit={kit} />}
      <OutcomeLine outcome={outcome} />
    </section>
  );
}

/** The period, drawn from the model the live refresh last returned. */
function Review({ model, kit }: { model: ModelOf<"collection">; kit: GuiKit }) {
  const live = kit.useLive(model);
  const m = live.model;
  const speaker = useRef<Speaker>(null);
  const announce = useCallback((message: string) => speaker.current?.say(message), []);
  const copier = useCopier(announce);
  // Read once per model, not on every redraw: at the caps it checks 22,000 figures.
  const figures = useMemo(() => readPeriodReviewExt(m), [m]);
  // The outcome of the period's own last action, and where it was pressed.
  // Kept here, not in the control, so it outlives the refresh that follows
  // a success: a generation pressed in the empty state brings bills, the
  // empty state goes, and its message moves under the period's controls.
  const [period, setPeriod] = useState<{ outcome: ActionOutcome; from: "controls" | "empty" }>({ outcome: null, from: "controls" });
  const fromControls = useCallback((outcome: ActionOutcome) => setPeriod({ outcome, from: "controls" }), []);
  const fromEmpty = useCallback((outcome: ActionOutcome) => setPeriod({ outcome, from: "empty" }), []);
  // A refresh that brings figures this renderer cannot read: the kit's view
  // draws that model, without polling again, since this one still does.
  if (!figures || m.kind !== "collection") return <kit.KitView model={{ ...m, live: undefined }} />;
  const { rows, empty, next } = m.body;
  const zero = rows.length === 0;
  // At zero rows the empty state owns its action (CLAUDE.md design rule 6).
  const actions = zero && empty.action ? m.actions.filter((a) => a.action !== empty.action!.action) : m.actions;
  return (
    // Views attached as sections are drawn below the page by Gridtop's
    // content frame (AttachedSections in ../../shell/shell.tsx), and this
    // view has none as tabs or tiles; if it gains some, list them here.
    <article data-period-review="" data-gui-view={m.view} className="gt:flex gt:flex-col gt:gap-4">
      {/* The window bar shows the title and subtitle. */}
      <header>
        <h1 className="gt:sr-only">{m.title}</h1>
      </header>
      {m.notice && (
        // In a box of its own, so its text sits apart from the table's currency headers.
        <div>
          <p className={cls("gt:rounded-md gt:px-3 gt:py-2 gt:text-dense gt:font-medium", TONE[m.notice.tone] ?? TONE.neutral)}>{m.notice.text}</p>
        </div>
      )}
      <ControlList
        actions={actions}
        links={m.links}
        kit={kit}
        label="Period actions"
        outcome={zero && period.from === "empty" ? null : period.outcome}
        onOutcome={fromControls}
      />
      {zero ? (
        <Empty empty={empty} kit={kit} outcome={period.from === "empty" ? period.outcome : null} onOutcome={fromEmpty} />
      ) : (
        <>
          <h2 className="gt:sr-only">Bills</h2>
          <div className="gt:hidden gt:medium:block">
            <CopyTable model={m} figures={figures} live={live} kit={kit} copier={copier} announce={announce} />
          </div>
          <div className="gt:medium:hidden">
            <BillCards model={m} figures={figures} live={live} kit={kit} copier={copier} />
          </div>
          {next && (
            <kit.Link href={next} className="gt:inline-flex gt:items-center gt:text-primary gt:hover:underline gt:pointer-coarse:min-h-11">
              More
            </kit.Link>
          )}
          <Totals model={m} figures={figures} live={live} kit={kit} copier={copier} />
        </>
      )}
      <LiveRegion speaker={speaker} />
    </article>
  );
}

export default function PeriodReviewView({ model, kit }: Props): SyncNode {
  if (model.kind !== "collection" || !readPeriodReviewExt(model)) return <kit.KitView model={model} />;
  return <Review model={model} kit={kit} />;
}

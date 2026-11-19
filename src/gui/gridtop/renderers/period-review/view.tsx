"use client";

/**
 * Gridtop's drawing of `billing.period-review@1`, one billing period's
 * bills: the host's notice, the period's own actions and links, then the
 * bills as a copy table from 600 px up and as cards below it, and the
 * totals under both. At zero rows the empty state owns its action, so the
 * toolbar leaves that action out. The window bar leaves the period's
 * controls to this view (PLACE_PAGE_CONTROLS in ../index.ts). It prints the
 * text the server formatted, copies the ext's figures, and writes only
 * through kit.act. A model whose ext it cannot read is drawn by the kit's
 * view instead.
 *
 * Loaded on demand by ./index.tsx, which hands it the kit. These files
 * import nothing else of Gridtop's or the kit's, so this chunk shares no
 * module with the shell's: a shared one makes the bundler split the shell's
 * chunks again (about 650 first-load bytes when measured for the site-day
 * renderer). If a shared import is added, measure the budgets again.
 */
import { useCallback, useState } from "react";
import type { GuiKit, ModelOf, SyncNode, ViewProps } from "@/lib/gui/contract";
import { BillCards } from "./cards";
import { ActionControl, ControlList, TONE } from "./controls";
import { useCopier } from "./copy";
import { CopyTable } from "./copy-table";
import { cls, readPeriodReviewExt } from "./ext";
import { Totals } from "./totals";

type Props = ViewProps & { kit: GuiKit };

/** The empty state, which owns the action it offers. */
function Empty({ empty, kit }: { empty: ModelOf<"collection">["body"]["empty"]; kit: GuiKit }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="gt:flex gt:flex-col gt:items-center gt:gap-3 gt:rounded-lg gt:border gt:border-dashed gt:border-border gt:bg-card gt:px-6 gt:py-10 gt:text-center">
      <h2 className="gt:text-title gt:font-semibold gt:text-foreground">{empty.title}</h2>
      {empty.text && <p className="gt:max-w-prose gt:text-body gt:text-muted-foreground">{empty.text}</p>}
      {empty.action && <ActionControl actionRef={empty.action} onResult={setError} kit={kit} />}
      {error && (
        <p role="alert" className="gt:text-caption gt:text-destructive-fg">
          {error}
        </p>
      )}
    </section>
  );
}

/** The period, drawn from the model the live refresh last returned. */
function Review({ model, kit }: { model: ModelOf<"collection">; kit: GuiKit }) {
  const live = kit.useLive(model);
  const m = live.model;
  const [said, setSaid] = useState("");
  const announce = useCallback((message: string) => setSaid(message), []);
  const copier = useCopier(announce);
  const figures = readPeriodReviewExt(m);
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
      <ControlList actions={actions} links={m.links} kit={kit} label="Period actions" />
      {zero ? (
        <Empty empty={empty} kit={kit} />
      ) : (
        <>
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
      <p aria-live="polite" className="gt:sr-only">
        {said}
      </p>
    </article>
  );
}

export default function PeriodReviewView({ model, kit }: Props): SyncNode {
  if (model.kind !== "collection" || !readPeriodReviewExt(model)) return <kit.KitView model={model} />;
  return <Review model={model} kit={kit} />;
}

"use client";

/**
 * What the month and the day share: the page frame (the notices, the line
 * naming the unit on a phone, the problem band and the view's own controls),
 * the previous and next steps, the total line, a figure with its synthetic
 * mark, and the empty state.
 *
 * ActionControl, LinkControl, Controls, Notices and the step style are
 * copies of the Operations day's (../site-day/renderer.tsx and
 * ../site-day/day-picker.tsx). This chunk imports nothing of that one's: a
 * module the two chunks shared would make the bundler split the shell's
 * chunks again (../site-day/renderer.tsx says what that cost). Sharing them
 * is a follow-up that needs the budgets measured again.
 */
import { useId, useState, type ReactNode } from "react";
import type { ActionRef, GuiKit, Href, LinkRef, ModelOf, Tone, Value } from "@/lib/gui/contract";
import { cls, type Problem, type Step } from "./ext";

// The window bar's control style (../../shell/window-bar.tsx), at least 44 px high on a touch screen.
export const CONTROL =
  "gt:inline-flex gt:h-8 gt:items-center gt:gap-2 gt:rounded-md gt:border gt:px-3 gt:text-dense gt:font-medium " +
  "gt:pointer-coarse:h-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring gt:disabled:cursor-not-allowed gt:disabled:opacity-60";
const QUIET = "gt:border-border gt:bg-card gt:text-foreground gt:hover:bg-muted";

// At least 44 px square on a touch screen, and never narrower than that in
// the step row. A followed step is aria-busy until the next page arrives
// (kit.Link), and dims.
const STEP =
  "gt:inline-flex gt:h-8 gt:min-w-8 gt:shrink-0 gt:items-center gt:justify-center gt:rounded-md gt:border gt:border-border gt:bg-card gt:px-2.5 " +
  "gt:text-dense gt:text-foreground gt:hover:bg-muted gt:pointer-coarse:h-11 gt:pointer-coarse:min-w-11 " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-ring gt:aria-busy:cursor-progress gt:aria-busy:opacity-60";

const SYNTHETIC_BAND = "Synthetic data: generated for demonstration, not measured";

const BAND: Record<Tone, string> = {
  neutral: "gt:bg-muted gt:text-foreground",
  info: "gt:bg-muted gt:text-foreground",
  accent: "gt:bg-accent gt:text-accent-foreground",
  success: "gt:bg-success-muted gt:text-success-fg",
  warning: "gt:bg-warning-muted gt:text-warning-fg",
  danger: "gt:bg-destructive-muted gt:text-destructive-fg",
};

/**
 * A quiet mark on a generated figure; the band above says what it means.
 * `inherit` drops the muted colour so the mark takes its parent's: muted
 * text falls under 4.5:1 on the calendar's darker shade tiers (month.tsx's
 * TIER), so in a calendar cell it takes the cell's colour like the figure.
 */
export function SyntheticMark({ inherit = false }: { inherit?: boolean } = {}) {
  return (
    <span
      title="Synthetic"
      className={cls("gt:ml-0.5 gt:align-super gt:text-caption gt:font-normal", !inherit && "gt:text-muted-foreground")}
    >
      <span aria-hidden="true">*</span>
      <span className="gt:sr-only"> (synthetic)</span>
    </span>
  );
}

/**
 * A figure as the server formatted it, with its synthetic mark: caption
 * size in the calendar's cells, dense in the hour list and the footers.
 * At caption size the mark takes the cell's text colour, since the cell may
 * be shaded. `shown` false keeps it for screen readers only.
 */
export function Figure({ value, size, shown = true }: { value: Value; size: "caption" | "dense"; shown?: boolean }) {
  return (
    <span
      className={cls(
        size === "caption" ? "gt:text-caption" : "gt:text-dense",
        "gt:font-semibold gt:tabular-nums gt:break-words",
        !shown && "gt:sr-only",
      )}
    >
      {value.text}
      {value.synthetic && <SyntheticMark inherit={size === "caption"} />}
    </span>
  );
}

function Band({ tone, text }: { tone: Tone; text: string }) {
  return <p className={cls("gt:rounded-md gt:px-3 gt:py-2 gt:text-dense gt:font-medium", BAND[tone] ?? BAND.neutral)}>{text}</p>;
}

/**
 * The model's notice, and the synthetic band unless the notice already says
 * so. The host puts SYNTHETIC_NOTICE (src/lib/gui/host/server/view.ts) on a
 * synthetic model, and its text says "synthetic"; if that wording changes,
 * revisit this check, or the band is drawn under it as well.
 */
function Notices({ model, synthetic }: { model: ModelOf<"collection">; synthetic: boolean }) {
  const notice = model.notice;
  const said = notice !== undefined && /synthetic/i.test(notice.text);
  return (
    <>
      {notice && <Band tone={notice.tone} text={notice.text} />}
      {synthetic && !said && <Band tone="warning" text={SYNTHETIC_BAND} />}
    </>
  );
}

/**
 * The unit's name on a phone, where the window bar shows only the title and
 * the context path only its last crumb, so nothing else names whose use this
 * is: the whole subtitle when the read had no problem (the unit, then "As
 * read at …" on a stale read), and the unit's label alone when it had one,
 * whose message the band below shows. subtitleOf in
 * src/lib/tenant-app/surface/usage-model.ts puts the unit first and the
 * problem's message after it; if either changes, revisit.
 */
function ReadLine({ model, problem, stale }: { model: ModelOf<"collection">; problem: boolean; stale: boolean }) {
  const text = problem ? (model.entity?.label ?? model.subtitle) : (model.subtitle ?? model.entity?.label);
  if (!text) return null;
  return (
    <p data-read-line="" className="gt:flex gt:items-center gt:gap-1.5 gt:text-dense gt:text-muted-foreground gt:medium:hidden">
      {stale && <span aria-hidden="true" className="gt:size-2 gt:shrink-0 gt:rounded-pill gt:bg-stale" />}
      <span className="gt:min-w-0 gt:break-words">{text}</span>
    </p>
  );
}

/**
 * Why there are no figures, in the warning tone. A read that failed is
 * never kept (src/lib/tenant-app/usage-throttle.ts), so Try again reads it
 * again through kit.refresh. A unit over its read limit would only be told
 * the same again at once, and the message already says to wait a minute,
 * so that one gets no button; nor does a unit with nothing to read
 * (`not-offered`: metering off, or no usage series), which no retry
 * changes (TenantUsageProblem in src/lib/tenant-app/types.ts). If any of
 * these rules changes, revisit.
 */
function ProblemBand({ problem, kit }: { problem: Problem; kit: GuiKit }) {
  return (
    <section role="status" className={cls("gt:flex gt:flex-col gt:items-start gt:gap-2 gt:rounded-lg gt:px-4 gt:py-3", BAND.warning)}>
      <h3 className="gt:text-body gt:font-semibold">{problem.title}</h3>
      <p className="gt:max-w-prose gt:text-body">{problem.message}</p>
      {problem.kind === "unavailable" && (
        <button type="button" onClick={() => kit.refresh()} className={cls(CONTROL, QUIET)}>
          Try again
        </button>
      )}
    </section>
  );
}

function StepLink({ step, glyph, kit }: { step: Step | null; glyph: string; kit: GuiKit }) {
  if (!step) {
    return (
      <span aria-hidden="true" className={cls(STEP, "gt:pointer-events-none gt:opacity-40")}>
        {glyph}
      </span>
    );
  }
  return (
    <kit.Link href={step.href} className={STEP}>
      <span aria-hidden="true">{glyph}</span>
      <span className="gt:sr-only">{step.label}</span>
    </kit.Link>
  );
}

/**
 * The period as a heading between its previous and next steps. At 360 px
 * main leaves 328 px; two 44 px steps and two 8 px gaps leave 224 px for the
 * heading, so a long day title such as "Wednesday 18 November 2026" (about
 * 250 px at 18 px) wraps to two lines; if the steps or the gap widen,
 * revisit. The heading takes the rest of the row and keeps the arrows at
 * its two ends.
 */
export function Steps(props: { label: string; heading: string; previous: Step | null; next: Step | null; kit: GuiKit }) {
  const { label, heading, previous, next, kit } = props;
  return (
    <nav aria-label={label} className="gt:flex gt:items-center gt:gap-2">
      <StepLink step={previous} glyph="←" kit={kit} />
      <h2 className="gt:min-w-0 gt:flex-1 gt:text-center gt:break-words gt:text-title gt:font-semibold gt:text-foreground">{heading}</h2>
      <StepLink step={next} glyph="→" kit={kit} />
    </nav>
  );
}

/** The period's total above its figures: the server's text, its mark and its note. */
export function TotalLine({ totals }: { totals: Record<string, Value> }) {
  const usage = totals.usage;
  if (!usage) return null;
  return (
    <p className="gt:flex gt:flex-wrap gt:items-baseline gt:gap-x-2">
      <span className="gt:text-dense gt:text-muted-foreground">Total</span>
      <span className="gt:text-title gt:font-semibold gt:tabular-nums gt:text-foreground">
        {usage.text}
        {usage.synthetic && <SyntheticMark />}
      </span>
      {totals.note && <span className="gt:text-dense gt:text-muted-foreground">{totals.note.text}</span>}
    </p>
  );
}

/** No figures to show: the server's empty title and text, in a dashed card. Tenant views have no empty action. */
export function EmptyBlock({ empty }: { empty: { title: string; text?: string } }) {
  return (
    <section className="gt:flex gt:flex-col gt:items-center gt:gap-3 gt:rounded-lg gt:border gt:border-dashed gt:border-border gt:bg-card gt:px-6 gt:py-10 gt:text-center">
      <h3 className="gt:text-title gt:font-semibold gt:text-foreground">{empty.title}</h3>
      {empty.text && <p className="gt:max-w-prose gt:text-body gt:text-muted-foreground">{empty.text}</p>}
    </section>
  );
}

/** Writes only through kit.act, with the ref as the model gave it; a disabled action says why instead. */
function ActionControl({ actionRef, onResult, kit }: { actionRef: ActionRef; onResult(message: string | null): void; kit: GuiKit }) {
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    onResult(null);
    const result = await kit.act(actionRef);
    setBusy(false);
    if (!result.ok && result.code !== "cancelled") onResult(result.message);
  };
  const disabled = !actionRef.enabled;
  return (
    <span className="gt:inline-flex gt:flex-col gt:gap-1">
      <button
        type="button"
        onClick={run}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={disabled && actionRef.reason ? reasonId : undefined}
        className={cls(
          CONTROL,
          actionRef.tone === "danger" ? "gt:border-destructive gt:bg-destructive-muted gt:text-destructive-fg" : QUIET,
          actionRef.provenance && "gt:border-dashed",
        )}
      >
        {actionRef.provenance && <span className="gt:text-caption gt:font-semibold gt:text-muted-foreground">Proposed</span>}
        {actionRef.label}
      </button>
      {disabled && actionRef.reason && (
        <span id={reasonId} className="gt:text-caption gt:text-muted-foreground">
          {actionRef.reason}
        </span>
      )}
    </span>
  );
}

/**
 * A page link through kit.Link, which draws a span for an href the host's
 * check refuses; a download, a share or an outside target is a button that
 * opens it through kit.open, so no anchor skips that call.
 */
function LinkControl({ link, className, kit }: { link: LinkRef; className: string; kit: GuiKit }) {
  if (link.download || link.share || !link.href.startsWith("/")) {
    return (
      <button type="button" className={className} onClick={() => void kit.open(link)}>
        {link.label}
      </button>
    );
  }
  return (
    <kit.Link href={link.href as Href} className={className}>
      {link.label}
    </kit.Link>
  );
}

/**
 * Every action, and each link whose page the view has not linked already.
 * PR 5 may add LinkRefs for these pages (RFC mgm#197); a link whose href the
 * ext already placed is not drawn twice.
 */
function Controls({ model, placed, kit }: { model: ModelOf<"collection">; placed: Set<string>; kit: GuiKit }) {
  const [error, setError] = useState<string | null>(null);
  const links = model.links.filter((l) => !placed.has(l.href));
  if (model.actions.length + links.length === 0) return null;
  return (
    <section aria-label="Actions and links" className="gt:flex gt:flex-col gt:gap-2">
      <ul className="gt:flex gt:flex-wrap gt:items-start gt:gap-2">
        {model.actions.map((ref, i) => (
          <li key={`${ref.action}-${i}`}>
            <ActionControl kit={kit} actionRef={ref} onResult={setError} />
          </li>
        ))}
        {links.map((l) => (
          <li key={l.id}>
            <LinkControl kit={kit} link={l} className={cls(CONTROL, "gt:border-transparent gt:text-primary gt:hover:underline")} />
          </li>
        ))}
      </ul>
      {error && (
        <p role="status" className="gt:text-caption gt:text-destructive-fg">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The page around a month or a day: the title for assistive tech, the
 * notices, the unit's line, the steps, the problem, the body or the empty
 * state, and the view's own controls, which the window bar leaves to this
 * renderer (drawnBespoke in ../index.ts).
 */
export function UsageFrame(props: {
  name: "tenant-usage-month" | "tenant-usage-day";
  model: ModelOf<"collection">;
  read: { synthetic: boolean; stale: boolean; problem: Problem | null };
  steps: ReactNode;
  placed: Set<string>;
  kit: GuiKit;
  children: ReactNode;
}) {
  const { name, model, read, steps, placed, kit, children } = props;
  return (
    <article data-gui-view={model.view} data-gridtop-renderer={name} className="gt:flex gt:flex-col gt:gap-4">
      <h1 className="gt:sr-only">{model.title}</h1>
      <Notices model={model} synthetic={read.synthetic} />
      <ReadLine model={model} problem={read.problem !== null} stale={read.stale} />
      {steps}
      {read.problem && <ProblemBand problem={read.problem} kit={kit} />}
      {model.body.rows.length > 0 ? children : <EmptyBlock empty={model.body.empty} />}
      <Controls model={model} placed={placed} kit={kit} />
    </article>
  );
}

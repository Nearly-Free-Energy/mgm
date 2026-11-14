"use client";

/**
 * The kit's generic renderer for the five view kinds. A GUI may use it as its
 * View. Values print the text the server formatted; writes go only through
 * kit.act. A kind this kit does not know renders as RawView.
 *
 * Collections follow the CLAUDE.md design rules: totals sit below the rows,
 * never as a row (rule 4); at zero rows the empty state owns the create
 * action and the filters stay hidden unless another filter has rows (rule 6).
 * Priority-3 columns hide under 600 px but stay in the DOM (decision 16 on #115).
 */
import { Fragment, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { LOCAL_DATE_TIME_OPTS } from "@/components/format/local-date-time";
import { LocalDate } from "@/components/format/local-date";
import { Chip, type ChipProps } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { Column, ComposeOf, ActionRef, EmbedOf, EmbeddedView, Inline, LiveState, ModelOf, Rich, ViewModel, ViewProps } from "../contract";
import { isHref } from "../host/shared/href";
import { useKitState } from "../host/client/kit-provider";
import { act } from "../host/client/kit-runtime";
import { useLive } from "../host/client/live";
import { Link, usePathname } from "../host/client/navigation";
import { RawViewAt } from "./raw-view";
import { Value, ageText, linksItself } from "./value";
import { ActionButton, BUTTON, LinkItem, ViewHeader } from "./view-parts";

type Ages = Pick<LiveState, "ageSeconds" | "stale">;

const NUMERIC = new Set(["number", "percent", "money", "energy", "power"]);
const LOW_PRIORITY = "hidden min-[600px]:table-cell";
const CELL = "px-2 py-1.5 align-top";

/**
 * `headerInShell`: the GUI's shell draws this page view's title, subtitle,
 * actions, links and the views attached as tabs (a window bar), so the
 * header keeps only a visually hidden heading and the notice. A GUI passes
 * it from its own View.
 */
export function KitView({ model, headerInShell }: ViewProps & { headerInShell?: boolean }) {
  return <KitViewAt model={model} depth={0} headerInShell={headerInShell} />;
}

function KitViewAt({ model, depth, headerInShell }: { model: ViewModel; depth: number; headerInShell?: boolean }) {
  // An embedded view is drawn from its own model and does not poll the page's path.
  const own = useMemo(() => (depth === 0 ? model : { ...model, live: undefined }), [model, depth]);
  const live = useLive(own);
  const m = live.model;
  const body = renderBody(m, live, depth);
  if (body === null) return <RawViewAt model={m} depth={depth} />;
  const hide = m.kind === "collection" && m.body.rows.length === 0 ? m.body.empty.action?.action : undefined;
  const inShell = depth === 0 && headerInShell === true;
  // The shell draws views attached as tabs among its own tabs.
  const attached = inShell ? m.attached.filter((a) => a.hint !== "tab") : m.attached;
  return (
    <article className="flex flex-col gap-4" data-gui-view={m.view} data-gui-kind={m.kind}>
      <ViewHeader model={m} depth={depth} hide={hide} inShell={inShell} />
      {body}
      {attached.length > 0 && (
        <nav aria-label="Related views">
          <ul className="flex flex-wrap gap-3 text-dense">
            {attached.map((a) => (
              <li key={a.view}>
                <Link href={a.href}>{a.title}</Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

function renderBody(model: ViewModel, ages: Ages, depth: number): ReactNode | null {
  switch (model.kind) {
    case "collection":
      return <Collection body={model.body} ages={ages} />;
    case "record":
      return <RecordBody body={model.body} ages={ages} depth={depth} />;
    case "metrics":
      return <Metrics body={model.body} ages={ages} />;
    case "feed":
      return <Feed model={model} ages={ages} depth={depth} />;
    case "flow":
      return <Flow body={model.body} />;
    default:
      return null;
  }
}

function Collection({ body, ages }: { body: ModelOf<"collection">["body"]; ages: Ages }) {
  const empty = body.rows.length === 0;
  const filters = body.filters ?? [];
  // At zero rows a filter with no count counts as empty (rule 6): the server sends counts to keep filters.
  const showFilters = filters.length > 0 && (!empty || filters.some((f) => !f.current && (f.count ?? 0) > 0));
  const controls = body.rows.some((row) => row.actions.length > 0 || (row.links?.length ?? 0) > 0);
  const cell = (c: Column) => cn(CELL, NUMERIC.has(c.type) && "text-right", c.priority === 3 && LOW_PRIORITY);
  // The row link goes in the first column that stays visible under 600 px.
  const linkAt = Math.max(0, body.columns.findIndex((c) => c.priority !== 3));
  return (
    <section className="flex flex-col gap-3">
      {showFilters && (
        <nav aria-label="Filters">
          <ul className="flex flex-wrap gap-2 text-dense">
            {filters.map((f) => (
              <li key={f.href}>
                <Link href={f.href} current={f.current} className={cn("rounded-pill px-2 py-0.5", f.current && "bg-muted font-semibold")}>
                  {f.label}
                  {f.count !== undefined && ` (${f.count})`}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {empty ? (
        <EmptyState
          title={body.empty.title}
          body={body.empty.text ?? null}
          cta={body.empty.action && <ActionButton actionRef={body.empty.action} />}
        />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-dense">
            <thead>
              <tr className="text-caption font-semibold uppercase text-muted-foreground">
                {body.columns.map((c) => (
                  <th key={c.key} scope="col" className={cn(cell(c), !NUMERIC.has(c.type) && "text-left")}>
                    {c.label}
                  </th>
                ))}
                {controls && (
                  <th scope="col" className={CELL}>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {body.rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  {body.columns.map((c, i) => {
                    const value = row.cells[c.key];
                    const shown = value && <Value value={value} live={ages} />;
                    return (
                      <td key={c.key} className={cell(c)}>
                        {i === linkAt && row.href && !linksItself(value) ? <Link href={row.href}>{shown}</Link> : shown}
                      </td>
                    );
                  })}
                  {controls && (
                    <td className={CELL}>
                      <div className="flex flex-wrap gap-2">
                        {row.actions.map((ref, i) => (
                          <ActionButton key={`${ref.action}-${i}`} actionRef={ref} />
                        ))}
                        {row.links?.map((link) => <LinkItem key={link.id} link={link} />)}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!empty && body.totals && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-2 text-dense" data-gui-totals="">
          <span className="font-semibold text-foreground">Total</span>
          {body.columns
            .filter((c) => body.totals?.[c.key])
            .map((c) => (
              <span key={c.key} className="inline-flex gap-1">
                <span className="text-muted-foreground">{c.label}</span>
                <Value value={body.totals![c.key]} live={ages} />
              </span>
            ))}
        </div>
      )}
      {!empty && body.next && <Link href={body.next}>More</Link>}
    </section>
  );
}

function RecordBody({ body, ages, depth }: { body: ModelOf<"record">["body"]; ages: Ages; depth: number }) {
  const Heading = depth === 0 ? "h2" : "h3";
  return body.sections.map((section, i) => (
    <section key={i} className="flex flex-col gap-2">
      {section.title && <Heading className="text-body font-semibold text-foreground">{section.title}</Heading>}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-dense min-[600px]:grid-cols-[minmax(0,14rem)_1fr]">
        {section.fields.map((field) => (
          <Fragment key={field.key}>
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="text-foreground">
              <Value value={field.value} live={ages} />
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  ));
}

function Metrics({ body, ages }: { body: ModelOf<"metrics">["body"]; ages: Ages }) {
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 min-[600px]:grid-cols-3">
        {body.tiles.map((tile) => (
          <li key={tile.key} className="flex flex-col gap-1 rounded-md border border-border bg-card p-3" data-gui-tile={tile.key}>
            <span className="text-caption font-semibold uppercase text-muted-foreground">{tile.label}</span>
            <span className="text-headline font-semibold text-foreground">
              <Value value={tile.value} live={ages} />
            </span>
            {tile.status && <Value value={tile.status} live={ages} />}
            {tile.hint && <span className="text-caption text-muted-foreground">{tile.hint}</span>}
          </li>
        ))}
      </ul>
      {body.series?.map((series) => <Series key={series.key} series={series} />)}
    </>
  );
}

type SeriesOf = NonNullable<ModelOf<"metrics">["body"]["series"]>[number];

/** A sparkline drawn without a chart library; a null point breaks the line. The points stay readable in a table. */
function Series({ series }: { series: SeriesOf }) {
  const values = series.points.flatMap(([, v]) => (v === null ? [] : [v]));
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const last = Math.max(series.points.length - 1, 1);
  let path = "";
  let pen = false;
  series.points.forEach(([, v], i) => {
    if (v === null) return void (pen = false);
    path += `${pen ? "L" : "M"}${((i / last) * 100).toFixed(2)} ${(22 - ((v - min) / span) * 20).toFixed(2)} `;
    pen = true;
  });
  return (
    <figure className="flex flex-col gap-1" data-gui-series={series.key}>
      <figcaption className="text-dense text-muted-foreground">
        {series.label} ({series.unit})
      </figcaption>
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-8 w-full text-primary" aria-hidden="true">
        <path d={path.trim()} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <details>
        <summary className="text-caption text-muted-foreground">Points</summary>
        <div className="relative overflow-x-auto">
          <table className="text-dense">
            <thead>
              <tr>
                <th scope="col" className={cn(CELL, "text-left")}>Time</th>
                <th scope="col" className={cn(CELL, "text-right")}>{series.unit}</th>
              </tr>
            </thead>
            <tbody>
              {series.points.map(([at, v], i) => (
                <tr key={i}>
                  <td className={CELL}>
                    <PointTime at={at} />
                  </td>
                  <td className={cn(CELL, "text-right")}>{v === null ? "—" : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;

/**
 * A point's time. A timestamp is shown through the format primitive in the
 * organization's time zone, so the server and the browser print the same
 * text; with no organization zone it falls back to the viewer's. Any other
 * label prints as given.
 */
function PointTime({ at }: { at: string }) {
  const org = useKitState()?.manifest?.org;
  if (!ISO_TIME.test(at) || Number.isNaN(Date.parse(at))) return at;
  const timeZone = org?.timezone ?? undefined;
  return <LocalDate value={at} opts={{ ...LOCAL_DATE_TIME_OPTS, timeZone }} suppressHydrationWarning={!timeZone} />;
}

function Feed({ model, ages, depth }: { model: ModelOf<"feed">; ages: Ages; depth: number }) {
  const { body } = model;
  return (
    <section className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3" aria-busy={body.busy || undefined}>
        {body.entries.map((entry) => {
          const age = ages.ageSeconds({ t: "text", text: "", at: entry.at });
          return (
            <li key={entry.id} className="flex flex-col gap-1 border-b border-border pb-2" data-gui-author={entry.author.kind}>
              <p className="text-caption text-muted-foreground">
                <span className="font-semibold text-foreground">{entry.author.name}</span>
                {age !== null && ` · ${ageText(age)}`}
              </p>
              <RichText rich={entry.text} ages={ages} />
              {entry.embed && <Embed embed={entry.embed} ages={ages} depth={depth} />}
            </li>
          );
        })}
      </ol>
      {body.compose && <Compose compose={body.compose} />}
      {body.stop && <ActionButton actionRef={body.stop} />}
    </section>
  );
}

function InlineNode({ inline, ages }: { inline: Inline; ages: Ages }) {
  if (typeof inline === "string") return inline;
  if ("value" in inline) return <Value value={inline.value} live={ages} />;
  if ("link" in inline) return <Link href={inline.link}>{inline.text}</Link>;
  return (
    <span className="underline decoration-dashed" data-gui-unverified="">
      {inline.unverified}
      <span className="text-caption text-warning-fg"> (unverified)</span>
    </span>
  );
}

/** Text nodes and links only: rich text never carries markup. Consecutive items form one list. */
function RichText({ rich, ages }: { rich: Rich; ages: Ages }) {
  const out: ReactNode[] = [];
  let items: ReactNode[] = [];
  const flush = () => {
    if (items.length) out.push(<ul key={`ul${out.length}`} className="list-disc pl-5">{items}</ul>);
    items = [];
  };
  rich.forEach((block, i) => {
    const parts = ("li" in block ? block.li : block.p).map((inline, j) => <InlineNode key={j} inline={inline} ages={ages} />);
    if ("li" in block) items.push(<li key={i}>{parts}</li>);
    else {
      flush();
      out.push(<p key={i}>{parts}</p>);
    }
  });
  flush();
  return <div className="flex flex-col gap-1 text-body text-foreground">{out}</div>;
}

function Embed({ embed, ages, depth }: { embed: EmbedOf<ActionRef, EmbeddedView>; ages: Ages; depth: number }) {
  switch (embed.type) {
    case "view":
      // One level deep; a view embedded in an embedded view is a link.
      return depth === 0 ? (
        <div className="rounded-md border border-border p-3">
          <KitViewAt model={embed.model} depth={1} />
        </div>
      ) : (
        <Link href={embed.href}>{embed.model.title}</Link>
      );
    case "action":
      return <ActionButton actionRef={embed.ref} />;
    case "values":
      return (
        <span className="flex flex-wrap gap-3">
          {embed.values.map((value, i) => (
            <Value key={i} value={value} live={ages} />
          ))}
        </span>
      );
    case "steps":
      return (
        <ol className="flex flex-col gap-1 text-dense">
          {embed.steps.map((step, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Chip tone={step.ok ? "success" : "alert"}>{step.ok ? "Done" : "Failed"}</Chip>
              {step.label}
              <span className="text-muted-foreground">{step.ms} ms</span>
            </li>
          ))}
        </ol>
      );
    default:
      return null;
  }
}

/** Sends the text, and the current page's href when the action takes one, through kit.act. */
function Compose({ compose }: { compose: ComposeOf<ActionRef> }) {
  const id = useId();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const off = !compose.action.enabled || busy;
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const href = `${pathname}${window.location.search}`;
    const context = compose.contextField && isHref(href) ? { [compose.contextField]: href } : {};
    const initial = { [compose.textField]: text, ...context };
    const result = await act(compose.action, { initial });
    setBusy(false);
    if (result.ok) setText("");
  };
  return (
    <form onSubmit={send} className="flex flex-col gap-2">
      <label htmlFor={id} className="sr-only">
        {compose.placeholder}
      </label>
      <textarea
        id={id}
        value={text}
        placeholder={compose.placeholder}
        disabled={off}
        onChange={(event) => setText(event.target.value)}
        className="min-h-16 rounded-md border border-border bg-card p-2 text-body text-foreground"
      />
      <button type="submit" disabled={off || !text.trim()} className={cn(BUTTON, "self-start border-border bg-card text-foreground")}>
        {compose.action.label}
      </button>
    </form>
  );
}

const STEP: Record<ModelOf<"flow">["body"]["steps"][number]["state"], { label: string; tone: ChipProps["tone"] }> = {
  done: { label: "Done", tone: "success" },
  current: { label: "Now", tone: "neutral" },
  todo: { label: "To do", tone: "neutral" },
  blocked: { label: "Blocked", tone: "alert" },
};

function Flow({ body }: { body: ModelOf<"flow">["body"] }) {
  return (
    <ol className="flex flex-col gap-3">
      {body.steps.map((step) => (
        <li
          key={step.id}
          aria-current={step.state === "current" ? "step" : undefined}
          className="flex flex-col gap-1 rounded-md border border-border p-3"
        >
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={STEP[step.state]?.tone ?? "neutral"}>{STEP[step.state]?.label ?? step.state}</Chip>
            <span className="text-body font-semibold text-foreground">
              {step.href ? <Link href={step.href}>{step.title}</Link> : step.title}
            </span>
          </span>
          {step.detail && <p className="text-dense text-muted-foreground">{step.detail}</p>}
          {step.action && <ActionButton actionRef={step.action} />}
        </li>
      ))}
    </ol>
  );
}

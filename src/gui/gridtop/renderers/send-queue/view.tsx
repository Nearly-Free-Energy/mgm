"use client";

/**
 * Gridtop's drawing of `billing.send-queue@1`, a period's bills with the
 * payment link a manager sends each tenant: the host's notice, the
 * readiness note, then one card per bill with its tenant, total, payment
 * status and note, the link as text a person can select, a Copy link
 * button, and the bill's own controls. It prints the text the server
 * formatted and copies the ext's link, which is the same as the link cell.
 *
 * The link is never an anchor: opening it starts a checkout for the bill,
 * and it is not an href the host hands out for navigation.
 *
 * The window bar places the period's own links (Back to period, View
 * history) on the page's own view, as it does for any renderer not in
 * PLACE_PAGE_CONTROLS (../index.ts); drawn anywhere else, this view places
 * them itself. A model whose ext it cannot read is drawn by the kit's view.
 *
 * Loaded on demand by ./index.tsx, which hands it the kit. It imports only
 * the period-review renderer's controls and clipboard write, which are not
 * in the shell's first load; if it comes to share a module with the shell,
 * measure the budgets again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GuiKit, LiveState, ModelOf, RowOf, ActionRef, SyncNode, ViewProps } from "@/lib/gui/contract";
import { CONTROL, ControlList, TONE, ValueText } from "../period-review/controls";
import { copyFigure } from "../period-review/copy";
import { cls } from "../period-review/ext";
import { LINK_KEY, readSendQueueExt } from "./ext";

type Props = ViewProps & { kit: GuiKit };
type Live = Pick<LiveState, "ageSeconds" | "stale">;

/** Appended to an announcement that repeats the last one, so a screen reader reads it again. */
export const REPEAT = " ";
/** How long a copied link stays marked. */
const PULSE_MS = 900;

export const copiedMessage = (tenant: string) => `Payment link for ${tenant}, copied`;
export const copyFailedMessage = (tenant: string) => `Could not copy the payment link for ${tenant}: select the link and copy it.`;

/** The tenant's name, from the row's ref cell or its entity. */
function tenantOf(row: RowOf<ActionRef>): string {
  const cell = row.cells.tenant;
  return cell?.t === "ref" ? cell.ref.label : (row.entity?.label ?? cell?.text ?? row.id);
}

function useCopy(announce: (message: string) => void) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (id: string, url: string, tenant: string) => {
      const ok = await copyFigure(url);
      if (timer.current) clearTimeout(timer.current);
      if (!ok) {
        setCopied(null);
        announce(copyFailedMessage(tenant));
        return;
      }
      setCopied(id);
      timer.current = setTimeout(() => setCopied(null), PULSE_MS);
      announce(copiedMessage(tenant));
    },
    [announce],
  );
  return { copied, copy };
}

function Bill(props: {
  row: RowOf<ActionRef>;
  url: string | null;
  columns: ModelOf<"collection">["body"]["columns"];
  live: Live;
  kit: GuiKit;
  copied: boolean;
  onCopy(): void;
}) {
  const { row, url, columns, live, kit, copied, onCopy } = props;
  const tenant = tenantOf(row);
  const labelOf = (key: string) => columns.find((c) => c.key === key)?.label ?? key;
  const link = row.cells[LINK_KEY];
  const note = row.cells.note;
  return (
    <li className="gt:flex gt:min-w-0 gt:flex-col gt:gap-2 gt:rounded-lg gt:border gt:border-border gt:bg-card gt:p-3">
      <div className="gt:flex gt:flex-wrap gt:items-center gt:justify-between gt:gap-2">
        <h3 className="gt:text-body gt:font-semibold gt:text-foreground">
          <ValueText value={row.cells.tenant} live={live} kit={kit} />
        </h3>
        <ValueText value={row.cells.payment} live={live} kit={kit} />
      </div>
      <div className="gt:flex gt:flex-col">
        <span className="gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground">{labelOf("total")}</span>
        <span className="gt:text-title gt:font-semibold gt:tabular-nums gt:text-foreground">
          <ValueText value={row.cells.total} live={live} kit={kit} />
        </span>
      </div>
      <div className="gt:flex gt:min-w-0 gt:flex-col gt:gap-1">
        <span className="gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground">{labelOf(LINK_KEY)}</span>
        {url !== null && link?.t === "text" ? (
          <>
            {/* Text, never a link: opening it starts a checkout. */}
            <span className="gt:min-w-0 gt:break-all gt:select-all gt:font-mono gt:text-dense gt:text-foreground">{link.text}</span>
            <span>
              <button
                type="button"
                aria-label={`Copy payment link for ${tenant}`}
                onClick={onCopy}
                className={cls(CONTROL, "gt:border-border gt:bg-card gt:text-foreground gt:hover:bg-muted", copied && "gt:bg-success-muted")}
              >
                Copy link
                {copied && (
                  <span aria-hidden="true" className="gt:text-success-fg">
                    ✓
                  </span>
                )}
              </button>
            </span>
          </>
        ) : (
          <span className="gt:text-dense">
            <ValueText value={link} live={live} kit={kit} />
          </span>
        )}
      </div>
      <div className="gt:flex gt:min-w-0 gt:flex-col">
        <span className="gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground">{labelOf("note")}</span>
        <span className="gt:text-dense gt:text-muted-foreground">
          <ValueText value={note} live={live} kit={kit} />
        </span>
      </div>
      <ControlList actions={row.actions} links={row.links ?? []} kit={kit} label={`Actions for ${tenant}`} />
    </li>
  );
}

/** The queue, drawn from the model the live refresh last returned. */
function Queue({ model, kit }: { model: ModelOf<"collection">; kit: GuiKit }) {
  const live = kit.useLive(model);
  const m = live.model;
  const page = kit.useView().model;
  const [said, setSaid] = useState("");
  const announce = useCallback((message: string) => setSaid((last) => (last === message ? `${message}${REPEAT}` : message)), []);
  const { copied, copy } = useCopy(announce);
  const links = readSendQueueExt(m);
  // A refresh that brings links this renderer cannot read: the kit's view
  // draws that model, without polling again, since this one still does.
  if (!links || m.kind !== "collection") return <kit.KitView model={{ ...m, live: undefined }} />;
  const { rows, columns, empty, next } = m.body;
  // On its own page the window bar places the period's controls.
  const own = page?.view === m.view;
  return (
    <article data-send-queue="" data-gui-view={m.view} className="gt:flex gt:flex-col gt:gap-4">
      {/* The window bar shows the title and subtitle. */}
      <header>
        <h1 className="gt:sr-only">{m.title}</h1>
      </header>
      {m.notice && (
        <p className={cls("gt:rounded-md gt:px-3 gt:py-2 gt:text-dense gt:font-medium", TONE[m.notice.tone] ?? TONE.neutral)}>{m.notice.text}</p>
      )}
      {links.note && <p className={cls("gt:rounded-md gt:px-3 gt:py-2 gt:text-dense", TONE[links.note.tone])}>{links.note.text}</p>}
      {!own && <ControlList actions={m.actions} links={m.links} kit={kit} label="Period actions" />}
      {rows.length === 0 ? (
        <section className="gt:flex gt:flex-col gt:items-center gt:gap-3 gt:rounded-lg gt:border gt:border-dashed gt:border-border gt:bg-card gt:px-6 gt:py-10 gt:text-center">
          <h2 className="gt:text-title gt:font-semibold gt:text-foreground">{empty.title}</h2>
          {empty.text && <p className="gt:max-w-prose gt:text-body gt:text-muted-foreground">{empty.text}</p>}
        </section>
      ) : (
        <ul aria-label="Bills to send" className="gt:grid gt:gap-3 gt:medium:grid-cols-2">
          {rows.map((row, i) => {
            const url = links.urls[i];
            return (
              <Bill
                key={row.id}
                row={row}
                url={url}
                columns={columns}
                live={live}
                kit={kit}
                copied={copied === row.id}
                onCopy={() => url !== null && void copy(row.id, url, tenantOf(row))}
              />
            );
          })}
        </ul>
      )}
      {next && (
        <kit.Link href={next} className="gt:inline-flex gt:items-center gt:text-primary gt:hover:underline gt:pointer-coarse:min-h-11">
          More
        </kit.Link>
      )}
      <p aria-live="polite" className="gt:sr-only">
        {said}
      </p>
    </article>
  );
}

export default function SendQueueView({ model, kit }: Props): SyncNode {
  if (model.kind !== "collection" || !readSendQueueExt(model)) return <kit.KitView model={model} />;
  return <Queue model={model} kit={kit} />;
}

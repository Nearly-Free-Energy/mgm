"use client";

/**
 * The bills as a copy table, from 600 px up: one row per bill, the model's
 * columns in its order, and each bill's controls at the end of its row.
 * Pressing a figure copies it as a plain number (the ext's figure), not as
 * it is shown.
 *
 * In the tab order the table is its scroll box, then the tenant link and the
 * Actions disclosure of the row the cursor is on. The other rows' links and
 * disclosures are out of it, so a table of any length is three stops; a
 * mouse still reaches them, and the keyboard through the cursor. Inside the
 * box a cursor moves over the figures a person copies, skipping empty cells,
 * and the box scrolls to keep it in view: the arrow keys move one cell; Home
 * and End go to the top or bottom of the column, or with Ctrl or Cmd to the
 * first or last figure; Page Up and Page Down move ten rows; Tab and
 * Shift+Tab move down and up the columns, past the last figure go on to the
 * cursor row's link and disclosure and then out of the table, and before the
 * first figure leave it; C, Enter or Space copies and, once the copy has
 * succeeded, moves to the next figure; A goes to the cursor row's
 * disclosure; Escape leaves the box, after which Tab goes to the cursor
 * row's link. Entering the box, each move and each copy is announced.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ActionRef, Column, GuiKit, LiveState, ModelOf, RowOf } from "@/lib/gui/contract";
import { RowControls, ValueText } from "./controls";
import type { Copier } from "./copy";
import { cls, type PeriodReviewFigures } from "./ext";

type Live = Pick<LiveState, "ageSeconds" | "stale">;
type At = { r: number; c: number };

const NUMERIC = new Set(["number", "percent", "money", "energy", "power"]);
const PAGE = 10;
export const END_OF_TABLE = "End of table";
const KEYS = "Arrow keys move; C, Enter or Space copies; A goes to the row's actions.";

/** The tenant of a row, as the announcements and the controls name it. */
export function tenantOf(row: RowOf<ActionRef>, tenantKey: string | undefined): string {
  return (tenantKey && row.cells[tenantKey]?.text) || row.entity?.label || row.id;
}

export function CopyTable(props: {
  model: ModelOf<"collection">;
  figures: PeriodReviewFigures;
  live: Live;
  kit: GuiKit;
  copier: Copier;
  announce(message: string): void;
}) {
  const { model, figures, live, kit, copier, announce } = props;
  const { columns, rows } = model.body;
  const region = useRef<HTMLDivElement>(null);
  // Set while a click focuses the box, which announces its copy instead of the cursor.
  const clicking = useRef(false);
  const [at, setAt] = useState<At | null>(null);
  const [focused, setFocused] = useState(false);
  const tenantKey = columns.find((c) => c.type === "ref")?.key;
  const copyIndex = useMemo(() => new Map(figures.columns.map((key, c) => [key, c])), [figures.columns]);
  const label = (c: number) => columns.find((col) => col.key === figures.columns[c])?.label ?? figures.columns[c];
  const figure = (p: At) => figures.rows[p.r]?.figures[p.c] ?? null;
  // Every figure, down each column in turn: the order Tab and copying move in.
  const order = useMemo(
    () => figures.columns.flatMap((_, c) => figures.rows.flatMap((row, r) => (row.figures[c] === null ? [] : [{ r, c }]))),
    [figures],
  );
  const indexOf = (p: At) => order.findIndex((o) => o.r === p.r && o.c === p.c);
  const describe = (p: At) => `${label(p.c)}, ${tenantOf(rows[p.r], tenantKey)}, ${rows[p.r].cells[figures.columns[p.c]]?.text ?? ""}`;
  // The cursor, kept on a figure after a refresh changes the rows.
  const current = at && figure(at) !== null ? at : (order[0] ?? null);
  const controls = rows.some((row) => row.actions.length + (row.links?.length ?? 0) > 0);
  // The row whose link and disclosure are in the tab order.
  const home = current?.r ?? 0;

  // Keep the cursor's cell in view, in the box and in the page around it,
  // since focus stays on the box and the browser scrolls to nothing.
  const [cr, cc] = [current?.r, current?.c];
  useEffect(() => {
    if (!focused || cr === undefined) return;
    region.current?.querySelector<HTMLElement>(`td[data-r="${cr}"][data-c="${cc}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [focused, cr, cc]);
  // kit.Link takes no tabIndex (LinkProps in the GUI contract), so the
  // tenant links leave the tab order here, after each render, but the home
  // row's; the disclosures take theirs as a prop.
  useEffect(() => {
    for (const link of region.current?.querySelectorAll<HTMLElement>("tbody th[scope='row'] a") ?? []) {
      link.tabIndex = link.closest("tr")?.dataset.row === String(home) ? 0 : -1;
    }
  });

  const move = (to: At | undefined) => {
    if (!to) return;
    setAt(to);
    announce(describe(to));
  };
  const copyAt = async (p: At, after?: string): Promise<boolean> => {
    const value = figure(p);
    if (value === null) return false;
    return copier.copy(`cell:${p.r}:${p.c}`, value, `${label(p.c)}, ${tenantOf(rows[p.r], tenantKey)}`, after);
  };
  const inColumn = (c: number) => order.filter((o) => o.c === c).map((o) => o.r);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed on a link or control inside the table are that control's.
    if (event.target !== event.currentTarget || !current) return;
    const { r, c } = current;
    const modified = event.ctrlKey || event.metaKey;
    const i = indexOf(current);
    const handled = () => event.preventDefault();
    switch (event.key) {
      case "ArrowRight":
      case "ArrowLeft": {
        handled();
        const step = event.key === "ArrowRight" ? 1 : -1;
        for (let x = c + step; x >= 0 && x < figures.columns.length; x += step) {
          if (figure({ r, c: x }) !== null) return move({ r, c: x });
        }
        return;
      }
      case "ArrowDown":
      case "ArrowUp": {
        handled();
        const below = event.key === "ArrowDown";
        const rs = inColumn(c).filter((x) => (below ? x > r : x < r));
        return move(rs.length === 0 ? undefined : { r: below ? rs[0] : rs[rs.length - 1], c });
      }
      case "PageDown":
      case "PageUp": {
        handled();
        const below = event.key === "PageDown";
        const rs = inColumn(c).filter((x) => (below ? x > r : x < r));
        const within = rs.filter((x) => Math.abs(x - r) <= PAGE);
        const to = below ? (within.at(-1) ?? rs[0]) : (within[0] ?? rs.at(-1));
        return move(to === undefined ? undefined : { r: to, c });
      }
      case "Home":
      case "End": {
        handled();
        const first = event.key === "Home";
        if (modified) return move(first ? order[0] : order.at(-1));
        const rs = inColumn(c);
        return move({ r: first ? rs[0] : rs[rs.length - 1], c });
      }
      case "Tab": {
        // Past the last figure, Tab goes on to the home row's link and disclosure; before the first, out of the table.
        const next = order[event.shiftKey ? i - 1 : i + 1];
        if (!next) return;
        handled();
        return move(next);
      }
      case "Enter":
      case " ":
      case "c":
      case "C": {
        if (modified || event.altKey) return;
        handled();
        const next = order[i + 1];
        const from = current;
        void copyAt(from, next ? `Next: ${describe(next)}` : END_OF_TABLE).then((ok) => {
          // A failed copy leaves the cursor on its figure, to be tried again;
          // so does a cursor the person has moved since.
          if (ok && next) setAt((now) => (now && (now.r !== from.r || now.c !== from.c) ? now : next));
        });
        return;
      }
      case "a":
      case "A": {
        if (modified || event.altKey) return;
        handled();
        const summary = region.current?.querySelector<HTMLElement>(`tr[data-row="${r}"] summary`);
        if (summary) summary.focus();
        else announce(`No actions for ${tenantOf(rows[r], tenantKey)}`);
        return;
      }
      case "Escape":
        handled();
        region.current?.blur();
        return;
    }
  };

  const HEADER = "gt:border-b gt:border-border gt:px-2 gt:py-2 gt:align-bottom gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground";
  const header = (c: Column) => cls(HEADER, NUMERIC.has(c.type) ? "gt:text-right" : "gt:text-left");
  const n = rows.length;
  return (
    <div
      ref={region}
      role="region"
      tabIndex={0}
      aria-label={`Bills, ${model.title}. ${KEYS}`}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return;
        setFocused(true);
        setAt((prev) => (prev && figure(prev) !== null ? prev : (order[0] ?? null)));
        // Say where the cursor is, which on coming back may be mid-table.
        if (current && !clicking.current) announce(describe(current));
      }}
      onBlur={(event) => {
        if (event.target === event.currentTarget) setFocused(false);
      }}
      className="gt:relative gt:overflow-x-auto gt:rounded-md gt:border gt:border-border gt:bg-card gt:focus-visible:outline-2 gt:focus-visible:outline-ring"
    >
      <table className="gt:w-full gt:border-collapse gt:text-dense gt:tabular-nums">
        <caption className="gt:sr-only">
          <span>
            Bills, {n} {n === 1 ? "tenant" : "tenants"}. {KEYS}
          </span>
        </caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col" className={header(col)}>
                {col.label}
              </th>
            ))}
            {controls && (
              <th scope="col" className={HEADER}>
                <span className="gt:sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row.id} data-row={r} className="gt:border-b gt:border-border gt:last:border-b-0">
              {columns.map((col) => {
                const value = row.cells[col.key];
                if (col.key === tenantKey) {
                  return (
                    <th key={col.key} scope="row" className="gt:px-2 gt:py-1 gt:text-left gt:align-top gt:font-medium">
                      <ValueText value={value} live={live} kit={kit} />
                    </th>
                  );
                }
                const c = copyIndex.get(col.key);
                const p = c === undefined ? null : { r, c };
                if (!p || figure(p) === null) {
                  return (
                    <td key={col.key} className={cls("gt:px-2 gt:py-1 gt:align-top", NUMERIC.has(col.type) && "gt:text-right")}>
                      <ValueText value={value} live={live} kit={kit} />
                    </td>
                  );
                }
                const here = focused && current?.r === r && current.c === p.c;
                const copied = copier.copied === `cell:${r}:${p.c}`;
                return (
                  <td
                    key={col.key}
                    data-copy=""
                    data-r={r}
                    data-c={p.c}
                    onClick={() => {
                      setAt(p);
                      clicking.current = true;
                      region.current?.focus({ preventScroll: true });
                      clicking.current = false;
                      void copyAt(p);
                    }}
                    className={cls(
                      "gt:h-8 gt:cursor-pointer gt:whitespace-nowrap gt:px-2 gt:text-right gt:align-middle gt:pointer-coarse:h-11 gt:hover:bg-muted",
                      here && "gt:bg-accent gt:outline-2 gt:-outline-offset-2 gt:outline-ring",
                      copied && "gt:bg-success-muted",
                    )}
                  >
                    <ValueText value={value} live={live} kit={kit} />
                    {copied && (
                      <span aria-hidden="true" className="gt:ml-1 gt:text-success-fg">
                        ✓
                      </span>
                    )}
                  </td>
                );
              })}
              {controls && (
                <td className="gt:px-2 gt:py-1 gt:align-top">
                  <RowControls row={row} tenant={tenantOf(row, tenantKey)} kit={kit} tabIndex={r === home ? undefined : -1} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

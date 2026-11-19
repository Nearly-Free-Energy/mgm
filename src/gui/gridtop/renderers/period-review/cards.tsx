"use client";

/**
 * The bills as cards, under 600 px: the tenant and the bill's priority-1
 * statuses, its priority-1 amount as the headline, then its other columns
 * by priority, and its controls. Each figure a person copies is a button
 * that copies the ext's figure. A figure's text is the innermost element
 * holding it, inside a button that names no currency, so a bare figure
 * never sits next to its column label.
 */
import type { ActionRef, GuiKit, LiveState, ModelOf, RowOf } from "@/lib/gui/contract";
import { RowControls, ValueText } from "./controls";
import type { Copier } from "./copy";
import { tenantOf } from "./copy-table";
import { cls, type PeriodReviewFigures } from "./ext";

type Live = Pick<LiveState, "ageSeconds" | "stale">;

function CopyButton(props: {
  id: string;
  figure: string;
  what: string;
  big?: boolean;
  value: RowOf<ActionRef>["cells"][string];
  live: Live;
  kit: GuiKit;
  copier: Copier;
}) {
  const { id, figure, what, big, value, live, kit, copier } = props;
  const copied = copier.copied === id;
  return (
    <button
      type="button"
      aria-label={`Copy ${what}, ${value.text}`}
      onClick={() => void copier.copy(id, figure, what)}
      className={cls(
        "gt:inline-flex gt:min-h-8 gt:items-center gt:gap-1 gt:rounded-md gt:px-1 gt:tabular-nums gt:hover:bg-muted gt:pointer-coarse:min-h-11",
        "gt:focus-visible:outline-2 gt:focus-visible:outline-ring",
        big ? "gt:text-title gt:font-semibold gt:text-foreground" : "gt:text-dense",
        copied && "gt:bg-success-muted",
      )}
    >
      <ValueText value={value} live={live} kit={kit} />
      {copied && (
        <span aria-hidden="true" className="gt:text-success-fg">
          ✓
        </span>
      )}
    </button>
  );
}

export function BillCards(props: { model: ModelOf<"collection">; figures: PeriodReviewFigures; live: Live; kit: GuiKit; copier: Copier }) {
  const { model, figures, live, kit, copier } = props;
  const { columns, rows } = model.body;
  const tenantKey = columns.find((c) => c.type === "ref")?.key;
  const headline = columns.find((c) => c.priority === 1 && c.type === "money");
  const chips = columns.filter((c) => c.priority === 1 && c.type === "status");
  const shown = new Set([tenantKey, headline?.key, ...chips.map((c) => c.key)]);
  const rest = [2, 3].flatMap((p) => columns.filter((c) => c.priority === p && !shown.has(c.key)));
  const figureOf = (r: number, key: string) => {
    const c = figures.columns.indexOf(key);
    return c < 0 ? null : (figures.rows[r]?.figures[c] ?? null);
  };
  return (
    <ul aria-label="Bills" className="gt:flex gt:flex-col gt:gap-3">
      {rows.map((row, r) => {
        const tenant = tenantOf(row, tenantKey);
        const big = headline && row.cells[headline.key];
        const bigFigure = headline ? figureOf(r, headline.key) : null;
        return (
          <li key={row.id} className="gt:flex gt:flex-col gt:gap-2 gt:rounded-lg gt:border gt:border-border gt:bg-card gt:p-3">
            <div className="gt:flex gt:flex-wrap gt:items-center gt:justify-between gt:gap-2">
              <h3 className="gt:text-body gt:font-semibold gt:text-foreground">
                <ValueText value={tenantKey ? row.cells[tenantKey] : undefined} live={live} kit={kit} />
              </h3>
              {chips.map((c) => (
                <ValueText key={c.key} value={row.cells[c.key]} live={live} kit={kit} />
              ))}
            </div>
            {headline && big && (
              <div className="gt:flex gt:flex-col">
                <span className="gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground">{headline.label}</span>
                <span>
                  {bigFigure === null ? (
                    <ValueText value={big} live={live} kit={kit} />
                  ) : (
                    <CopyButton id={`card:${r}:${headline.key}`} figure={bigFigure} what={`${headline.label}, ${tenant}`} big value={big} live={live} kit={kit} copier={copier} />
                  )}
                </span>
              </div>
            )}
            <dl className="gt:grid gt:grid-cols-2 gt:gap-x-3 gt:gap-y-1">
              {rest.map((c) => {
                const value = row.cells[c.key];
                const figure = figureOf(r, c.key);
                return (
                  <div key={c.key} className="gt:flex gt:min-w-0 gt:flex-col">
                    <dt className="gt:text-caption gt:text-muted-foreground">{c.label}</dt>
                    <dd className="gt:text-dense">
                      {value && figure !== null ? (
                        <CopyButton id={`card:${r}:${c.key}`} figure={figure} what={`${c.label}, ${tenant}`} value={value} live={live} kit={kit} copier={copier} />
                      ) : (
                        <ValueText value={value} live={live} kit={kit} />
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <RowControls row={row} tenant={tenant} kit={kit} />
          </li>
        );
      })}
    </ul>
  );
}

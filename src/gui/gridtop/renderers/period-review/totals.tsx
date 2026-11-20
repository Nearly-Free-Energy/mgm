"use client";

/**
 * The totals, below the table and the cards and never as a row of either:
 * each column that has one, in the table's order, as a button that copies
 * the ext's figure.
 */
import type { GuiKit, LiveState, ModelOf } from "@/lib/gui/contract";
import { ValueText } from "./controls";
import type { Copier } from "./copy";
import { cls, type PeriodReviewFigures } from "./ext";

export function Totals(props: {
  model: ModelOf<"collection">;
  figures: PeriodReviewFigures;
  live: Pick<LiveState, "ageSeconds" | "stale">;
  kit: GuiKit;
  copier: Copier;
}) {
  const { model, figures, live, kit, copier } = props;
  const totals = model.body.totals;
  if (!totals) return null;
  const shown = model.body.columns.filter((c) => totals[c.key]);
  if (shown.length === 0) return null;
  return (
    <section data-totals="" aria-label="Totals" className="gt:flex gt:flex-col gt:gap-2 gt:rounded-md gt:border gt:border-border gt:bg-muted gt:p-3">
      <h2 className="gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground">Total</h2>
      <dl className="gt:flex gt:flex-wrap gt:gap-x-6 gt:gap-y-2">
        {shown.map((c) => {
          const value = totals[c.key];
          const i = figures.columns.indexOf(c.key);
          const figure = i < 0 ? null : (figures.totals[i] ?? null);
          const id = `total:${c.key}`;
          const copied = copier.copied === id;
          return (
            <div key={c.key} className="gt:flex gt:flex-col">
              <dt className="gt:text-caption gt:text-muted-foreground">{c.label}</dt>
              <dd className="gt:text-dense gt:font-semibold gt:text-foreground gt:tabular-nums">
                {figure === null ? (
                  <ValueText value={value} live={live} kit={kit} />
                ) : (
                  <button
                    type="button"
                    aria-label={`Copy total ${c.label}, ${value.text}`}
                    onClick={() => void copier.copy(id, figure, `Total ${c.label}`)}
                    className={cls(
                      "gt:inline-flex gt:min-h-8 gt:items-center gt:gap-1 gt:rounded-md gt:px-1 gt:hover:bg-card gt:pointer-coarse:min-h-11",
                      "gt:focus-visible:outline-2 gt:focus-visible:outline-ring",
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
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

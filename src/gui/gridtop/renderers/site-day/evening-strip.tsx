"use client";

/**
 * Who served the houses in the evening window, ported from the Operations
 * page's strip (src/components/operations/daily-operations.tsx): one segment
 * per change of supply, each as wide as its share of the window, hourly ticks
 * under it, and a key. The heading and the summary are the model's
 * `evening-supply` tile, which the tiles leave to this strip; every label is
 * the server's.
 */
import type { DayChart, Supply } from "./ext";
import { Figure, type Tile } from "./tiles";

const SWATCH: Record<Supply, string> = {
  battery: "gt:bg-success",
  battery_and_grid: "gt:bg-success-muted",
  grid: "gt:bg-warning",
  dark: "gt:bg-foreground",
  no_data: "gt:bg-muted",
};

/** Each segment's width as a percentage of the evening window; a full evening sums to 100. */
export function segmentWidths(chart: Pick<DayChart, "evening" | "eveningStartMs" | "dayEndMs">): number[] {
  const span = chart.dayEndMs - chart.eveningStartMs;
  return chart.evening.map((s) => (100 * (s.endMs - s.startMs)) / span);
}

export function EveningStrip({ chart, tile }: { chart: DayChart; tile: Tile | undefined }) {
  const widths = segmentWidths(chart);
  // The summary already says the window has not started when it is that text.
  const emptyNote = chart.eveningEmpty !== null && tile?.value.text !== chart.eveningEmpty ? chart.eveningEmpty : null;
  return (
    <section data-tile="evening-supply" className="gt:flex gt:flex-col gt:gap-2 gt:rounded-lg gt:border gt:border-border gt:bg-card gt:px-4 gt:py-3">
      {tile && (
        <>
          <h3 className="gt:text-caption gt:font-semibold gt:uppercase gt:tracking-wide gt:text-muted-foreground">{tile.label}</h3>
          <p className="gt:text-dense gt:text-foreground">
            <Figure value={tile.value} />
          </p>
        </>
      )}
      {chart.evening.length === 0 ? (
        emptyNote && <p className="gt:text-dense gt:text-muted-foreground">{emptyNote}</p>
      ) : (
        <>
          <div>
            <div role="img" aria-label={chart.eveningLabel} className="gt:flex gt:h-6 gt:w-full gt:overflow-hidden gt:rounded-sm gt:bg-background">
              {chart.evening.map((segment, i) => (
                <div key={segment.startMs} className={SWATCH[segment.supply]} style={{ width: `${widths[i]}%` }} title={segment.label} />
              ))}
            </div>
            <div className="gt:mt-1 gt:flex gt:justify-between gt:text-caption gt:text-muted-foreground">
              {chart.eveningTicks.map((t) => (
                <span key={t.label}>{t.label}</span>
              ))}
            </div>
          </div>
          {/* The key; the hours are in the summary above it. */}
          <ul className="gt:flex gt:flex-wrap gt:gap-x-4 gt:gap-y-1 gt:text-caption gt:text-muted-foreground">
            {chart.legend.map((l) => (
              <li key={l.supply} className="gt:flex gt:items-center gt:gap-1.5">
                <span aria-hidden="true" className={`gt:inline-block gt:size-2.5 gt:rounded-sm ${SWATCH[l.supply]}`} />
                {l.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

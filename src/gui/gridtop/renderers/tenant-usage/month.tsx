"use client";

/**
 * The month as a calendar: a week to a row, Monday first, each day up to
 * today a link to its day with the figure the server formatted, shaded by
 * its tier, then the total again below the rows, and a key to the shading.
 *
 * Weeks start on Monday: the ext's firstWeekday counts from Monday, and the
 * pilot's audience reads Monday weeks. A week start for the locale would be
 * a field of the ext's next version (`@2`).
 *
 * Every state differs by more than colour: a day with a figure is tinted
 * and prints it; today so far has a dashed edge; a day not read prints "No
 * data" on a muted fill with a hairline edge; a day with no meter prints "No
 * meter" with no fill; a future day prints its number alone and links
 * nowhere.
 */
import type { GuiKit, Value } from "@/lib/gui/contract";
import { cls, type MonthDay, type MonthExt, type Row, type UsageState } from "./ext";
import { Figure } from "./parts";

const WEEKDAYS = [
  ["M", "Monday"],
  ["T", "Tuesday"],
  ["W", "Wednesday"],
  ["T", "Thursday"],
  ["F", "Friday"],
  ["S", "Saturday"],
  ["S", "Sunday"],
] as const;

// Each cell is a seventh of main's width less 1 px spacing: at 360 px main
// leaves 328 px, so 320 / 7 ≈ 45.7 px a cell, and 56 px high. That fits
// 7 × 44 px only while main's padding is 16 px a side and the spacing 1 px;
// if either widens, revisit. The figure is at the caption size, not the
// RFC's dense size: dense is 16 px on touch screens, and a figure with its
// unit and synthetic mark does not fit a cell this narrow at 16 px; if the
// cells widen, revisit. The cells sit inside a scrolling box, which clips
// anything drawn outside it, so the focus mark is drawn inside the cell, in
// the foreground colour: the brand's focus colour is too close to the shade
// tiers to show on them (design-tokens.test.ts holds the focus colour to
// 3:1 on each tier). No text colour here: each STATE sets exactly one, since two
// colour utilities on one element resolve by stylesheet order, not class
// order (as ../../shell/context-path.tsx's CARET says).
const CELL =
  "gt:flex gt:min-h-14 gt:w-full gt:flex-col gt:items-center gt:justify-start gt:gap-0.5 gt:rounded-sm gt:px-0.5 gt:py-1 " +
  "gt:text-center gt:pointer-coarse:min-w-11 gt:focus-visible:outline-2 gt:focus-visible:outline-offset-[-2px] gt:focus-visible:outline-foreground gt:aria-busy:opacity-60";
export const STATE: Record<Exclude<UsageState, "future">, string> = {
  data: "gt:border gt:border-transparent gt:text-foreground",
  partial: "gt:border-2 gt:border-dashed gt:border-foreground gt:text-foreground",
  "no-data": "gt:border gt:border-border gt:bg-muted gt:text-muted-foreground",
  "no-meter": "gt:text-muted-foreground",
};
/**
 * The shade behind a day's figure, by tier. All text on every tier, the
 * synthetic mark included (Figure's caption size in ./parts.tsx), takes the
 * cell's foreground colour; src/lib/__tests__/design-tokens.test.ts reads
 * these classes and holds that text to 4.5:1 and CELL's focus colour to 3:1
 * on each, in both themes.
 */
export const TIER = {
  1: "gt:bg-energy-load/10",
  2: "gt:bg-energy-load/20",
  3: "gt:bg-energy-load/35",
  4: "gt:bg-energy-load/50",
} as const;
// A future day: its number in muted text with no opacity, which would take
// it under 4.5:1 where the contrast test cannot see.
const FUTURE = "gt:flex gt:min-h-14 gt:flex-col gt:items-center gt:py-1 gt:text-caption gt:text-muted-foreground";

function DayCell({ day, row, kit }: { day: MonthDay; row: Row | undefined; kit: GuiKit }) {
  if (day.state === "future" || !day.href || !row) {
    return (
      <span className={FUTURE}>
        <span className="gt:tabular-nums">{day.day}</span>
      </span>
    );
  }
  const shaded = (day.state === "data" || day.state === "partial") && day.tier !== null ? TIER[day.tier] : null;
  const { date, usage, note } = row.cells;
  return (
    <kit.Link href={day.href} className={cls(CELL, STATE[day.state], shaded)}>
      <span aria-hidden="true" className="gt:text-caption gt:tabular-nums">
        {day.day}
      </span>
      <span className="gt:sr-only">{date.text},</span>{" "}
      <Figure value={usage} size="caption" shown={day.state !== "no-meter"} />
      {day.state === "no-meter" && (
        <span aria-hidden="true" className="gt:text-caption">
          No meter
        </span>
      )}
      {note && <span className="gt:sr-only">, {note.text}</span>}
    </kit.Link>
  );
}

/** Weeks of seven cells, Monday first, with empty cells before the 1st and after the last day. */
export function weeksOf(ext: MonthExt): (MonthDay | null)[][] {
  const cells: (MonthDay | null)[] = [...Array<null>(ext.firstWeekday).fill(null), ...ext.days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (MonthDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function MonthCalendar(props: { ext: MonthExt; rowOf(key: string): Row | undefined; totals: Record<string, Value> | undefined; kit: GuiKit }) {
  const { ext, rowOf, totals, kit } = props;
  // Positioned as well as scrolling, so the caption and weekday names kept
  // for screen readers are placed inside this box and cannot widen the page.
  return (
    <div className="gt:relative gt:overflow-x-auto">
      <table className="gt:w-full gt:table-fixed gt:border-separate gt:border-spacing-px">
        <caption className="gt:sr-only">Use per day, {ext.title}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th key={long} scope="col" className="gt:pb-1 gt:text-caption gt:font-semibold gt:text-muted-foreground">
                <span aria-hidden="true">{short}</span>
                <span className="gt:sr-only">{long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeksOf(ext).map((week, w) => (
            <tr key={w}>
              {week.map((day, i) => (
                <td key={day ? day.date : `blank-${i}`} data-state={day?.state} className="gt:p-0 gt:align-top">
                  {day && <DayCell day={day} row={rowOf(day.date)} kit={kit} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals?.usage && (
          <tfoot>
            <tr>
              <th scope="row" colSpan={7} className="gt:pt-2 gt:text-start gt:font-normal">
                <span className="gt:flex gt:flex-wrap gt:items-baseline gt:gap-x-2">
                  <span className="gt:text-dense gt:text-muted-foreground">Total</span>
                  <Figure value={totals.usage} size="dense" />
                  {totals.note && <span className="gt:text-dense gt:text-muted-foreground">{totals.note.text}</span>}
                </span>
              </th>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** The key to the shading, and to today's dashed edge when today is shown. Its words repeat no figure. */
export function MonthLegend({ ext }: { ext: MonthExt }) {
  const today = ext.days.some((d) => d.state === "partial");
  const swatch = "gt:inline-flex gt:size-3 gt:rounded-sm gt:border gt:border-border";
  return (
    <ul className="gt:flex gt:flex-wrap gt:items-center gt:gap-x-3 gt:gap-y-1 gt:text-caption gt:text-muted-foreground">
      <li className="gt:flex gt:items-center gt:gap-1">
        <span aria-hidden="true">Less</span>
        {([1, 2, 3, 4] as const).map((tier) => (
          <span key={tier} aria-hidden="true" className="gt:inline-flex gt:rounded-sm gt:bg-card">
            <span className={cls(swatch, TIER[tier])} />
          </span>
        ))}
        <span aria-hidden="true">More</span>
        <span className="gt:sr-only">Shading shows each day&apos;s use against this month&apos;s highest day.</span>
      </li>
      {today && (
        <li className="gt:flex gt:items-center gt:gap-1">
          <span aria-hidden="true" className="gt:inline-flex gt:size-3 gt:rounded-sm gt:border-2 gt:border-dashed gt:border-foreground" />
          Today, so far
        </li>
      )}
    </ul>
  );
}

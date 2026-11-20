"use client";

/**
 * The day: bars of the use per hour, a picture only, then the hours up to
 * now as a list with the total below them. The bars carry no text, so
 * screen readers and the checks read the list. The day has as many hours
 * as the ext gives (23 to 25 where the clocks change), each with the
 * server's label, which names the UTC offset on such a day; nothing here
 * assumes 24.
 */
import type { Value } from "@/lib/gui/contract";
import { cls, type DayExt, type DayHour, type Row } from "./ext";
import { Figure } from "./parts";

/** A bar's height in the 100-unit chart: never less than 1.5, so a small figure still shows. */
const barHeight = (kwh: number, max: number) => Math.max(1.5, max > 0 ? (kwh / max) * 96 : 0);

/**
 * One hour, 8 units wide in a 10-unit slot. A figure is a solid bar; an hour
 * still running is a pale bar with a dashed edge; an hour with no figure is
 * a short stub on the baseline; an hour with no meter, or still to come,
 * draws nothing.
 */
function HourBar({ x, hour, max }: { x: number; hour: DayHour; max: number }) {
  if ((hour.state === "data" || hour.state === "partial") && hour.kwh !== null) {
    const h = barHeight(hour.kwh, max);
    return hour.state === "data" ? (
      <rect data-state={hour.state} x={x} y={100 - h} width={8} height={h} className="gt:fill-energy-load" />
    ) : (
      <rect
        data-state={hour.state}
        x={x}
        y={100 - h}
        width={8}
        height={h}
        strokeDasharray="3 2"
        vectorEffect="non-scaling-stroke"
        className="gt:fill-energy-load/40 gt:stroke-energy-load"
      />
    );
  }
  if (hour.state === "partial" || hour.state === "no-data") {
    return <rect data-state={hour.state} x={x} y={96} width={8} height={4} className="gt:fill-muted-foreground/50" />;
  }
  return null;
}

export function HourBars({ hours }: { hours: DayHour[] }) {
  const n = hours.length;
  const max = Math.max(0, ...hours.map((h) => h.kwh ?? 0));
  return (
    <figure aria-hidden="true" className="gt:flex gt:flex-col gt:gap-1">
      <svg viewBox={`0 0 ${n * 10} 100`} preserveAspectRatio="none" className="gt:h-32 gt:w-full gt:overflow-visible">
        <line x1={0} x2={n * 10} y1={100} y2={100} vectorEffect="non-scaling-stroke" className="gt:stroke-border" />
        {hours.map((h, i) => (
          <HourBar key={h.start} x={i * 10 + 1} hour={h} max={max} />
        ))}
      </svg>
      <div className="gt:flex gt:justify-between gt:gap-2 gt:text-caption gt:text-muted-foreground gt:tabular-nums">
        <span>{hours[0].label}</span>
        <span>{hours[Math.floor(n / 2)].label}</span>
        <span>{hours[n - 1].label}</span>
      </div>
    </figure>
  );
}

/**
 * The hours up to now, in the ext's order, each with its row's text. An hour
 * still running gets a dashed left edge, and an hour not read is muted;
 * the note on screen says which ("So far", "Not read yet"). Each element sets
 * at most one text colour, so the list sets none that a state also sets.
 */
export function HourTable(props: { ext: DayExt; rowOf(key: string): Row | undefined; columns: { key: string; label: string }[]; totals: Record<string, Value> | undefined }) {
  const { ext, rowOf, columns, totals } = props;
  const label = (key: string, fallback: string) => columns.find((c) => c.key === key)?.label ?? fallback;
  const shown = ext.hours.flatMap((hour) => {
    const row = hour.state === "future" ? undefined : rowOf(hour.start);
    return row ? [{ hour, row }] : [];
  });
  const head = "gt:px-2 gt:py-1 gt:text-caption gt:font-semibold gt:text-muted-foreground";
  // Positioned as well as scrolling, so the caption kept for screen readers
  // is placed inside this box and cannot widen the page.
  return (
    <div className="gt:relative gt:overflow-x-auto">
      <table className="gt:w-full gt:text-dense">
        <caption className="gt:sr-only">Use per hour, {ext.title}</caption>
        <thead>
          <tr className="gt:border-b gt:border-border">
            <th scope="col" className={cls(head, "gt:text-start")}>
              {label("hour", "Hour")}
            </th>
            <th scope="col" className={cls(head, "gt:text-end")}>
              {label("usage", "Use")}
            </th>
            <th scope="col" className={cls(head, "gt:text-start")}>
              {label("note", "Note")}
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ hour, row }) => {
            const muted = hour.state === "no-data" || hour.state === "no-meter";
            return (
              <tr key={row.id} data-state={hour.state} className="gt:border-b gt:border-border">
                <th
                  scope="row"
                  className={cls(
                    "gt:px-2 gt:py-1 gt:text-start gt:font-normal gt:tabular-nums",
                    hour.state === "partial" && "gt:border-l-2 gt:border-dashed gt:border-foreground",
                    muted && "gt:text-muted-foreground",
                  )}
                >
                  {row.cells.hour.text}
                </th>
                <td className={cls("gt:px-2 gt:py-1 gt:text-end gt:tabular-nums", muted && "gt:text-muted-foreground")}>
                  <Figure value={row.cells.usage} size="dense" />
                </td>
                <td className="gt:px-2 gt:py-1 gt:text-muted-foreground">{row.cells.note?.text ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
        {totals?.usage && (
          <tfoot>
            <tr>
              <th scope="row" className="gt:px-2 gt:py-1 gt:text-start gt:font-semibold">
                Total
              </th>
              <td className="gt:px-2 gt:py-1 gt:text-end">
                <Figure value={totals.usage} size="dense" />
              </td>
              <td className="gt:px-2 gt:py-1 gt:text-muted-foreground">{totals.note?.text ?? ""}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

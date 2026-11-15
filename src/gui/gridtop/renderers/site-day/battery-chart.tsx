"use client";

/**
 * The day's battery level, ported from the Operations page's chart
 * (src/components/operations/daily-operations.tsx): the evening window, the
 * cuts, dark time and the part of today not yet read as bands, grid lines
 * every 20%, and the battery line, which breaks at a missing bin. The
 * description, the hour labels and the no-battery note are the server's; the
 * heading, the key, the axis labels and the geometry are the legacy chart's.
 */
import type { DayChart } from "./ext";

/** The model's `soc` series: [ISO bin start, percent or null]. */
export type SocPoints = [string, number | null][];

// Chart geometry (SVG user units; the SVG scales to its container).
const W = 720;
const H = 240;
const PAD = { left: 36, right: 8, top: 8, bottom: 24 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const GRID = [0, 20, 40, 60, 80, 100];

const SWATCH = "gt:inline-block gt:size-2.5 gt:rounded-sm";
const KEY: { label: string; swatch: string }[] = [
  { label: "Battery", swatch: "gt:inline-block gt:h-0.5 gt:w-4 gt:bg-success" },
  { label: "Power cut", swatch: `${SWATCH} gt:bg-warning-muted` },
  { label: "Houses dark", swatch: `${SWATCH} gt:bg-foreground/70` },
  { label: "Evening window", swatch: `${SWATCH} gt:bg-muted` },
];

/** One path per run of readings; a null reading breaks the line. Each is drawn at the middle of its bin. */
export function socPaths(points: SocPoints, x: (ms: number) => number, y: (pct: number) => number, binMs: number): string[] {
  const paths: string[] = [];
  let current = "";
  for (const [at, pct] of points) {
    const atMs = Date.parse(at);
    if (pct === null || Number.isNaN(atMs)) {
      if (current) paths.push(current);
      current = "";
      continue;
    }
    const px = x(atMs + binMs / 2).toFixed(1);
    const py = y(pct).toFixed(1);
    current += current ? ` L${px} ${py}` : `M${px} ${py}`;
  }
  if (current) paths.push(current);
  return paths;
}

function Chart({ chart, points }: { chart: DayChart; points: SocPoints }) {
  const { dayStartMs, dayEndMs, readUntilMs, eveningStartMs } = chart;
  const span = dayEndMs - dayStartMs;
  const x = (ms: number) => PAD.left + (PLOT_W * Math.min(Math.max(ms - dayStartMs, 0), span)) / span;
  const y = (pct: number) => PAD.top + PLOT_H * (1 - Math.min(Math.max(pct, 0), 100) / 100);
  const band = (kind: string, i: number, startMs: number, endMs: number, className: string) => (
    <rect key={`${kind}-${i}`} data-band={kind} x={x(startMs)} y={PAD.top} width={Math.max(x(endMs) - x(startMs), 1)} height={PLOT_H} className={className} />
  );
  const last = chart.hourMarks.length - 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="gt:h-auto gt:w-full gt:min-w-[560px]" role="img" aria-label={chart.chartLabel}>
      {/* The evening window, cuts, dark time, then the part of today not read yet. */}
      {band("evening", 0, eveningStartMs, dayEndMs, "gt:fill-muted")}
      {(chart.cuts ?? []).map((r, i) => band("cut", i, r.startMs, r.endMs, "gt:fill-warning-muted"))}
      {chart.dark.map((r, i) => band("dark", i, r.startMs, r.endMs, "gt:fill-foreground/70"))}
      {readUntilMs < dayEndMs && band("future", 0, readUntilMs, dayEndMs, "gt:fill-background")}

      {GRID.map((pct) => (
        <g key={pct}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(pct)} y2={y(pct)} className="gt:stroke-border" strokeWidth={1} />
          <text x={PAD.left - 6} y={y(pct) + 4} textAnchor="end" className="gt:fill-muted-foreground gt:text-caption">
            {pct}
          </text>
        </g>
      ))}
      {chart.hourMarks.map((mark, i) => (
        <text
          key={mark.label}
          x={x(mark.atMs)}
          y={H - 6}
          textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"}
          className="gt:fill-muted-foreground gt:text-caption"
        >
          {mark.label}
        </text>
      ))}

      {socPaths(points, x, y, chart.resolutionMinutes * 60_000).map((d, i) => (
        <path key={i} d={d} fill="none" className="gt:stroke-success" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </svg>
  );
}

export function BatteryChart({ chart, points }: { chart: DayChart; points: SocPoints }) {
  return (
    <section className="gt:rounded-lg gt:border gt:border-border gt:bg-card gt:px-4 gt:py-3">
      <div className="gt:flex gt:flex-wrap gt:items-baseline gt:justify-between gt:gap-2">
        <h3 className="gt:text-caption gt:font-semibold gt:uppercase gt:tracking-wide gt:text-muted-foreground">Battery level (%)</h3>
        <ul className="gt:flex gt:flex-wrap gt:gap-x-4 gt:gap-y-1 gt:text-caption gt:text-muted-foreground">
          {KEY.map((k) => (
            <li key={k.label} className="gt:flex gt:items-center gt:gap-1.5">
              <span aria-hidden="true" className={k.swatch} />
              {k.label}
            </li>
          ))}
        </ul>
      </div>
      {/* On a phone the chart keeps a readable size and scrolls sideways. */}
      <div className="gt:relative gt:mt-2 gt:overflow-x-auto">
        {chart.chartEmpty === null ? (
          <Chart chart={chart} points={points} />
        ) : (
          <p className="gt:text-dense gt:text-muted-foreground">{chart.chartEmpty}</p>
        )}
      </div>
    </section>
  );
}

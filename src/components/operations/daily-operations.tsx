"use client";

import * as React from "react";
import { Kwh } from "@/components/format/kwh";
import { formatLocalDate } from "@/components/format/local-date";
import { useLocale } from "@/components/format/locale-context";
import type {
  EveningSupply,
  SiteDaySummary,
  TimeRange,
} from "@/lib/metering/site-operations";
import { cn } from "@/lib/utils";

/** "4h 10m", "45m", "0m". */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Percent({ value, digits = 0 }: { value: number; digits?: number }) {
  return <span className="font-mono tabular-nums">{value.toFixed(digits)}%</span>;
}

function useClock(timezone: string) {
  const { locale } = useLocale();
  return React.useCallback(
    (ms: number) =>
      formatLocalDate(new Date(ms), locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: timezone,
      }),
    [locale, timezone]
  );
}

function Stat({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "neutral" | "warn" | "alert" | "success";
}) {
  return (
    <section className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold",
          tone === "warn" && "text-warning-fg",
          tone === "alert" && "text-destructive-fg",
          tone === "success" && "text-success-fg",
          tone === "neutral" && "text-foreground"
        )}
      >
        {value}
      </p>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </section>
  );
}

const NOT_AVAILABLE = <span className="text-muted-foreground">—</span>;

// Chart geometry (SVG user units; the SVG scales to its container).
const W = 720;
const H = 240;
const PAD = { left: 36, right: 8, top: 8, bottom: 24 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function BatteryChart({ day }: { day: SiteDaySummary }) {
  const clock = useClock(day.timezone);
  const span = day.dayEndMs - day.dayStartMs;
  const x = (ms: number) =>
    PAD.left + (PLOT_W * Math.min(Math.max(ms - day.dayStartMs, 0), span)) / span;
  const y = (pct: number) => PAD.top + PLOT_H * (1 - Math.min(Math.max(pct, 0), 100) / 100);
  const binMs = day.resolutionMinutes * 60_000;

  // One path per run of samples; a missing bin breaks the line.
  const paths: string[] = [];
  let current = "";
  for (const point of day.soc) {
    if (point.pct === null) {
      if (current) paths.push(current);
      current = "";
      continue;
    }
    const px = x(point.atMs + binMs / 2).toFixed(1);
    const py = y(point.pct).toFixed(1);
    current += current ? ` L${px} ${py}` : `M${px} ${py}`;
  }
  if (current) paths.push(current);

  const band = (r: TimeRange, className: string, key: string) => (
    <rect
      key={key}
      x={x(r.startMs)}
      y={PAD.top}
      width={Math.max(x(r.endMs) - x(r.startMs), 1)}
      height={PLOT_H}
      className={className}
    />
  );

  const until = day.readUntilMs >= day.dayEndMs ? "24:00" : clock(day.readUntilMs);
  const cutCount = day.cuts?.length ?? 0;
  const describe = [
    `Battery level from ${clock(day.dayStartMs)} to ${until}.`,
    day.lowestSoc ? `Lowest ${Math.round(day.lowestSoc.pct)}% at ${clock(day.lowestSoc.atMs)}.` : "",
    cutCount ? `${cutCount} power ${cutCount === 1 ? "cut" : "cuts"}.` : "",
    day.dark.length ? `Houses dark for ${formatDuration(day.darkMinutes)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full min-w-[560px]"
      role="img"
      aria-label={describe}
    >
      {/* Evening selling window */}
      {band(
        { startMs: day.eveningStartMs, endMs: day.dayEndMs },
        "fill-muted",
        "evening"
      )}
      {(day.cuts ?? []).map((r, i) => band(r, "fill-warning-muted", `cut-${i}`))}
      {day.dark.map((r, i) => band(r, "fill-foreground/70", `dark-${i}`))}
      {day.readUntilMs < day.dayEndMs &&
        band(
          { startMs: day.readUntilMs, endMs: day.dayEndMs },
          "fill-background",
          "future"
        )}

      {[0, 20, 40, 60, 80, 100].map((pct) => (
        <g key={pct}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(pct)}
            y2={y(pct)}
            className="stroke-border"
            strokeWidth={1}
          />
          <text
            x={PAD.left - 6}
            y={y(pct) + 4}
            textAnchor="end"
            className="fill-muted-foreground text-[11px]"
          >
            {pct}
          </text>
        </g>
      ))}
      {day.hourMarks.map(({ hour, atMs }) => (
        <text
          key={hour}
          x={x(atMs)}
          y={H - 6}
          textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"}
          className="fill-muted-foreground text-[11px]"
        >
          {String(hour).padStart(2, "0")}
        </text>
      ))}

      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          className="stroke-success"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

const SUPPLY: Record<EveningSupply, { label: string; swatch: string }> = {
  battery: { label: "Battery", swatch: "bg-success" },
  battery_and_grid: { label: "Battery + grid", swatch: "bg-success-muted" },
  grid: { label: "Grid alone", swatch: "bg-warning" },
  dark: { label: "Dark", swatch: "bg-foreground" },
  no_data: { label: "No data", swatch: "bg-muted" },
};

function EveningStrip({ day }: { day: SiteDaySummary }) {
  const clock = useClock(day.timezone);
  const span = day.dayEndMs - day.eveningStartMs;
  const order: EveningSupply[] = ["battery", "battery_and_grid", "grid", "dark", "no_data"];
  const shown = order.filter((s) => s !== "no_data" || day.eveningHours.no_data > 0);
  return (
    <section className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Who served the houses, {clock(day.eveningStartMs)}–24:00
      </p>
      {day.evening.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          The evening window has not started yet.
        </p>
      ) : (
        <>
          <div
            className="mt-2 flex h-6 w-full overflow-hidden rounded-sm bg-background"
            role="img"
            aria-label={shown
              .map((s) => `${SUPPLY[s].label} ${day.eveningHours[s].toFixed(1)} h`)
              .join(", ")}
          >
            {day.evening.map((segment) => (
              <div
                key={segment.startMs}
                className={SUPPLY[segment.supply].swatch}
                style={{ width: `${(100 * (segment.endMs - segment.startMs)) / span}%` }}
                title={`${SUPPLY[segment.supply].label}, ${clock(segment.startMs)}–${clock(segment.endMs)}`}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            {[18, 19, 20, 21, 22, 23, 24].map((hour) => (
              <span key={hour}>{`${hour}:00`}</span>
            ))}
          </div>
        </>
      )}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {shown.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("inline-block size-2.5 rounded-sm", SUPPLY[s].swatch)} />
            {SUPPLY[s].label}{" "}
            <span className="font-mono tabular-nums text-foreground">
              {day.eveningHours[s].toFixed(1)} h
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DailyOperations({ day }: { day: SiteDaySummary }) {
  const clock = useClock(day.timezone);
  const partial = day.readUntilMs < day.dayEndMs;
  const cutCount = day.cuts?.length ?? null;

  return (
    <div className="space-y-4">
      {partial && (
        <p className="text-sm text-muted-foreground">
          Today so far, up to {clock(day.readUntilMs)}.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          label="Solar"
          value={day.solarKwh === null ? NOT_AVAILABLE : <Kwh value={day.solarKwh} />}
          detail={
            day.solarKwh === null
              ? "Needs a solar meter, or an inverter output meter with the battery and grid meter"
              : day.solarEstimated
                ? "≈ inverter output − grid − battery"
                : "Solar meter"
          }
          tone="warn"
        />
        <Stat
          label={`Battery discharged ${clock(day.eveningStartMs)}–24:00`}
          value={
            day.eveningDischargeKwh === null ? NOT_AVAILABLE : <Kwh value={day.eveningDischargeKwh} />
          }
          detail="What the battery supplied in the evening window"
          tone="success"
        />
        <Stat
          label="Power cuts"
          value={
            cutCount === null ? (
              NOT_AVAILABLE
            ) : (
              <span className="font-mono tabular-nums">
                {cutCount} / {formatDuration(day.cutMinutes ?? 0)}
              </span>
            )
          }
          detail={cutCount === null ? "Needs a grid meter" : "Cuts / time without grid power"}
          tone={cutCount ? "warn" : "neutral"}
        />
        <Stat
          label="Lowest battery"
          value={day.lowestSoc ? <Percent value={day.lowestSoc.pct} /> : NOT_AVAILABLE}
          detail={
            day.lowestSoc
              ? `At ${clock(day.lowestSoc.atMs)}${day.lowestSoc.duringCut ? ", in a cut" : ""}`
              : "Needs a battery"
          }
          tone={day.lowestSoc && day.lowestSoc.pct < 15 ? "warn" : "neutral"}
        />
        <Stat
          label="Battery at 17:00"
          value={day.socAtCheckHour === null ? NOT_AVAILABLE : <Percent value={day.socAtCheckHour} />}
          detail={day.socAtCheckHour === null ? "No reading at 17:00" : "Before the evening window"}
        />
        <Stat
          label="Lights on"
          value={day.lightsOnPct === null ? NOT_AVAILABLE : <Percent value={day.lightsOnPct} digits={1} />}
          detail={
            day.darkMinutes > 0
              ? `Dark ${formatDuration(day.darkMinutes)}`
              : "No dark time"
          }
          tone={day.darkMinutes > 0 ? "alert" : "success"}
        />
      </div>

      <section className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Battery level (%)
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-0.5 w-4 bg-success" />
              Battery
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block size-2.5 rounded-sm bg-warning-muted" />
              Power cut
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block size-2.5 rounded-sm bg-foreground/70" />
              Houses dark
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block size-2.5 rounded-sm bg-muted" />
              Evening window
            </li>
          </ul>
        </div>
        {/* On a phone the chart keeps a readable size and scrolls sideways. */}
        <div className="mt-2 overflow-x-auto">
          {day.sources.battery ? (
            <BatteryChart day={day} />
          ) : (
            <p className="text-sm text-muted-foreground">
              No battery is registered on this microgrid.
            </p>
          )}
        </div>
      </section>

      <EveningStrip day={day} />

      {day.noDataMinutes > 0 && (
        <p className="text-xs text-muted-foreground">
          No data for {formatDuration(day.noDataMinutes)} while the grid was on (gateway or
          connection down); that time is not counted as dark.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        A power cut is every grid phase off (below half of nominal over a 5-minute reading). Dark means the gateway went silent during a
        cut: the battery had cut off and the houses had no power. Lights on is the share of the
        day that was not dark, leaving out time with no data. Times are {day.timezone}.
      </p>
    </div>
  );
}

"use client";

import * as React from "react";
import { Currency } from "@/components/format/currency";
import { formatLocalDate } from "@/components/format/local-date";
import { useLocale } from "@/components/format/locale-context";
import type { SavingsColumn, SavingsSummary } from "@/lib/billing/site-savings";
import { cn } from "@/lib/utils";

const NOT_AVAILABLE = "—";

/** Calendar days are `YYYY-MM-DD` keys, so they are formatted at UTC midnight in UTC. */
function useDayFormat() {
  const { locale } = useLocale();
  return React.useCallback(
    (dateKey: string, opts: Intl.DateTimeFormatOptions) =>
      formatLocalDate(new Date(`${dateKey}T00:00:00Z`), locale, { ...opts, timeZone: "UTC" }),
    [locale]
  );
}

const SHORT_DAY = { day: "numeric", month: "short" } as const;
const FULL_DAY = { day: "numeric", month: "short", year: "numeric" } as const;

function Money({ value, bold }: { value: number | null; bold?: boolean }) {
  if (value === null) return <span className="text-muted-foreground">{NOT_AVAILABLE}</span>;
  return <Currency value={value} className={cn(bold && "font-semibold text-foreground")} />;
}

function Percent({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">{NOT_AVAILABLE}</span>;
  return <span className="font-mono tabular-nums">{value.toFixed(1)}%</span>;
}

type Row = {
  key: string;
  label: string;
  sub?: string;
  bold?: boolean;
  cell: (column: SavingsColumn) => React.ReactNode;
};

/**
 * Money the site's solar and battery saved against the grid tariff, for the
 * day, its month so far, and since the savings were first counted.
 */
export function SavingsTable({
  summary,
  date,
  solarFrom,
  arbitrageFrom,
  cappedFrom = null,
  solarEstimated = false,
}: {
  summary: SavingsSummary;
  /** The day shown, `YYYY-MM-DD`. */
  date: string;
  /** The savings settings' start dates; null when that saving is not counted. */
  solarFrom: string | null;
  arbitrageFrom: string | null;
  /** First day read when the range was cut short; null when it was not. */
  cappedFrom?: string | null;
  /** True when any day's solar is estimated from the balance rather than metered. */
  solarEstimated?: boolean;
}) {
  const formatDay = useDayFormat();
  const { columns, sinceStartDate, missingTariffDays } = summary;

  const rows: Row[] = [
    {
      key: "solar",
      label: "Solar savings ≈",
      sub: solarFrom
        ? `valued at the grid rate of each hour, since ${formatDay(solarFrom, FULL_DAY)}`
        : "not counted: no start date set",
      cell: (c) => <Money value={c.solarSavings} />,
    },
    {
      key: "arbitrage",
      label: "Arbitrage gain ≈",
      sub: arbitrageFrom
        ? `since ${formatDay(arbitrageFrom, FULL_DAY)}`
        : "not counted: no start date set",
      cell: (c) => <Money value={c.arbitrageGain} />,
    },
    {
      key: "total",
      label: "Total saved",
      bold: true,
      cell: (c) => <Money value={c.total} bold />,
    },
    {
      key: "lights",
      label: "Lights on (%)",
      cell: (c) => <Percent value={c.lightsOnPct} />,
    },
  ];

  const headers: { key: keyof SavingsSummary["columns"]; label: string; sub?: string }[] = [
    { key: "day", label: formatDay(date, SHORT_DAY) },
    { key: "month", label: `${formatDay(date, { month: "long" })} so far` },
    {
      key: "sinceStart",
      label: "Since start",
      sub: sinceStartDate ? `from ${formatDay(sinceStartDate, FULL_DAY)}` : undefined,
    },
  ];

  return (
    <section
      aria-labelledby="savings-heading"
      className="rounded-lg border border-border bg-card p-4 sm:p-6"
    >
      <h2 id="savings-heading" className="text-base font-semibold text-foreground">
        What the site saved
      </h2>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="pb-2 pr-4 font-medium text-muted-foreground">
                <span className="sr-only">Figure</span>
              </th>
              {headers.map((h) => (
                <th
                  key={h.key}
                  scope="col"
                  className="pb-2 pl-4 text-right align-bottom font-medium text-muted-foreground"
                >
                  <span className="block">{h.label}</span>
                  {h.sub && <span className="block text-xs font-normal">{h.sub}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className={cn("border-b border-border last:border-0", row.bold && "bg-muted")}
              >
                <th
                  scope="row"
                  className={cn(
                    "py-2 pr-4 text-left align-top font-normal text-foreground",
                    row.bold && "font-semibold"
                  )}
                >
                  <span className="block">{row.label}</span>
                  {row.sub && (
                    <span className="block text-xs text-muted-foreground">{row.sub}</span>
                  )}
                </th>
                {headers.map((h) => (
                  <td key={h.key} className="py-2 pl-4 text-right align-top">
                    {row.cell(columns[h.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(missingTariffDays > 0 || cappedFrom) && (
        <ul className="mt-3 space-y-1 text-xs text-warning-fg">
          {missingTariffDays > 0 && (
            <li>
              {missingTariffDays === 1 ? "1 day" : `${missingTariffDays} days`} had no grid tariff
              in force and {missingTariffDays === 1 ? "is" : "are"} left out of the money figures.
            </li>
          )}
          {cappedFrom && (
            <li>
              Since start covers at most a year: days before {formatDay(cappedFrom, FULL_DAY)} are
              not read.
            </li>
          )}
        </ul>
      )}

      <div className="mt-4 space-y-1 text-xs text-muted-foreground">
        <p>
          <strong className="font-medium">Solar savings</strong> is every kWh of solar the site
          produced, priced at what the grid would have charged for it at that hour
          {solarEstimated ? " (solar is estimated from the load, grid and battery where there is no solar meter)" : ""}
          .
        </p>
        <p>
          <strong className="font-medium">Arbitrage gain</strong> is the battery charging when
          power is cheap and discharging when it is dear: each kWh it gave out while the grid was
          on, at that hour&apos;s rate, less what it cost to put in, allowing for the energy the
          battery loses. Power the battery gave during a cut is backup and is not counted. A day
          with too few battery readings is left out.
        </p>
        <p>
          Solar that charged the battery appears in both lines, as a saving and as a charging
          cost, so the <strong className="font-medium">total</strong> is the figure to rely on.
          <strong className="font-medium"> Lights on</strong> is the share of the time with a known
          state that the houses had power.
        </p>
      </div>
    </section>
  );
}

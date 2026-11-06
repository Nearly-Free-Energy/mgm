"use client";

import Link from "next/link";
import { formatLocalDate } from "@/components/format/local-date";
import { useLocale } from "@/components/format/locale-context";
import { addDaysToDateKey } from "@/lib/timezone/day-key";
import { cn } from "@/lib/utils";

const linkClass =
  "rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground hover:bg-muted";

/**
 * Day switcher for the operations view. `date` and `today` are calendar days
 * in the microgrid's timezone; days after `today` are not offered. The date
 * box is a plain GET form, so typing a date does not navigate until it is
 * submitted, and the server clamps whatever arrives.
 */
export function DayPicker({
  basePath,
  date,
  today,
}: {
  basePath: string;
  date: string;
  today: string;
}) {
  const { locale } = useLocale();
  const previous = addDaysToDateKey(date, -1);
  const next = addDaysToDateKey(date, 1);
  const label = formatLocalDate(new Date(`${date}T12:00:00Z`), locale, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="mr-2 text-lg font-semibold text-foreground">{label}</h2>
      <Link href={`${basePath}?date=${previous}`} className={linkClass} aria-label="Previous day">
        ←
      </Link>
      {next <= today ? (
        <Link href={`${basePath}?date=${next}`} className={linkClass} aria-label="Next day">
          →
        </Link>
      ) : (
        <span aria-hidden="true" className={cn(linkClass, "pointer-events-none opacity-40")}>
          →
        </span>
      )}
      <form action={basePath} method="get" className="flex items-center gap-2">
        <input
          key={date}
          type="date"
          name="date"
          aria-label="Day"
          className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground"
          defaultValue={date}
          max={today}
          required
        />
        <button type="submit" className={linkClass}>
          Show
        </button>
      </form>
      {date !== today && (
        <Link href={`${basePath}?date=${today}`} className={linkClass}>
          Today
        </Link>
      )}
    </div>
  );
}

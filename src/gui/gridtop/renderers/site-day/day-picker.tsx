"use client";

/**
 * The day switcher: the day as the heading, then Previous, Next, a date box
 * and Today. Previous, Next and Today are the model's own links, so the
 * server decides which days are offered; Next is a disabled placeholder on
 * today. Typing a date does nothing until it is submitted, and a submitted
 * date after today is refused here as well as clamped by the server.
 * Submitting the day already shown reads it again, which is how today's
 * partial day is brought up to date, as the legacy GET form did.
 */
import { useState, type FormEvent } from "react";
import type { GuiKit, Href, LinkRef } from "@/lib/gui/contract";
import { DATE, type SiteDayExt, cls } from "./ext";

/** The link ids this picker places; the renderer leaves them out of its other links. */
export const DAY_LINKS = ["metering.day-previous", "metering.day-next", "metering.day-today"];

// At least 44 px square on a touch screen.
const STEP =
  "gt:inline-flex gt:h-8 gt:min-w-8 gt:items-center gt:justify-center gt:rounded-md gt:border gt:border-border gt:bg-card gt:px-2.5 " +
  "gt:text-dense gt:text-foreground gt:hover:bg-muted gt:pointer-coarse:h-11 gt:pointer-coarse:min-w-11 " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

const pageHref = (link: LinkRef | undefined): Href | null =>
  link && link.href.startsWith("/") ? (link.href as Href) : null;

function Step({ link, glyph, kit }: { link: LinkRef | undefined; glyph: string; kit: GuiKit }) {
  const href = pageHref(link);
  if (!link || !href) {
    return (
      <span aria-hidden="true" className={cls(STEP, "gt:pointer-events-none gt:opacity-40")}>
        {glyph}
      </span>
    );
  }
  return (
    <kit.Link href={href} className={STEP}>
      <span aria-hidden="true">{glyph}</span>
      <span className="gt:sr-only">{link.label}</span>
    </kit.Link>
  );
}

export function DayPicker({ ext, links, heading, kit }: { ext: SiteDayExt; links: LinkRef[]; heading: string; kit: GuiKit }) {
  const [error, setError] = useState<string | null>(null);
  const find = (id: string) => links.find((l) => l.id === id);
  const today = find("metering.day-today");
  const todayHref = pageHref(today);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const day = new FormData(event.currentTarget).get("date");
    if (typeof day !== "string" || !DATE.test(day) || day > ext.today) {
      setError("Choose a day up to today.");
      return;
    }
    setError(null);
    if (day === ext.date) {
      kit.refresh();
      return;
    }
    kit.navigate(`${ext.dayHref}?date=${day}` as Href);
  };

  return (
    <div className="gt:flex gt:flex-col gt:gap-1">
      <div className="gt:flex gt:flex-wrap gt:items-center gt:gap-2">
        <h2 className="gt:mr-2 gt:text-title gt:font-semibold gt:text-foreground">{heading}</h2>
        <Step link={find("metering.day-previous")} glyph="←" kit={kit} />
        <Step link={find("metering.day-next")} glyph="→" kit={kit} />
        <form onSubmit={onSubmit} className="gt:flex gt:items-center gt:gap-2">
          <input
            key={ext.date}
            type="date"
            name="date"
            aria-label="Day"
            defaultValue={ext.date}
            max={ext.today}
            required
            aria-invalid={error ? true : undefined}
            className="gt:h-8 gt:rounded-md gt:border gt:border-border gt:bg-card gt:px-2 gt:text-dense gt:text-foreground gt:pointer-coarse:h-11"
          />
          <button type="submit" className={STEP}>
            Show
          </button>
        </form>
        {today && todayHref && (
          <kit.Link href={todayHref} className={STEP}>
            {today.label}
          </kit.Link>
        )}
      </div>
      {error && (
        <p role="status" className="gt:text-caption gt:text-destructive-fg">
          {error}
        </p>
      )}
    </div>
  );
}

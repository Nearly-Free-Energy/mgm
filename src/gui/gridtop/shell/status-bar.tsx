/**
 * The status bar along the bottom of a wide and tall window (from 1280 px
 * wide and 800 px tall): the organization, its time zone and the time there,
 * Gridtop's version and the MGM release.
 *
 * The clock starts from the manifest's server time, so it is right on a
 * device whose clock is wrong, and the first render matches the server's.
 */
import { useEffect, useState } from "react";
import { kit } from "@/lib/gui/kit";
import { GRIDTOP_META } from "../meta";

/** How often the clock moves on. It shows minutes, so a quarter of one is close enough. */
const TICK_MS = 15_000;

/**
 * Hours and minutes in `zone`; in UTC when the zone or locale is one this
 * browser does not know.
 *
 * An exception to design rule 2 (CLAUDE.md): it calls Intl itself, because
 * the clock moves on in the browser, so the server cannot format it, and the
 * kit has no time formatter. If the kit gains one, use it here.
 */
export function clockText(ms: number, locale: string, zone: string): { text: string; zone: string } {
  const opts = { hour: "2-digit", minute: "2-digit" } as const;
  if (!Number.isFinite(ms)) return { text: "", zone };
  try {
    return { text: new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone }).format(ms), zone };
  } catch {
    return { text: new Date(ms).toISOString().slice(11, 16), zone: "UTC" };
  }
}

/** The server's time now: manifest.now, moved on by the device's clock since it arrived. */
function useServerTime(now: string): number {
  const [tick, setTick] = useState<{ from: string; ms: number } | null>(null);
  useEffect(() => {
    const server = Date.parse(now);
    const began = Date.now();
    const id = setInterval(() => setTick({ from: now, ms: server + Date.now() - began }), TICK_MS);
    return () => clearInterval(id);
  }, [now]);
  return tick?.from === now ? tick.ms : Date.parse(now);
}

export function StatusBar() {
  const { org, locale, now, release } = kit.useManifest();
  const ms = useServerTime(now);
  // An organization whose microgrids share no time zone has none (OrgManifest.timezone).
  const clock = clockText(ms, locale, org.timezone ?? "UTC");
  const iso = Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  return (
    <footer
      aria-label="Status bar"
      className="gt:col-span-full gt:hidden gt:h-7 gt:min-w-0 gt:items-center gt:gap-4 gt:border-t gt:border-border gt:bg-card gt:px-3 gt:text-caption gt:text-muted-foreground gt:expanded:tall:flex"
    >
      <span className="gt:truncate gt:text-foreground">{org.name}</span>
      <span className="gt:shrink-0">
        {clock.zone} <time dateTime={iso}>{clock.text}</time>
      </span>
      <span className="gt:ms-auto gt:shrink-0">
        {GRIDTOP_META.title} {GRIDTOP_META.version}
      </span>
      {release && <span className="gt:shrink-0">MGM {release}</span>}
    </footer>
  );
}

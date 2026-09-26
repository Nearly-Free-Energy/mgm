/**
 * wall-clock.ts — interpret a `datetime-local` wall-clock value in an
 * explicit IANA zone (issue #4).
 *
 * A `datetime-local` input carries no offset; `new Date(value)` silently
 * adopts the *browser* zone. For an operator whose browser differs from the
 * microgrid zone, that shifts billing-period boundaries by hours — e.g.
 * midnight Africa/Kampala entered from a UTC browser stores 00:00Z instead
 * of 21:00Z the prior day, and boundary-exact checks (review seeds) then
 * reject it while the UI hides the CTA because a reading exists.
 *
 * `zonedDateTimeToUtcIso` resolves the wall clock in the given zone via an
 * Intl round-trip: guess the instant, read back what wall clock that
 * instant shows in the zone, and correct by the difference (two passes
 * converge across DST transitions for real zones).
 *
 * Returns null for malformed input or unknown zones.
 */
export function zonedDateTimeToUtcIso(
  local: string,
  timeZone: string
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    local.trim()
  );
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  // The seconds group is optional — distinguish "absent" from "zero"
  // explicitly instead of Number(undefined), which is NaN (not nullish)
  // and would poison every downstream Date.UTC call.
  const s = match[6] === undefined ? 0 : Number(match[6]);
  if (
    mo < 1 || mo > 12 || d < 1 || d > 31 ||
    h > 23 || mi > 59 || (s !== undefined && s > 59)
  ) {
    return null;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    // Throws for unknown zones on first use below; probe eagerly so the
    // null contract holds instead of depending on call order.
    formatter.format(new Date(0));
  } catch {
    return null;
  }

  // Part order follows the locale (en-US emits month first), so pick by
  // type, never by position.
  const wanted = ["year", "month", "day", "hour", "minute", "second"] as const;
  const parts = (date: Date): number[] => {
    const byType = new Map(
      formatter
        .formatToParts(date)
        .filter((p) => (wanted as readonly string[]).includes(p.type))
        .map((p) => [p.type, Number(p.value)] as const)
    );
    return wanted.map((type) => byType.get(type) ?? NaN);
  };

  // Treat the wall clock as UTC, then correct by the zone's offset at that
  // instant: offset = (wall clock shown at guess) − guess. Three passes
  // absorb DST transitions; verification below rejects nonexistent
  // gap times.
  const targetAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = targetAsUtc;
  for (let i = 0; i < 3; i++) {
    const [py, pmo, pd, ph, pmi, ps] = parts(new Date(guess));
    const shownAsUtc = Date.UTC(py, pmo - 1, pd, ph, pmi, ps);
    guess = targetAsUtc - (shownAsUtc - guess);
  }
  // Verify convergence: the resolved instant must show the requested wall
  // clock in the zone (guards nonexistent DST-gap times).
  const [fy, fmo, fd, fh, fmi, fs] = parts(new Date(guess));
  if (
    fy !== y || fmo !== mo || fd !== d ||
    fh !== h || fmi !== mi || fs !== s
  ) {
    return null;
  }
  return new Date(guess).toISOString();
}

/**
 * The time zone nudge as plain text: shown when a microgrid's address
 * implies a zone other than UTC while its billing timezone is still UTC
 * (impliedNonUtcZone in ./shortlist.ts). The microgrid shell's banner
 * (src/components/forms/TimezoneNudge.tsx) and the views that repeat its
 * warning, such as the Operations day, print this copy, so they cannot say
 * different things.
 *
 * Pure: no React, no clock. `referenceDate` sets the UTC offset printed
 * beside each zone, and defaults to now as formatTimezone's does.
 */
import { formatTimezone } from "@/components/format/timezone";
import { impliedNonUtcZone, type ShortlistInput } from "./shortlist";

export type TimezoneNudgeCopy = { title: string; text: string };

/** The nudge's title and text, or null when there is nothing to nudge about. */
export function timezoneNudge(
  microgrid: ShortlistInput & { timezone?: string | null },
  referenceDate?: Date,
): TimezoneNudgeCopy | null {
  const implied = impliedNonUtcZone(microgrid);
  if (!implied) return null;
  const zone = formatTimezone(implied, referenceDate);
  const country = microgrid.address_country?.trim();
  const where = country ? `is in ${country} (${zone})` : `suggests ${zone}`;
  // impliedNonUtcZone reads a missing zone as UTC, so this prints UTC for it too.
  const current = formatTimezone(microgrid.timezone ?? "UTC", referenceDate);
  return {
    title: "Billing timezone is still UTC",
    text: `This microgrid's address ${where} but its billing timezone is ${current} — set it? Billing days currently start and end at midnight UTC.`,
  };
}

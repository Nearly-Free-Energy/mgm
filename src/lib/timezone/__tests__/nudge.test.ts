/**
 * The time zone nudge's copy: shown exactly when impliedNonUtcZone finds a
 * zone, naming the address's country when there is one.
 */
import { describe, expect, it } from "vitest";
import { timezoneNudge } from "../nudge";
import { impliedNonUtcZone } from "../shortlist";

const NOV = new Date("2026-11-06T00:00:00Z");

describe("timezoneNudge", () => {
  it("names the zone the longitude suggests when there is no country", () => {
    expect(timezoneNudge({ lng: 32.6, timezone: "UTC" }, NOV)).toEqual({
      title: "Billing timezone is still UTC",
      text: "This microgrid's address suggests Africa/Blantyre (UTC+2) but its billing timezone is UTC — set it? Billing days currently start and end at midnight UTC.",
    });
  });

  it("names the trimmed country beside the zone", () => {
    expect(timezoneNudge({ address_country: "  Atlantis ", lng: 32.6, timezone: "UTC" }, NOV)?.text).toBe(
      "This microgrid's address is in Atlantis (Africa/Blantyre (UTC+2)) but its billing timezone is UTC — set it? Billing days currently start and end at midnight UTC.",
    );
  });

  it("reads a missing zone as UTC, as impliedNonUtcZone does", () => {
    expect(timezoneNudge({ lng: 32.6, timezone: null }, NOV)?.text).toContain("its billing timezone is UTC —");
  });

  it.each([
    ["a zone already set", { lng: 32.6, timezone: "Africa/Blantyre" }],
    ["no address", { timezone: "UTC" }],
    ["an address at UTC+0", { lng: 0, timezone: "UTC" }],
  ])("says nothing for %s", (_, microgrid) => {
    expect(impliedNonUtcZone(microgrid)).toBeNull();
    expect(timezoneNudge(microgrid, NOV)).toBeNull();
  });
});

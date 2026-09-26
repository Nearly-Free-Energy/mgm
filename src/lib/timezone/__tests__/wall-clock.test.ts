import { describe, expect, it } from "vitest";
import { zonedDateTimeToUtcIso } from "../wall-clock";

describe("zonedDateTimeToUtcIso", () => {
  it("resolves Kampala midnight to 21:00Z the prior day", () => {
    expect(zonedDateTimeToUtcIso("2026-09-01T00:00", "Africa/Kampala")).toBe(
      "2026-08-31T21:00:00.000Z"
    );
  });

  it("is identity for UTC", () => {
    expect(zonedDateTimeToUtcIso("2026-09-01T12:30", "UTC")).toBe(
      "2026-09-01T12:30:00.000Z"
    );
  });

  it("handles DST zones (Berlin summer is +2)", () => {
    expect(zonedDateTimeToUtcIso("2026-07-01T12:00", "Europe/Berlin")).toBe(
      "2026-07-01T10:00:00.000Z"
    );
  });

  it("handles DST zones (Berlin winter is +1)", () => {
    expect(zonedDateTimeToUtcIso("2026-01-01T12:00", "Europe/Berlin")).toBe(
      "2026-01-01T11:00:00.000Z"
    );
  });

  it("rejects nonexistent DST-gap wall times", () => {
    // 2026-03-08 02:30 never occurs in America/New_York (spring forward).
    expect(
      zonedDateTimeToUtcIso("2026-03-08T02:30", "America/New_York")
    ).toBeNull();
  });

  it("rejects unknown zones and malformed input", () => {
    expect(zonedDateTimeToUtcIso("2026-09-01T00:00", "Mars/OlympusMons")).toBeNull();
    expect(zonedDateTimeToUtcIso("not-a-date", "Africa/Kampala")).toBeNull();
    expect(zonedDateTimeToUtcIso("2026-13-01T00:00", "UTC")).toBeNull();
    expect(zonedDateTimeToUtcIso("", "UTC")).toBeNull();
  });

  it("accepts optional seconds", () => {
    expect(zonedDateTimeToUtcIso("2026-09-01T00:00:45", "UTC")).toBe(
      "2026-09-01T00:00:45.000Z"
    );
  });
});

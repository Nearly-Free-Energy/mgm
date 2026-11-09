import { afterEach, describe, expect, it, vi } from "vitest";
import {
  meteringFixturesEnabled,
  readMeteringFixtures,
  validateMeteringFixturesAtStartup,
} from "../metering-fixtures";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readMeteringFixtures", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    ["  ", "off"],
    ["0", "off"],
    ["false", "off"],
    ["OFF", "off"],
    ["1", "on"],
    ["true", "on"],
    ["On", "on"],
    [" on\n", "on"],
    ["yes", "invalid"],
    ["2", "invalid"],
    ["sk_live_secret", "invalid"],
  ])("reads %j as %s", (value, expected) => {
    expect(readMeteringFixtures({ MGM_METERING_FIXTURES: value })).toBe(expected);
  });

  it("treats an invalid value as off", () => {
    expect(meteringFixturesEnabled({ MGM_METERING_FIXTURES: "yes" })).toBe(false);
    expect(meteringFixturesEnabled({ MGM_METERING_FIXTURES: "on" })).toBe(true);
    expect(meteringFixturesEnabled({})).toBe(false);
  });

  it("reads process.env when called without an argument", () => {
    vi.stubEnv("MGM_METERING_FIXTURES", "1");
    expect(meteringFixturesEnabled()).toBe(true);
    vi.stubEnv("MGM_METERING_FIXTURES", "");
    expect(meteringFixturesEnabled()).toBe(false);
  });
});

describe("validateMeteringFixturesAtStartup", () => {
  it("logs an invalid value naming the variable, never the value, and does not throw", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      validateMeteringFixturesAtStartup({ MGM_METERING_FIXTURES: "sk_live_secret" })
    ).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0][0]);
    expect(logged).toBe(
      "[mgm] MGM_METERING_FIXTURES must be on or off; synthetic site data stays off."
    );
    expect(logged).not.toContain("sk_live_secret");
  });

  it("warns once when it is on and says nothing when it is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    validateMeteringFixturesAtStartup({});
    validateMeteringFixturesAtStartup({ MGM_METERING_FIXTURES: "off" });
    expect(warn).not.toHaveBeenCalled();
    validateMeteringFixturesAtStartup({ MGM_METERING_FIXTURES: "on" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/MGM_METERING_FIXTURES is on/);
    expect(error).not.toHaveBeenCalled();
  });
});

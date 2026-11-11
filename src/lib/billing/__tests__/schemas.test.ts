import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ADD_GRID_TARIFF_BODY_VERSION,
  AddGridTariffBody,
  SAVE_SAVINGS_SETTINGS_BODY_VERSION,
  SaveSavingsSettingsBody,
} from "../schemas";
import { validateGridTariffBands } from "../site-savings";
import { isCalendarDateKey } from "@/lib/timezone/day-key";

const BANDS = [
  { from_hour: 0, to_hour: 6, rate: 400 },
  { from_hour: 6, to_hour: 18, rate: 550 },
  { from_hour: 18, to_hour: 24, rate: 650 },
];
const TARIFF = { effective_from: "2026-10-01", bands: BANDS };
const SETTINGS = { solar_savings_from: "2026-09-01", arbitrage_from: null, round_trip_efficiency: 0.9 };

/** The first issue as the route answers it: its top-level key and message. */
function firstIssue(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return "ok";
  const issue = parsed.error.issues[0];
  return { field: typeof issue.path[0] === "string" ? issue.path[0] : undefined, message: issue.message };
}

describe("AddGridTariffBody", () => {
  it("accepts bands in any order", () => {
    expect(firstIssue(AddGridTariffBody, { ...TARIFF, bands: [BANDS[2], BANDS[0], BANDS[1]] })).toBe("ok");
  });

  it.each([
    ["a gap", [{ from_hour: 0, to_hour: 6, rate: 1 }, { from_hour: 7, to_hour: 24, rate: 1 }], "No band covers hour 6."],
    ["a short day", [{ from_hour: 0, to_hour: 18, rate: 1 }], "No band covers hour 18."],
    ["an overlap", [{ from_hour: 0, to_hour: 12, rate: 1 }, { from_hour: 6, to_hour: 24, rate: 1 }], "Bands overlap at hour 6."],
    ["from at or after to", [{ from_hour: 6, to_hour: 6, rate: 1 }], "Each band must start before it ends, between hour 0 and hour 24."],
    ["a fractional hour", [{ from_hour: 0, to_hour: 23.5, rate: 1 }], "Band hours must be whole hours."],
    ["a negative rate", [{ from_hour: 0, to_hour: 24, rate: -1 }], "Each band's rate must be a number of 0 or more."],
    ["a string rate", [{ from_hour: 0, to_hour: 24, rate: "400" }], "Each band's rate must be a number of 0 or more."],
    ["a start before hour 0", [{ from_hour: -1, to_hour: 24, rate: 1 }], "Each band must start before it ends, between hour 0 and hour 24."],
    ["a start at hour 24", [{ from_hour: 24, to_hour: 24, rate: 1 }], "Each band must start before it ends, between hour 0 and hour 24."],
    ["an end at hour 0", [{ from_hour: 0, to_hour: 0, rate: 1 }], "Each band must start before it ends, between hour 0 and hour 24."],
    ["an end after hour 24", [{ from_hour: 0, to_hour: 25, rate: 1 }], "Each band must start before it ends, between hour 0 and hour 24."],
    ["no bands", [], "A tariff needs between 1 and 24 bands."],
    ["25 bands", Array.from({ length: 25 }, () => ({ from_hour: 0, to_hour: 24, rate: 1 })), "A tariff needs between 1 and 24 bands."],
    ["not a list", { from_hour: 0, to_hour: 24, rate: 400 }, "Bands must be a list."],
    ["a band with an extra key", [{ from_hour: 0, to_hour: 24, rate: 1, x: 1 }], "Each band needs a start hour, an end hour and a rate."],
  ])("refuses %s under bands", (_label, bands, message) => {
    expect(firstIssue(AddGridTariffBody, { ...TARIFF, bands })).toEqual({ field: "bands", message });
  });

  it.each([undefined, "October", "2026-02-30", "2026-10-01T00:00:00Z", "0000-01-01"])(
    "refuses effective_from %s",
    (effective_from) => {
      expect(firstIssue(AddGridTariffBody, { ...TARIFF, effective_from })).toEqual({
        field: "effective_from",
        message: "effective_from must be a date (YYYY-MM-DD)",
      });
    }
  );

  it("refuses an unknown top-level key, and a body that is not an object, with no field", () => {
    expect(firstIssue(AddGridTariffBody, { ...TARIFF, microgrid_id: "x" })).toEqual({
      field: undefined,
      message: "Unknown field: microgrid_id",
    });
    for (const body of [[TARIFF], null, "text"]) {
      expect(firstIssue(AddGridTariffBody, body)).toEqual({
        field: undefined,
        message: "Request body must be an object",
      });
    }
  });
});

describe("SaveSavingsSettingsBody", () => {
  it.each([
    ["null dates and an efficiency of 1", { solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: 1 }],
    ["the smallest efficiency that keeps a digit", { ...SETTINGS, round_trip_efficiency: 0.0005 }],
    ["a typical body", SETTINGS],
  ])("accepts %s", (_label, body) => {
    expect(firstIssue(SaveSavingsSettingsBody, body)).toBe("ok");
  });

  it.each([0, -0.5, 1.001, 0.0004, 1.0004, "0.9", null, undefined])(
    "refuses round_trip_efficiency %s",
    (round_trip_efficiency) => {
      const body: Record<string, unknown> = { ...SETTINGS, round_trip_efficiency };
      if (round_trip_efficiency === undefined) delete body.round_trip_efficiency;
      expect(firstIssue(SaveSavingsSettingsBody, body)).toEqual({
        field: "round_trip_efficiency",
        message: "round_trip_efficiency must be a number greater than 0 and at most 1",
      });
    }
  );

  it.each([
    ["solar_savings_from", "September"],
    ["solar_savings_from", undefined],
    ["arbitrage_from", "2026-02-29"],
    ["arbitrage_from", 20260901],
  ])("refuses %s %s under its own field", (field, value) => {
    const body: Record<string, unknown> = { ...SETTINGS, [field]: value };
    if (value === undefined) delete body[field];
    expect(firstIssue(SaveSavingsSettingsBody, body)).toEqual({
      field,
      message: `${field} must be a date (YYYY-MM-DD) or null`,
    });
  });

  it("refuses unknown keys with no field", () => {
    expect(firstIssue(SaveSavingsSettingsBody, { ...SETTINGS, microgrid_id: "x", extra: true })).toEqual({
      field: undefined,
      message: "Unknown field: microgrid_id, extra",
    });
  });
});

describe("agreement with the pure validators", () => {
  it("accepts exactly the bands validateGridTariffBands accepts", () => {
    // A seeded generator, so a failure names a case that can be replayed.
    let seed = 20261111;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const RATES = [-1, 0, 1.5];
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 20_000; i++) {
      const count = 1 + next(3);
      const bands = Array.from({ length: count }, () => ({
        from_hour: next(25),
        to_hour: next(25),
        rate: RATES[next(3)],
      }));
      // Half the cases are cut points that cover the day, so both answers occur often.
      if (i % 2 === 0) {
        const cuts = [0, ...Array.from({ length: count - 1 }, () => 1 + next(23)).sort((a, b) => a - b), 24];
        bands.forEach((band, k) => {
          band.from_hour = cuts[k];
          band.to_hour = cuts[k + 1];
        });
      }
      const expected = validateGridTariffBands(bands).ok;
      expect(AddGridTariffBody.shape.bands.safeParse(bands).success, JSON.stringify(bands)).toBe(expected);
      if (expected) accepted++;
      else refused++;
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });

  it("answers a body with one fault with validateGridTariffBands' message", () => {
    // With several faults zod and the validator can report different ones
    // first; that ordering is not part of the contract.
    let seed = 20261112;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const HOUR_VALUES: unknown[] = [-1, 0, 1, 6, 12, 18, 23, 24, 25, 1.5, null];
    const RATE_VALUES: unknown[] = [-1, 0, 1.5, null, "1"];
    const faults = (band: { from_hour: unknown; to_hour: unknown; rate: unknown }) => {
      const { from_hour: from, to_hour: to, rate } = band;
      const whole = (h: unknown): h is number => Number.isInteger(h);
      let n = 0;
      if (!whole(from) || !whole(to)) n++;
      if (
        (whole(from) && (from < 0 || from > 23)) ||
        (whole(to) && (to < 1 || to > 24)) ||
        (whole(from) && whole(to) && from >= to)
      ) {
        n++;
      }
      if (typeof rate !== "number" || rate < 0) n++;
      return n;
    };
    let compared = 0;
    for (let i = 0; i < 20_000; i++) {
      const count = next(4);
      const cuts = [0, ...Array.from({ length: Math.max(count - 1, 0) }, () => 1 + next(23)).sort((a, b) => a - b), 24];
      const bands = Array.from({ length: count }, (_, k) => ({ from_hour: cuts[k] as unknown, to_hour: cuts[k + 1] as unknown, rate: 1 as unknown }));
      // Break at most two values, so single faults are common.
      for (let f = next(3); f > 0 && count > 0; f--) {
        const band = bands[next(count)];
        const key = (["from_hour", "to_hour", "rate"] as const)[next(3)];
        band[key] = key === "rate" ? RATE_VALUES[next(RATE_VALUES.length)] : HOUR_VALUES[next(HOUR_VALUES.length)];
      }
      const total = (count === 0 ? 1 : 0) + bands.reduce((sum, band) => sum + faults(band), 0);
      if (total > 1) continue;
      const checked = validateGridTariffBands(bands);
      const expected = checked.ok ? "ok" : { field: "bands", message: checked.message };
      expect(firstIssue(AddGridTariffBody, { ...TARIFF, bands }), JSON.stringify(bands)).toEqual(expected);
      compared++;
    }
    expect(compared).toBeGreaterThan(5000);
  });

  it("accepts exactly the dates isCalendarDateKey accepts", () => {
    const pad = (n: number, width: number) => String(n).padStart(width, "0");
    const keys = ["", "2026-1-01", "2026-01-1", "20260101", "2026/01/01", " 2026-01-01", "2026-01-01 "];
    for (const year of [0, 4, 50, 99, 100, 1900, 2000, 2023, 2024, 2100, 9999]) {
      for (let month = 0; month <= 13; month++) {
        for (let day = 0; day <= 32; day++) keys.push(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`);
      }
    }
    const day = AddGridTariffBody.shape.effective_from;
    let accepted = 0;
    for (const key of keys) {
      const expected = isCalendarDateKey(key);
      expect(day.safeParse(key).success, key).toBe(expected);
      if (expected) accepted++;
    }
    // Leap days, and the 0000-0099 years zod's format alone would accept.
    expect(day.safeParse("2024-02-29").success).toBe(true);
    expect(day.safeParse("2100-02-29").success).toBe(false);
    expect(day.safeParse("0004-02-29").success).toBe(false);
    expect(accepted).toBeGreaterThan(2000);
  });
});

// The JSON Schema a form reads, per input version. A change to either schema
// that alters its JSON Schema needs a new version: bump the constant in
// schemas.ts and add the new shape here, keeping the old one.
const DATE = {
  type: "string",
  format: "date",
  pattern:
    "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
};
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

const ADD_GRID_TARIFF_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      effective_from: { ...DATE, title: "Effective from" },
      bands: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: {
          type: "object",
          properties: {
            from_hour: { type: "integer", minimum: 0, maximum: 23, title: "From hour" },
            to_hour: { type: "integer", minimum: 1, maximum: 24, title: "To hour" },
            rate: { type: "number", minimum: 0, title: "Rate per kWh" },
          },
          required: ["from_hour", "to_hour", "rate"],
          additionalProperties: false,
        },
        title: "Bands",
      },
    },
    required: ["effective_from", "bands"],
    additionalProperties: false,
  },
};

const SAVE_SAVINGS_SETTINGS_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      solar_savings_from: { anyOf: [DATE, { type: "null" }], title: "Count solar savings from" },
      arbitrage_from: { anyOf: [DATE, { type: "null" }], title: "Count battery arbitrage from" },
      round_trip_efficiency: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: 1,
        title: "Battery round-trip efficiency",
        description: "A fraction: 0.9 is 90%.",
      },
    },
    required: ["solar_savings_from", "arbitrage_from", "round_trip_efficiency"],
    additionalProperties: false,
  },
};

describe("pinned input versions", () => {
  it.each([
    ["AddGridTariffBody", AddGridTariffBody, ADD_GRID_TARIFF_BODY_VERSION, ADD_GRID_TARIFF_SHAPES, "ADD_GRID_TARIFF_BODY_VERSION"],
    ["SaveSavingsSettingsBody", SaveSavingsSettingsBody, SAVE_SAVINGS_SETTINGS_BODY_VERSION, SAVE_SAVINGS_SETTINGS_SHAPES, "SAVE_SAVINGS_SETTINGS_BODY_VERSION"],
  ] as const)("%s matches the shape pinned for its version", (_name, schema, version, shapes, constant) => {
    expect(
      z.toJSONSchema(schema, { io: "input" }),
      `The JSON Schema changed: bump ${constant} in src/lib/billing/schemas.ts and pin the new shape in this file.`
    ).toEqual(shapes[version]);
  });

  it("starts both versions at 1", () => {
    expect(ADD_GRID_TARIFF_BODY_VERSION).toBe(1);
    expect(SAVE_SAVINGS_SETTINGS_BODY_VERSION).toBe(1);
  });
});

/**
 * The Organization API (v1) body schemas. These routes serve the external
 * customer app, so their messages are the routes' messages from before they
 * parsed with a schema, and unknown keys are dropped rather than refused.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  V1_CREATE_BILLING_PERIOD_BODY_VERSION,
  V1_GENERATE_BODY_VERSION,
  V1CreateBillingPeriodBody,
  V1GenerateBody,
  V1ManualReadingBody,
} from "../schemas";

// A seed id: no RFC version or variant bits, which z.uuid() would refuse.
const SEED_ID = "a0000000-0000-0000-0000-000000000001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "550e8400-e29b-41d4-a716-446655440100";
const TENANT_ID = "550e8400-e29b-41d4-a716-446655440200";

/** The first issue as the route answers it: its top-level key and message. */
function firstIssue(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return "ok";
  const issue = parsed.error.issues[0];
  return { field: typeof issue.path[0] === "string" ? issue.path[0] : undefined, message: issue.message };
}

describe("V1CreateBillingPeriodBody", () => {
  const PERIOD = { microgrid_id: MICROGRID_ID, start_date: "2026-01-01", end_date: "2026-01-31" };

  it.each([
    ["a multi-day period", PERIOD],
    ["a same-day period", { ...PERIOD, end_date: "2026-01-01" }],
    ["a seed id", { ...PERIOD, microgrid_id: SEED_ID }],
    ["an upper-case id", { ...PERIOD, microgrid_id: MICROGRID_ID.toUpperCase() }],
    ["a leap day", { ...PERIOD, start_date: "2024-02-29", end_date: "2024-03-01" }],
  ])("accepts %s", (_label, body) => {
    expect(firstIssue(V1CreateBillingPeriodBody, body)).toBe("ok");
  });

  it("drops unknown keys, the deliberately absent timezone included", () => {
    const parsed = V1CreateBillingPeriodBody.parse({ ...PERIOD, timezone: "Africa/Kampala", status: "closed" });
    expect(parsed).toEqual(PERIOD);
  });

  it.each([undefined, null, 7, "", "not-a-uuid", `${MICROGRID_ID}0`, "550e8400e29b41d4a716446655440000"])(
    "refuses microgrid_id %j",
    (microgrid_id) => {
      const body: Record<string, unknown> = { ...PERIOD, microgrid_id };
      if (microgrid_id === undefined) delete body.microgrid_id;
      expect(firstIssue(V1CreateBillingPeriodBody, body)).toEqual({
        field: "microgrid_id",
        message: "microgrid_id must be a UUID",
      });
    }
  );

  it.each(["start_date", "end_date"])("refuses a bad or impossible %s with its message", (field) => {
    for (const value of [undefined, null, 20260101, "not-a-date", "20260101", "2026-1-01", "2026-13-99", "2026-02-30", "2025-02-29", "0000-01-01", "2026-01-01T00:00:00Z"]) {
      const body: Record<string, unknown> = { ...PERIOD, [field]: value };
      if (value === undefined) delete body[field];
      expect(firstIssue(V1CreateBillingPeriodBody, body), String(value)).toEqual({
        field,
        message: `${field} must be YYYY-MM-DD`,
      });
    }
  });

  it("refuses a start after the end under end_date", () => {
    expect(firstIssue(V1CreateBillingPeriodBody, { ...PERIOD, start_date: "2026-02-01" })).toEqual({
      field: "end_date",
      message: "end_date must be on or after start_date",
    });
  });

  it("reports the first field in the old order: microgrid_id, start_date, end_date, then the ordering", () => {
    expect(firstIssue(V1CreateBillingPeriodBody, { microgrid_id: "x", start_date: "x", end_date: "x" })).toEqual({
      field: "microgrid_id",
      message: "microgrid_id must be a UUID",
    });
    expect(firstIssue(V1CreateBillingPeriodBody, { ...PERIOD, start_date: "x", end_date: "x" })).toEqual({
      field: "start_date",
      message: "start_date must be YYYY-MM-DD",
    });
    // A failed field skips the ordering check, so its own message wins.
    expect(firstIssue(V1CreateBillingPeriodBody, { ...PERIOD, start_date: "2026-02-01", end_date: "2026-01-32" })).toEqual({
      field: "end_date",
      message: "end_date must be YYYY-MM-DD",
    });
  });

  it.each([null, [], [PERIOD], "text", 7, true])(
    "answers a body that is not an object (%j) with the microgrid_id message and no field",
    (body) => {
      expect(firstIssue(V1CreateBillingPeriodBody, body)).toEqual({
        field: undefined,
        message: "microgrid_id must be a UUID",
      });
    }
  );
});

describe("V1GenerateBody", () => {
  const READING = { tenantId: TENANT_ID, startKwh: 0, endKwh: 50 };
  const BODY = { billingPeriodId: PERIOD_ID, microgrid_id: MICROGRID_ID, manualReadings: [READING] };

  it.each([
    ["one reading", BODY],
    ["no manualReadings", { billingPeriodId: PERIOD_ID, microgrid_id: MICROGRID_ID }],
    ["an empty manualReadings", { ...BODY, manualReadings: [] }],
    ["seed ids", { billingPeriodId: SEED_ID, microgrid_id: SEED_ID, manualReadings: [{ ...READING, tenantId: SEED_ID }] }],
    ["an equal start and end", { ...BODY, manualReadings: [{ ...READING, startKwh: 7, endKwh: 7 }] }],
    ["a start of -0", { ...BODY, manualReadings: [{ ...READING, startKwh: -0 }] }],
    ["a reason", { ...BODY, manualReadings: [{ ...READING, reason: "meter swap" }] }],
  ])("accepts %s", (_label, body) => {
    expect(firstIssue(V1GenerateBody, body)).toBe("ok");
  });

  it("drops unknown keys at both levels, and a reason that is not a string", () => {
    const parsed = V1GenerateBody.parse({
      ...BODY,
      tenantIds: [TENANT_ID],
      seedReadings: [],
      manualReadings: [{ ...READING, reason: 7, meter: "m1" }, { ...READING, reason: "swap" }],
    });
    expect(parsed).toEqual({ ...BODY, manualReadings: [READING, { ...READING, reason: "swap" }] });
    expect(parsed.manualReadings?.[0].reason).toBeUndefined();
    expect(parsed).not.toHaveProperty("tenantIds");
    expect(parsed.manualReadings?.[0]).not.toHaveProperty("meter");
  });

  it.each([
    ["billingPeriodId", undefined, "billingPeriodId must be a UUID"],
    ["billingPeriodId", "not-a-uuid", "billingPeriodId must be a UUID"],
    ["billingPeriodId", null, "billingPeriodId must be a UUID"],
    ["microgrid_id", undefined, "microgrid_id must be a UUID"],
    ["microgrid_id", "not-a-uuid", "microgrid_id must be a UUID"],
    ["manualReadings", "nope", "manualReadings must be an array"],
    ["manualReadings", null, "manualReadings must be an array"],
    ["manualReadings", READING, "manualReadings must be an array"],
  ])("refuses %s %j under its own field", (field, value, message) => {
    const body: Record<string, unknown> = { ...BODY, [field]: value };
    if (value === undefined) delete body[field];
    expect(firstIssue(V1GenerateBody, body)).toEqual({ field, message });
  });

  const TENANT = "tenantId must be a UUID";
  const START = "startKwh must be a non-negative finite number";
  const END = "endKwh must be a finite number >= startKwh";

  it.each([
    [{ ...READING, tenantId: undefined }, TENANT],
    [{ ...READING, tenantId: "x" }, TENANT],
    [{ ...READING, tenantId: 1 }, TENANT],
    [null, TENANT],
    [7, TENANT],
    ["reading", TENANT],
    [[READING], TENANT],
    [{ ...READING, startKwh: -1 }, START],
    [{ ...READING, startKwh: "0" }, START],
    [{ ...READING, startKwh: undefined }, START],
    [{ ...READING, startKwh: null }, START],
    [{ ...READING, startKwh: Infinity }, START],
    [{ ...READING, startKwh: NaN }, START],
    [{ ...READING, endKwh: undefined }, END],
    [{ ...READING, endKwh: "50" }, END],
    [{ ...READING, endKwh: Infinity }, END],
    [{ ...READING, startKwh: 10, endKwh: 9.99 }, END],
    // The first fault in the old order: tenantId, then startKwh, then endKwh.
    [{ tenantId: "x", startKwh: -1, endKwh: "y" }, TENANT],
    [{ ...READING, startKwh: -1, endKwh: "y" }, START],
    [{ ...READING, startKwh: -5, endKwh: -6 }, START],
  ])("refuses the reading %j under manualReadings, naming its index", (reading, rest) => {
    expect(firstIssue(V1GenerateBody, { ...BODY, manualReadings: [READING, READING, reading, { ...READING, tenantId: "x" }] })).toEqual({
      field: "manualReadings",
      message: `manualReadings[2].${rest}`,
    });
  });

  it("reports the first faulty reading", () => {
    const manualReadings = [READING, { ...READING, startKwh: 5, endKwh: 4 }, { ...READING, tenantId: "x" }];
    expect(firstIssue(V1GenerateBody, { ...BODY, manualReadings })).toEqual({
      field: "manualReadings",
      message: `manualReadings[1].${END}`,
    });
  });

  it("reports the top-level fields in the old order: billingPeriodId, microgrid_id, manualReadings", () => {
    expect(firstIssue(V1GenerateBody, { billingPeriodId: "x", microgrid_id: "x", manualReadings: "x" })).toMatchObject({
      field: "billingPeriodId",
    });
    expect(firstIssue(V1GenerateBody, { ...BODY, microgrid_id: "x", manualReadings: [null] })).toMatchObject({
      field: "microgrid_id",
    });
  });

  it.each([null, [], [BODY], "text", 7])(
    "answers a body that is not an object (%j) with the billingPeriodId message and no field",
    (body) => {
      expect(firstIssue(V1GenerateBody, body)).toEqual({
        field: undefined,
        message: "billingPeriodId must be a UUID",
      });
    }
  );
});

describe("element index in a zod error function", () => {
  // V1ManualReadingBody's messages read the element index from issue.path,
  // which relies on zod calling error functions after the issue's path is
  // complete. These pin that zod behaviour; if they fail after a zod
  // upgrade, the v1 messages lose their index.
  it("sees the full path, the index included, for a field and for the element itself", () => {
    const seen: PropertyKey[][] = [];
    const record = (issue: { path?: PropertyKey[] }) => {
      seen.push([...(issue.path ?? [])]);
      return "x";
    };
    const schema = z.object({ list: z.array(z.object({ n: z.number({ error: record }) }, { error: record })) });
    // safeParse builds its error, and so calls error functions, on the first
    // read of `error`.
    expect(schema.safeParse({ list: [{ n: 1 }, { n: 1 }, { n: "a" }, null] }).error?.issues).toHaveLength(2);
    expect(seen).toEqual([
      ["list", 2, "n"],
      ["list", 3],
    ]);
  });

  it("reads the index from the body, and has none when a reading is parsed on its own", () => {
    const parsed = V1ManualReadingBody.safeParse({ tenantId: "x", startKwh: 0, endKwh: 1 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe("manualReadings[?].tenantId must be a UUID");
    const big = Array.from({ length: 12 }, () => ({ tenantId: TENANT_ID, startKwh: 0, endKwh: 1 }));
    big[11] = { tenantId: TENANT_ID, startKwh: 2, endKwh: 1 };
    expect(firstIssue(V1GenerateBody, { billingPeriodId: PERIOD_ID, microgrid_id: MICROGRID_ID, manualReadings: big })).toEqual({
      field: "manualReadings",
      message: "manualReadings[11].endKwh must be a finite number >= startKwh",
    });
  });
});

// The JSON Schema each body's input has, per version. A change to a schema
// that alters its JSON Schema needs a new version: bump the constant in
// schemas.ts and add the new shape here, keeping the old one. These are
// z.object, so no additionalProperties: unknown keys are dropped.
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const GUID = {
  type: "string",
  format: "uuid",
  pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
};
const DATE = {
  type: "string",
  format: "date",
  pattern:
    "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
};

const V1_CREATE_BILLING_PERIOD_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      microgrid_id: { ...GUID, title: "Microgrid" },
      start_date: { ...DATE, title: "Start date" },
      end_date: { ...DATE, title: "End date" },
    },
    required: ["microgrid_id", "start_date", "end_date"],
  },
};

const V1_GENERATE_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      billingPeriodId: { ...GUID, title: "Billing period" },
      microgrid_id: { ...GUID, title: "Microgrid" },
      manualReadings: {
        title: "Manual readings",
        type: "array",
        items: {
          type: "object",
          properties: {
            tenantId: { ...GUID, title: "Tenant" },
            startKwh: { type: "number", minimum: 0, title: "Start reading (kWh)" },
            endKwh: { type: "number", title: "End reading (kWh)" },
            reason: { title: "Reason", type: "string" },
          },
          required: ["tenantId", "startKwh", "endKwh"],
        },
      },
    },
    required: ["billingPeriodId", "microgrid_id"],
  },
};

describe("pinned input versions", () => {
  it.each([
    ["V1CreateBillingPeriodBody", V1CreateBillingPeriodBody, V1_CREATE_BILLING_PERIOD_BODY_VERSION, V1_CREATE_BILLING_PERIOD_SHAPES, "V1_CREATE_BILLING_PERIOD_BODY_VERSION"],
    ["V1GenerateBody", V1GenerateBody, V1_GENERATE_BODY_VERSION, V1_GENERATE_SHAPES, "V1_GENERATE_BODY_VERSION"],
  ] as const)("%s matches the shape pinned for its version", (_name, schema, version, shapes, constant) => {
    expect(
      z.toJSONSchema(schema, { io: "input" }),
      `The JSON Schema changed: bump ${constant} in src/lib/billing/schemas.ts and pin the new shape in this file.`
    ).toEqual(shapes[version]);
  });

  it("starts every version at 1", () => {
    expect(V1_CREATE_BILLING_PERIOD_BODY_VERSION).toBe(1);
    expect(V1_GENERATE_BODY_VERSION).toBe(1);
  });
});

/**
 * The billing-period and generation body schemas: what each accepts, what it
 * refuses with which message and field (as parseJsonBody answers them), and
 * the JSON Schema pinned for each input version.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BILLING_REVIEW_MAX_TENANTS,
  CREATE_PERIOD_BODY_VERSION,
  CreatePeriodBody,
  GENERATE_BILLS_BODY_VERSION,
  GenerateBillsBody,
  PREVIEW_BILLING_REVIEW_BODY_VERSION,
  PreviewBillingReviewBody,
} from "../schemas";

// Seed-style ids: any hex, no RFC version or variant bits.
const MG = "a0000000-0000-0000-0000-000000000001";
const PERIOD = "a0000000-0000-0000-0000-000000000002";
const TENANT = "a0000000-0000-0000-0000-000000000003";
const OTHER = "A0000000-0000-0000-0000-00000000000F";
const DEVICE = "a0000000-0000-0000-0000-000000000004";

/** The first issue as the route answers it: its top-level key and message. */
function firstIssue(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return "ok";
  const issue = parsed.error.issues[0];
  return { field: typeof issue.path[0] === "string" ? issue.path[0] : undefined, message: issue.message };
}

describe("CreatePeriodBody", () => {
  const RANGE = "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.";
  const PERIOD_BODY = { microgrid_id: MG, start_date: "2026-09-01", end_date: "2026-09-30" };

  it("accepts a period, a one-day period and an upper-case id", () => {
    expect(firstIssue(CreatePeriodBody, PERIOD_BODY)).toBe("ok");
    expect(firstIssue(CreatePeriodBody, { ...PERIOD_BODY, end_date: "2026-09-01" })).toBe("ok");
    expect(firstIssue(CreatePeriodBody, { ...PERIOD_BODY, microgrid_id: OTHER })).toBe("ok");
    expect(firstIssue(CreatePeriodBody, { ...PERIOD_BODY, start_date: "2024-02-29", end_date: "2024-02-29" })).toBe("ok");
  });

  it.each([undefined, 7, "", "not-a-uuid", MG.replace(/-/g, ""), `{${MG}}`])("refuses microgrid_id %j", (microgrid_id) => {
    expect(firstIssue(CreatePeriodBody, { ...PERIOD_BODY, microgrid_id })).toEqual({
      field: "microgrid_id",
      message: "microgrid_id must be a valid UUID.",
    });
  });

  it.each([
    ["start_date", "2026-02-30"],
    ["start_date", undefined],
    ["start_date", "0001-01-01"],
    ["end_date", "2026-9-30"],
    ["end_date", 20260930],
    ["end_date", "2026-09-30T00:00:00Z"],
  ])("refuses %s %j under its own field", (field, value) => {
    expect(firstIssue(CreatePeriodBody, { ...PERIOD_BODY, [field]: value })).toEqual({ field, message: RANGE });
  });

  it("refuses an inverted range under start_date", () => {
    expect(firstIssue(CreatePeriodBody, { ...PERIOD_BODY, start_date: "2026-09-30", end_date: "2026-09-01" })).toEqual({
      field: "start_date",
      message: RANGE,
    });
  });

  it("refuses an unknown key, and a body that is not an object, with no field", () => {
    expect(firstIssue(CreatePeriodBody, { ...PERIOD_BODY, timezone: "UTC" })).toEqual({
      field: undefined,
      message: "Unknown field: timezone",
    });
    for (const body of [null, [], "x", 1]) {
      expect(firstIssue(CreatePeriodBody, body)).toEqual({ field: undefined, message: "Request body must be an object" });
    }
  });
});

const MANUAL = { tenantId: TENANT, startKwh: 100, endKwh: 180, reason: "Read by hand" };
const SEED = { deviceId: DEVICE, dialReadingKwh: 4196, startKwh: 3982, readAt: "2026-08-20T09:00:00Z" };

describe.each([
  ["GenerateBillsBody", GenerateBillsBody],
] as const)("%s (the generation keys)", (_name, schema) => {
  it.each([
    ["the period alone", { billingPeriodId: PERIOD }],
    ["an explicit empty tenant list", { billingPeriodId: PERIOD, tenantIds: [] }],
    ["duplicate tenants", { billingPeriodId: PERIOD, tenantIds: [TENANT, TENANT] }],
    ["a zero-usage reading with -0 and no reason", { billingPeriodId: PERIOD, manualReadings: [{ tenantId: TENANT, startKwh: -0, endKwh: 0 }] }],
    ["an empty reason, and one of 500 characters", { billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, reason: "" }, { ...MANUAL, reason: "r".repeat(500) }] }],
    ["the same tenant read twice", { billingPeriodId: PERIOD, manualReadings: [MANUAL, MANUAL] }],
    ["a revert for a tenant not read by hand", { billingPeriodId: PERIOD, manualReadings: [MANUAL], revertToEdgeTenantIds: [OTHER] }],
    ["a revert differing from a manual tenant only in case", { billingPeriodId: PERIOD, manualReadings: [MANUAL], revertToEdgeTenantIds: [TENANT.toUpperCase()] }],
  ])("accepts %s", (_label, body) => {
    expect(firstIssue(schema, body)).toBe("ok");
  });

  it("passes the readings through unchanged", () => {
    const parsed = schema.parse({ billingPeriodId: PERIOD, tenantIds: [TENANT], manualReadings: [MANUAL] });
    expect(parsed).toEqual({ billingPeriodId: PERIOD, tenantIds: [TENANT], manualReadings: [MANUAL] });
  });

  it.each([
    [{}, "billingPeriodId", "billingPeriodId must be a UUID string"],
    [{ billingPeriodId: "not-a-uuid" }, "billingPeriodId", "billingPeriodId must be a UUID string"],
    [{ billingPeriodId: 1 }, "billingPeriodId", "billingPeriodId must be a UUID string"],
    [{ billingPeriodId: PERIOD, tenantIds: null }, "tenantIds", "tenantIds must be an array of UUIDs"],
    [{ billingPeriodId: PERIOD, tenantIds: TENANT }, "tenantIds", "tenantIds must be an array of UUIDs"],
    [{ billingPeriodId: PERIOD, tenantIds: [TENANT, "x"] }, "tenantIds", "tenantIds entries must be UUID strings"],
    [{ billingPeriodId: PERIOD, manualReadings: null }, "manualReadings", "manualReadings must be an array"],
    [{ billingPeriodId: PERIOD, manualReadings: {} }, "manualReadings", "manualReadings must be an array"],
    [{ billingPeriodId: PERIOD, manualReadings: [MANUAL, null] }, "manualReadings", "manualReadings[1] must be an object"],
    [{ billingPeriodId: PERIOD, manualReadings: [[]] }, "manualReadings", "manualReadings[0] must be an object"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, tenantId: "x" }] }, "manualReadings", "manualReadings[0].tenantId must be a UUID"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, startKwh: -1 }] }, "manualReadings", "manualReadings[0].startKwh must be a non-negative finite number"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, startKwh: "100" }] }, "manualReadings", "manualReadings[0].startKwh must be a non-negative finite number"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, startKwh: Infinity }] }, "manualReadings", "manualReadings[0].startKwh must be a non-negative finite number"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, endKwh: Number.NaN }] }, "manualReadings", "manualReadings[0].endKwh must be a non-negative finite number"],
    [{ billingPeriodId: PERIOD, manualReadings: [MANUAL, { ...MANUAL, endKwh: 99 }] }, "manualReadings", "manualReadings[1].endKwh must be >= startKwh"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, reason: null }] }, "manualReadings", "manualReadings[0].reason must be a string"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, reason: "r".repeat(501) }] }, "manualReadings", "manualReadings[0].reason must be <= 500 chars"],
    [{ billingPeriodId: PERIOD, manualReadings: [{ ...MANUAL, note: "x" }] }, "manualReadings", "manualReadings[0] has an unknown field: note"],
    [{ billingPeriodId: PERIOD, revertToEdgeTenantIds: TENANT }, "revertToEdgeTenantIds", "revertToEdgeTenantIds must be an array of UUIDs"],
    [{ billingPeriodId: PERIOD, revertToEdgeTenantIds: [7] }, "revertToEdgeTenantIds", "revertToEdgeTenantIds entries must be UUID strings"],
    [
      { billingPeriodId: PERIOD, manualReadings: [MANUAL], revertToEdgeTenantIds: [OTHER, TENANT] },
      "revertToEdgeTenantIds",
      `Tenant ${TENANT} cannot be in both manualReadings and revertToEdgeTenantIds`,
    ],
  ])("refuses %j", (body, field, message) => {
    expect(firstIssue(schema, body)).toEqual({ field, message });
  });

  it("reports the first faulty key in today's order: billingPeriodId, tenantIds, manualReadings, revertToEdgeTenantIds", () => {
    expect(firstIssue(schema, { tenantIds: 1, manualReadings: 1 })).toMatchObject({ field: "billingPeriodId" });
    expect(firstIssue(schema, { billingPeriodId: PERIOD, revertToEdgeTenantIds: 1, manualReadings: 1, tenantIds: 1 }))
      .toMatchObject({ field: "tenantIds" });
    expect(firstIssue(schema, { billingPeriodId: PERIOD, revertToEdgeTenantIds: 1, manualReadings: 1 }))
      .toMatchObject({ field: "manualReadings" });
  });

  it("refuses an unknown key, and a body that is not an object, with no field", () => {
    expect(firstIssue(schema, { billingPeriodId: PERIOD, provider: "fixture" })).toEqual({
      field: undefined,
      message: "Unknown field: provider",
    });
    for (const body of [null, [], "x", 1]) {
      expect(firstIssue(schema, body)).toEqual({ field: undefined, message: "Body must be an object" });
    }
  });
});

describe("GenerateBillsBody without seed readings (version 2)", () => {
  it("refuses seedReadings as an unknown field: no run it parses for takes them", () => {
    expect(firstIssue(GenerateBillsBody, { billingPeriodId: PERIOD, seedReadings: [SEED] })).toEqual({
      field: undefined,
      message: "Unknown field: seedReadings",
    });
  });
});

describe("PreviewBillingReviewBody", () => {
  const REVIEW = "periodId and tenantIds must be UUIDs; tenantIds is limited to 500 entries";

  it("accepts a period with or without tenants, up to the cap", () => {
    expect(firstIssue(PreviewBillingReviewBody, { periodId: PERIOD })).toBe("ok");
    expect(firstIssue(PreviewBillingReviewBody, { periodId: PERIOD, tenantIds: [] })).toBe("ok");
    expect(
      firstIssue(PreviewBillingReviewBody, { periodId: PERIOD, tenantIds: Array(BILLING_REVIEW_MAX_TENANTS).fill(TENANT) })
    ).toBe("ok");
  });

  it.each([
    [{}, "periodId"],
    [{ periodId: "x" }, "periodId"],
    [{ periodId: PERIOD, tenantIds: null }, "tenantIds"],
    [{ periodId: PERIOD, tenantIds: [TENANT, "x"] }, "tenantIds"],
    [{ periodId: PERIOD, tenantIds: Array(BILLING_REVIEW_MAX_TENANTS + 1).fill(TENANT) }, "tenantIds"],
    [null, undefined],
    [[PERIOD], undefined],
  ])("refuses %j with the one message", (input, field) => {
    expect(firstIssue(PreviewBillingReviewBody, input)).toEqual({ field, message: REVIEW });
  });

  it("refuses readings, a provider or any other key by name", () => {
    expect(firstIssue(PreviewBillingReviewBody, { periodId: PERIOD, manualReadings: [], provider: "fixture" })).toEqual({
      field: undefined,
      message: "Unknown field: manualReadings, provider",
    });
  });

  it("names the cap in its message", () => {
    expect(REVIEW).toContain(String(BILLING_REVIEW_MAX_TENANTS));
  });
});

// The JSON Schema a form reads, per input version. A change to a schema that
// alters its JSON Schema needs a new version: bump the constant in
// schemas.ts and add the new shape here, keeping the old one.
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
const KWH = { type: "number", minimum: 0 };
const GENERATION_PROPERTIES = {
  billingPeriodId: { ...GUID, title: "Billing period" },
  tenantIds: { title: "Tenants", type: "array", items: GUID },
  manualReadings: {
    title: "Manual readings",
    type: "array",
    items: {
      type: "object",
      properties: {
        tenantId: { ...GUID, title: "Tenant" },
        startKwh: { ...KWH, title: "Start reading (kWh)" },
        endKwh: { ...KWH, title: "End reading (kWh)" },
        reason: { title: "Reason", type: "string", maxLength: 500 },
      },
      required: ["tenantId", "startKwh", "endKwh"],
      additionalProperties: false,
    },
  },
  revertToEdgeTenantIds: { title: "Switch back to edge data", type: "array", items: GUID },
};

const CREATE_PERIOD_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      microgrid_id: { ...GUID, title: "Microgrid" },
      start_date: { ...DATE, title: "Start date" },
      end_date: { ...DATE, title: "End date" },
    },
    required: ["microgrid_id", "start_date", "end_date"],
    additionalProperties: false,
  },
};

const GENERATE_BILLS_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      ...GENERATION_PROPERTIES,
      seedReadings: {
        title: "Starting readings",
        type: "array",
        items: {
          type: "object",
          properties: {
            deviceId: { ...GUID, title: "Meter" },
            dialReadingKwh: { ...KWH, title: "Meter dial reading (kWh)" },
            startKwh: { ...KWH, title: "Start reading (kWh)" },
            readAt: { type: "string", title: "Read at" },
          },
          required: ["deviceId", "dialReadingKwh", "startKwh", "readAt"],
          additionalProperties: false,
        },
      },
    },
    required: ["billingPeriodId"],
    additionalProperties: false,
  },
  // Version 2 dropped seedReadings.
  2: {
    $schema: SCHEMA,
    type: "object",
    properties: GENERATION_PROPERTIES,
    required: ["billingPeriodId"],
    additionalProperties: false,
  },
};

const PREVIEW_BILLING_REVIEW_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      periodId: { ...GUID, title: "Billing period" },
      tenantIds: { title: "Tenants", maxItems: 500, type: "array", items: GUID },
    },
    required: ["periodId"],
    additionalProperties: false,
  },
};

describe("pinned input versions", () => {
  it.each([
    ["CreatePeriodBody", CreatePeriodBody, CREATE_PERIOD_BODY_VERSION, CREATE_PERIOD_SHAPES, "CREATE_PERIOD_BODY_VERSION"],
    ["GenerateBillsBody", GenerateBillsBody, GENERATE_BILLS_BODY_VERSION, GENERATE_BILLS_SHAPES, "GENERATE_BILLS_BODY_VERSION"],
    [
      "PreviewBillingReviewBody",
      PreviewBillingReviewBody,
      PREVIEW_BILLING_REVIEW_BODY_VERSION,
      PREVIEW_BILLING_REVIEW_SHAPES,
      "PREVIEW_BILLING_REVIEW_BODY_VERSION",
    ],
  ] as const)("%s matches the shape pinned for its version", (_name, schema, version, shapes, constant) => {
    expect(
      z.toJSONSchema(schema, { io: "input" }),
      `The JSON Schema changed: bump ${constant} in src/lib/billing/schemas.ts and pin the new shape in this file.`
    ).toEqual(shapes[version]);
  });

  it("pins every version", () => {
    expect(CREATE_PERIOD_BODY_VERSION).toBe(1);
    expect(GENERATE_BILLS_BODY_VERSION).toBe(2);
    expect(PREVIEW_BILLING_REVIEW_BODY_VERSION).toBe(1);
  });
});

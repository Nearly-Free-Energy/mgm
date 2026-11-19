import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LINE_ITEM_PAYMENT_STATUS_BODY_VERSION,
  LINE_ITEM_USAGE_BODY_VERSION,
  LineItemPaymentStatusBody,
  LineItemUsageBody,
  REGENERATE_BILL_BODY_VERSION,
  RegenerateBillBody,
} from "../schemas";

/** The first issue as the route answers it: its top-level key and message. */
function firstIssue(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return "ok";
  const issue = parsed.error.issues[0];
  return { field: typeof issue.path[0] === "string" ? issue.path[0] : undefined, message: issue.message };
}

describe("LineItemUsageBody", () => {
  it.each([
    ["usage_kwh alone", { usage_kwh: 12.5 }],
    ["end_kwh alone", { end_kwh: 80 }],
    ["both", { usage_kwh: 5, end_kwh: 80 }],
    ["zero", { usage_kwh: 0 }],
    ["negative zero", { end_kwh: -0 }],
  ])("accepts %s", (_label, body) => {
    expect(firstIssue(LineItemUsageBody, body)).toBe("ok");
  });

  it.each(["usage_kwh", "end_kwh"])("refuses a %s that is not a finite number, or is negative", (key) => {
    for (const value of ["12", null, Infinity, -Infinity, NaN, true, {}]) {
      expect(firstIssue(LineItemUsageBody, { [key]: value })).toEqual({
        field: key,
        message: `${key} must be a finite number`,
      });
    }
    expect(firstIssue(LineItemUsageBody, { [key]: -0.001 })).toEqual({
      field: key,
      message: `${key} must be a non-negative number`,
    });
  });

  it("checks usage_kwh before end_kwh", () => {
    expect(firstIssue(LineItemUsageBody, { end_kwh: -1, usage_kwh: "a" })).toEqual({
      field: "usage_kwh",
      message: "usage_kwh must be a finite number",
    });
  });

  it("refuses a body with neither key, with no field", () => {
    expect(firstIssue(LineItemUsageBody, {})).toEqual({
      field: undefined,
      message: "At least one of usage_kwh or end_kwh is required",
    });
  });

  it("refuses unknown keys after the fields, and a body that is not an object, with no field", () => {
    expect(firstIssue(LineItemUsageBody, { usage_kwh: 5, note: "x" })).toEqual({
      field: undefined,
      message: "Unknown field: note",
    });
    expect(firstIssue(LineItemUsageBody, { extra: 1 })).toEqual({ field: undefined, message: "Unknown field: extra" });
    expect(firstIssue(LineItemUsageBody, { usage_kwh: "a", note: "x" })).toMatchObject({ field: "usage_kwh" });
    for (const body of [null, [], 0, false, "", "12"]) {
      expect(firstIssue(LineItemUsageBody, body)).toEqual({
        field: undefined,
        message: "Request body must be an object",
      });
    }
  });

  it("pins the JSON Schema of version 1", () => {
    expect(LINE_ITEM_USAGE_BODY_VERSION).toBe(1);
    // The at-least-one rule is a refine, which JSON Schema does not carry.
    expect(z.toJSONSchema(LineItemUsageBody, { io: "input" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        usage_kwh: { title: "Usage (kWh)", type: "number", minimum: 0 },
        end_kwh: { title: "Closing meter reading (kWh)", type: "number", minimum: 0 },
      },
      additionalProperties: false,
    });
  });
});

describe("LineItemPaymentStatusBody", () => {
  it.each(["unpaid", "paid", "failed", "refunded"])("accepts status %s with no notes as null notes", (status) => {
    expect(LineItemPaymentStatusBody.parse({ status })).toEqual({ status, notes: null });
  });

  it("trims notes, keeps 500 characters after trimming and turns empty notes into null", () => {
    expect(LineItemPaymentStatusBody.parse({ status: "paid", notes: "  receipt 42 " })).toEqual({
      status: "paid",
      notes: "receipt 42",
    });
    const padded = `${" ".repeat(10)}${"x".repeat(500)}  `;
    expect(LineItemPaymentStatusBody.parse({ status: "paid", notes: padded }).notes).toBe("x".repeat(500));
    expect(LineItemPaymentStatusBody.parse({ status: "paid", notes: "   " }).notes).toBeNull();
    expect(LineItemPaymentStatusBody.parse({ status: "paid", notes: "" }).notes).toBeNull();
    expect(LineItemPaymentStatusBody.parse({ status: "paid", notes: null }).notes).toBeNull();
  });

  it("refuses a missing status", () => {
    expect(firstIssue(LineItemPaymentStatusBody, { notes: "x" })).toEqual({
      field: "status",
      message: "Missing required field: status.",
    });
  });

  it.each([
    ["link_generated", "link_generated"],
    ["Paid", "Paid"],
    [null, "null"],
    [{}, "[object Object]"],
    [3, "3"],
  ])("refuses the status %j, naming it", (status, shown) => {
    expect(firstIssue(LineItemPaymentStatusBody, { status })).toEqual({
      field: "status",
      message: `Invalid status '${shown}'. Allowed: unpaid, paid, failed, refunded.`,
    });
  });

  it("refuses notes that are not a string, or longer than 500 characters after trimming", () => {
    for (const notes of [5, true, ["x"]]) {
      expect(firstIssue(LineItemPaymentStatusBody, { status: "paid", notes })).toEqual({
        field: "notes",
        message: "notes must be a string.",
      });
    }
    expect(firstIssue(LineItemPaymentStatusBody, { status: "paid", notes: "x".repeat(501) })).toEqual({
      field: "notes",
      message: "notes must be 500 characters or fewer.",
    });
  });

  it("checks status before notes, and both before unknown keys", () => {
    expect(firstIssue(LineItemPaymentStatusBody, { status: "weird", notes: 5 })).toMatchObject({ field: "status" });
    expect(firstIssue(LineItemPaymentStatusBody, { status: "weird", x: 1 })).toMatchObject({ field: "status" });
  });

  it("refuses unknown keys, and a body that is not an object, with no field", () => {
    expect(firstIssue(LineItemPaymentStatusBody, { status: "paid", note: "typo" })).toEqual({
      field: undefined,
      message: "Unknown field: note",
    });
    for (const body of [null, ["paid"], "paid", 1]) {
      expect(firstIssue(LineItemPaymentStatusBody, body)).toEqual({
        field: undefined,
        message: "Request body must be a JSON object.",
      });
    }
  });

  it("accepts the host's confirmation, which a typed action sends, and refuses a malformed one", () => {
    expect(firstIssue(LineItemPaymentStatusBody, { status: "refunded", notes: "n", confirmation: { acknowledged: [], typed: "Akello" } })).toBe("ok");
    expect(firstIssue(LineItemPaymentStatusBody, { status: "refunded", confirmation: { typed: "Akello" } })).toMatchObject({ field: "confirmation" });
  });

  it("takes a typed name of any length, as tenants.display_name has no limit", () => {
    const long = "Akello ".repeat(100).trim();
    expect(long.length).toBeGreaterThan(200);
    expect(firstIssue(LineItemPaymentStatusBody, { status: "refunded", confirmation: { acknowledged: [], typed: long } })).toBe("ok");
  });

  it("pins the JSON Schema of version 2 (version 1 had no confirmation)", () => {
    expect(LINE_ITEM_PAYMENT_STATUS_BODY_VERSION).toBe(2);
    // maxLength applies to the untrimmed input here, so a form built from it
    // is slightly stricter than the route, which trims first.
    expect(z.toJSONSchema(LineItemPaymentStatusBody, { io: "input" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        status: { type: "string", enum: ["unpaid", "paid", "failed", "refunded"], title: "Payment status" },
        notes: { title: "Notes", anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
        confirmation: {
          type: "object",
          properties: {
            acknowledged: { maxItems: 20, type: "array", items: { type: "string", maxLength: 64 } },
            typed: { type: "string" },
          },
          required: ["acknowledged"],
          additionalProperties: false,
        },
      },
      required: ["status"],
      additionalProperties: false,
    });
  });
});

describe("RegenerateBillBody", () => {
  it.each([
    ["edge", { readings: "edge" }],
    ["manual with both readings", { readings: "manual", start_kwh: 10, end_kwh: 20 }],
    ["manual with a reason", { readings: "manual", start_kwh: 0, end_kwh: 0, reason: "dial photo" }],
    // Which readings a mode takes is the route's check, so the schema stays flat.
    ["edge with readings", { readings: "edge", start_kwh: 10 }],
    ["manual with none", { readings: "manual" }],
  ])("parses %s", (_label, body) => {
    expect(firstIssue(RegenerateBillBody, body)).toBe("ok");
  });

  it("trims the reason", () => {
    expect(RegenerateBillBody.parse({ readings: "manual", start_kwh: 1, end_kwh: 2, reason: "  read on site " })).toEqual({
      readings: "manual",
      start_kwh: 1,
      end_kwh: 2,
      reason: "read on site",
    });
  });

  it.each([
    [{}, "readings", "readings must be 'edge' or 'manual'"],
    [{ readings: "both" }, "readings", "readings must be 'edge' or 'manual'"],
    [{ readings: "manual", start_kwh: -1 }, "start_kwh", "start_kwh must be a non-negative number"],
    [{ readings: "manual", end_kwh: "12" }, "end_kwh", "end_kwh must be a finite number"],
    [{ readings: "manual", reason: 5 }, "reason", "reason must be a string"],
    [{ readings: "manual", reason: "x".repeat(501) }, "reason", "reason must be 500 characters or fewer"],
  ])("refuses %j at its field", (body, field, message) => {
    expect(firstIssue(RegenerateBillBody, body)).toEqual({ field, message });
  });

  it("refuses an unknown key, and a body that is not an object, with no field", () => {
    expect(firstIssue(RegenerateBillBody, { readings: "edge", tenantIds: [] })).toEqual({ field: undefined, message: "Unknown field: tenantIds" });
    for (const body of [null, [], "edge"]) {
      expect(firstIssue(RegenerateBillBody, body)).toEqual({ field: undefined, message: "Request body must be an object" });
    }
  });

  it("has no object-level refinement, so the GUI host can check a prefill against it", () => {
    // .omit() throws on an object schema with refinements (cleanPrefill in src/lib/gui/host/server/merge.ts).
    expect(() => RegenerateBillBody.omit({}).partial()).not.toThrow();
    expect(RegenerateBillBody.omit({}).partial().safeParse({ readings: "manual", start_kwh: 12 }).success).toBe(true);
  });

  it("takes the host's confirmation, and refuses one of another shape", () => {
    expect(RegenerateBillBody.parse({ readings: "edge", confirmation: { acknowledged: ["regenerate-paid-bill"] } })).toEqual({
      readings: "edge",
      confirmation: { acknowledged: ["regenerate-paid-bill"] },
    });
    for (const confirmation of [
      true,
      {},
      { acknowledged: "regenerate-paid-bill" },
      { acknowledged: [], extra: 1 },
      // The ceremony asks for no name, so a typed one is not taken.
      { acknowledged: [], typed: "Unit 1" },
    ]) {
      expect(firstIssue(RegenerateBillBody, { readings: "edge", confirmation })).toMatchObject({
        message: "confirmation needs the acknowledgements ticked",
      });
    }
  });

  it("pins the JSON Schema of version 2 (version 1 had no confirmation)", () => {
    expect(REGENERATE_BILL_BODY_VERSION).toBe(2);
    expect(z.toJSONSchema(RegenerateBillBody, { io: "input" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        readings: { type: "string", enum: ["edge", "manual"], title: "Readings" },
        start_kwh: { title: "Start reading (kWh)", type: "number", minimum: 0 },
        end_kwh: { title: "End reading (kWh)", type: "number", minimum: 0 },
        reason: { title: "Reason", type: "string", maxLength: 500 },
        confirmation: {
          type: "object",
          properties: {
            acknowledged: { maxItems: 20, type: "array", items: { type: "string", maxLength: 64 } },
          },
          required: ["acknowledged"],
          additionalProperties: false,
        },
      },
      required: ["readings"],
      additionalProperties: false,
    });
  });
});

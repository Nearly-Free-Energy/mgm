/**
 * Payments' body schemas (../schemas.ts): each version's JSON Schema is
 * pinned, so a change to what a route accepts is a new input version; the
 * messages a route answers with; and the kit can draw each as a form.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldsOf } from "@/lib/gui/kit/action-form";
import type { Json } from "@/lib/gui/contract";
import {
  ACCEPT_RECEIPTS_BODY_VERSION,
  AcceptReceiptsBody,
  RECORD_ADJUSTMENT_BODY_VERSION,
  REFRESH_ATTEMPT_BODY_VERSION,
  ReconcileAttemptBody,
  RecordAdjustmentBody,
  RefreshAttemptBody,
} from "../schemas";

/** The first issue as the route answers it: its top-level key and message. */
function firstIssue(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return "ok";
  const issue = parsed.error.issues[0];
  return { field: typeof issue.path[0] === "string" ? issue.path[0] : undefined, message: issue.message };
}

const json = (schema: z.ZodType) => JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" })));

/** What a person fills, as the host hands it to the kit: `confirmation` removed (describeInput in src/lib/gui/host/server/input-spec.ts). */
function personInput(schema: z.ZodType): Json {
  const s = json(schema) as { properties: Record<string, Json>; required?: string[] };
  delete s.properties.confirmation;
  if (s.required) s.required = s.required.filter((k) => k !== "confirmation");
  return s as unknown as Json;
}

describe("RefreshAttemptBody", () => {
  it(`is version ${REFRESH_ATTEMPT_BODY_VERSION}: an empty object`, () => {
    expect(REFRESH_ATTEMPT_BODY_VERSION).toBe(1);
    expect(json(RefreshAttemptBody)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("accepts {} and refuses any key, and a body that is not an object", () => {
    expect(firstIssue(RefreshAttemptBody, {})).toBe("ok");
    expect(firstIssue(RefreshAttemptBody, { action: "accept_exact" })).toEqual({ field: undefined, message: "Unknown field: action" });
    for (const body of [null, [], "x", 1]) {
      expect(firstIssue(RefreshAttemptBody, body)).toEqual({ field: undefined, message: "Request body must be an object" });
    }
  });

  it("has nothing for a person to fill, which the kit draws as no fields", () => {
    expect(fieldsOf(personInput(RefreshAttemptBody))).toEqual([]);
  });
});

const CONFIRMATION_JSON = {
  type: "object",
  properties: {
    acknowledged: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } },
    typed: { type: "string" },
  },
  required: ["acknowledged"],
  additionalProperties: false,
};

describe("AcceptReceiptsBody", () => {
  it(`is version ${ACCEPT_RECEIPTS_BODY_VERSION}: its resolution fixed, with no amount`, () => {
    expect(ACCEPT_RECEIPTS_BODY_VERSION).toBe(2);
    expect(json(AcceptReceiptsBody)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        action: { type: "string", const: "accept_exact", title: "Resolution" },
        externalReference: { type: "string", maxLength: 200, title: "External reference" },
        notes: { type: "string", maxLength: 500, title: "Notes" },
        confirmation: CONFIRMATION_JSON,
      },
      required: ["action"],
      additionalProperties: false,
    });
  });

  it("is drawn by the kit as the reference and the notes, its resolution sent but not shown", () => {
    expect(fieldsOf(personInput(AcceptReceiptsBody))?.map((f) => [f.key, f.kind, f.kind === "rows" ? undefined : f.required])).toEqual([
      ["action", "fixed", true],
      ["externalReference", "text", false],
      ["notes", "text", false],
    ]);
  });
});

describe("RecordAdjustmentBody", () => {
  it(`is version ${RECORD_ADJUSTMENT_BODY_VERSION}: its resolution fixed, the amount in major units, and every field required`, () => {
    expect(RECORD_ADJUSTMENT_BODY_VERSION).toBe(2);
    expect(json(RecordAdjustmentBody)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        action: { type: "string", const: "record_external", title: "Resolution" },
        externalAmount: {
          type: "number",
          title: "External amount (negative for a refund)",
          description: "In the currency's major units, as the bill's total: 2500 for UGX 2,500, 12.5 for USD 12.50.",
        },
        externalReference: { type: "string", minLength: 1, maxLength: 200, title: "External reference" },
        notes: { type: "string", minLength: 1, maxLength: 500, title: "Notes" },
        confirmation: CONFIRMATION_JSON,
      },
      required: ["action", "externalAmount", "externalReference", "notes"],
      additionalProperties: false,
    });
  });

  it("is drawn by the kit as the amount, the reference and the notes, its resolution sent but not shown", () => {
    expect(fieldsOf(personInput(RecordAdjustmentBody))?.map((f) => [f.key, f.kind, f.kind === "rows" ? undefined : f.required])).toEqual([
      ["action", "fixed", true],
      ["externalAmount", "number", true],
      ["externalReference", "text", true],
      ["notes", "text", true],
    ]);
  });
});

describe("ReconcileAttemptBody, which the route parses", () => {
  const RECORD = { action: "record_external", externalAmount: -2500, externalReference: "MTN-1", notes: "Refunded by phone" };

  it("is either action's input, told apart by its resolution", () => {
    expect(ReconcileAttemptBody).toBeInstanceOf(z.ZodDiscriminatedUnion);
    expect(ReconcileAttemptBody.options).toEqual([AcceptReceiptsBody, RecordAdjustmentBody]);
  });

  it("accepts each action, a negative amount, and trims the texts", () => {
    expect(firstIssue(ReconcileAttemptBody, { action: "accept_exact" })).toBe("ok");
    expect(firstIssue(ReconcileAttemptBody, RECORD)).toBe("ok");
    expect(
      ReconcileAttemptBody.parse({ ...RECORD, externalReference: "  MTN-1 ", notes: " n ", confirmation: { acknowledged: [], typed: " Akello " } }),
    ).toEqual({ ...RECORD, notes: "n", confirmation: { acknowledged: [], typed: " Akello " } });
  });

  it.each([
    ["no action", { externalAmount: 1 }, "action", "action must be 'accept_exact' or 'record_external'."],
    ["an unknown action", { action: "refund" }, "action", "action must be 'accept_exact' or 'record_external'."],
    // A missing amount, reference or notes names its own field.
    ["a completed adjustment with no amount", { ...RECORD, externalAmount: undefined }, "externalAmount", "externalAmount must be a number."],
    ["a completed adjustment with no reference", { ...RECORD, externalReference: undefined }, "externalReference", "externalReference must be a string."],
    ["a completed adjustment with a blank reference", { ...RECORD, externalReference: "  " }, "externalReference", "externalReference is required."],
    ["a completed adjustment with blank notes", { ...RECORD, notes: " " }, "notes", "notes are required."],
    // Accepting takes no amount: not even a field for one.
    ["an amount on an acceptance", { action: "accept_exact", externalAmount: 0 }, undefined, "Unknown field: externalAmount"],
    ["a string amount", { ...RECORD, externalAmount: "2500" }, "externalAmount", "externalAmount must be a number."],
    ["a NaN amount", { ...RECORD, externalAmount: Number.NaN }, "externalAmount", "externalAmount must be a number."],
    ["an infinite amount", { ...RECORD, externalAmount: Number.POSITIVE_INFINITY }, "externalAmount", "externalAmount must be a number."],
    ["a numeric reference", { ...RECORD, externalReference: 5 }, "externalReference", "externalReference must be a string."],
    ["a long reference", { ...RECORD, externalReference: "x".repeat(201) }, "externalReference", "externalReference must be 200 characters or fewer."],
    ["long notes", { ...RECORD, notes: "x".repeat(501) }, "notes", "notes must be 500 characters or fewer."],
    ["a confirmation with a digest", { ...RECORD, confirmation: { acknowledged: [], digest: "x" } }, "confirmation", "confirmation must be { acknowledged: string[], typed?: string }."],
    ["a confirmation with no acknowledged list", { ...RECORD, confirmation: { typed: "x" } }, "confirmation", "confirmation must be { acknowledged: string[], typed?: string }."],
    ["21 acknowledgements", { ...RECORD, confirmation: { acknowledged: Array.from({ length: 21 }, () => "a") } }, "confirmation", "confirmation must be { acknowledged: string[], typed?: string }."],
  ])("refuses %s", (_label, body, field, message) => {
    expect(firstIssue(ReconcileAttemptBody, body)).toEqual({ field, message });
  });

  it("measures a text's length after trimming", () => {
    expect(firstIssue(ReconcileAttemptBody, { ...RECORD, externalReference: ` ${"x".repeat(200)} ` })).toBe("ok");
  });

  it("refuses an unknown key, and a body that is not an object, with no field", () => {
    expect(firstIssue(ReconcileAttemptBody, { ...RECORD, attemptId: "x" })).toEqual({ field: undefined, message: "Unknown field: attemptId" });
    for (const body of [null, [RECORD], "x"]) {
      expect(firstIssue(ReconcileAttemptBody, body)).toEqual({ field: undefined, message: "Request body must be an object" });
    }
  });

  it("has options that are objects of fields, so the host can clean a prefill against each field by field", () => {
    // cleanPrefill (src/lib/gui/host/server/merge.ts) takes only an object input, and checks a prefill against its fields.
    for (const option of [AcceptReceiptsBody, RecordAdjustmentBody]) {
      expect(option).toBeInstanceOf(z.ZodObject);
      expect(() => z.object(option.shape).omit({ confirmation: true }).partial().parse({ notes: "n" })).not.toThrow();
    }
  });
});

describe("the schemas module", () => {
  const runtimeImports = (file: string) =>
    [...readFileSync(path.join(__dirname, file), "utf8").matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

  it("imports only zod and its limits at run time, so it stays client-safe", () => {
    expect(runtimeImports("../schemas.ts")).toEqual(["zod", "./reconcile-limits"]);
    expect(runtimeImports("../reconcile-limits.ts")).toEqual([]);
  });
});

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
  RECONCILE_ATTEMPT_BODY_VERSION,
  REFRESH_ATTEMPT_BODY_VERSION,
  ReconcileAttemptBody,
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

/** What a person fills, as the host hands it to the kit: `confirmation` removed (inputSpec in prepare.ts). */
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

describe("ReconcileAttemptBody", () => {
  const RECORD = { action: "record_external", externalAmount: -2500, externalReference: "MTN-1", notes: "Refunded by phone" };

  it(`is version ${RECONCILE_ATTEMPT_BODY_VERSION}`, () => {
    expect(RECONCILE_ATTEMPT_BODY_VERSION).toBe(1);
    expect(json(ReconcileAttemptBody)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept_exact", "record_external"], title: "Resolution" },
        externalAmount: { type: "number", title: "External amount (negative for a refund)" },
        externalReference: { type: "string", maxLength: 200, title: "External reference" },
        notes: { type: "string", maxLength: 500, title: "Notes" },
        confirmation: {
          type: "object",
          properties: {
            acknowledged: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } },
            typed: { type: "string" },
          },
          required: ["acknowledged"],
          additionalProperties: false,
        },
      },
      required: ["action"],
      additionalProperties: false,
    });
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

  it("is an object of fields, so the host can clean a prefill against it field by field", () => {
    // cleanPrefill (src/lib/gui/host/server/merge.ts) takes only an object input, and checks a prefill against its fields.
    expect(ReconcileAttemptBody).toBeInstanceOf(z.ZodObject);
    expect(() => z.object(ReconcileAttemptBody.shape).omit({ confirmation: true }).partial().parse({ action: "record_external" })).not.toThrow();
  });

  it("is drawn by the kit as a form: the resolution, the amount, the reference and the notes", () => {
    const fields = fieldsOf(personInput(ReconcileAttemptBody));
    expect(fields?.map((f) => [f.key, f.kind])).toEqual([
      ["action", "choice"],
      ["externalAmount", "number"],
      ["externalReference", "text"],
      ["notes", "text"],
    ]);
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

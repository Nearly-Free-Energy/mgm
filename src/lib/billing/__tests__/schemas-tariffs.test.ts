/**
 * The rate-schedule and invoice-settings body schemas (#201): what each
 * accepts, and the message and field each refusal answers with.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CREATE_RATE_SCHEDULE_BODY_VERSION,
  CreateRateScheduleBody,
  PREVIEW_INVOICE_BODY_VERSION,
  PreviewInvoiceBody,
  REVISE_RATE_SCHEDULE_BODY_VERSION,
  ReviseRateScheduleBody,
  SAVE_INVOICE_SETTINGS_BODY_VERSION,
  SaveInvoiceSettingsBody,
} from "../schemas";
import { INVOICE_PREFIX_RE } from "@/lib/invoices/config-schema";

/** The first issue as the route answers it: its top-level key and message. */
function firstIssue(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return "ok";
  const issue = parsed.error.issues[0];
  return { field: typeof issue.path[0] === "string" ? issue.path[0] : undefined, message: issue.message };
}

const MICROGRID_ID = "660e8400-e29b-41d4-a716-446655440001";
const TIERS = [
  { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
  { label: "Tier 2", min_kwh: 51, max_kwh: 150, rate_per_kwh: 800 },
  { label: "Tier 3", min_kwh: 151, max_kwh: null, rate_per_kwh: 1200 },
];
const SCHEDULE = { tiers: TIERS, service_charge: 2000, tax_rate: 0.18 };
const CREATE = { microgrid_id: MICROGRID_ID, ...SCHEDULE };

/**
 * The check the rate-schedule routes made by hand before #201
 * (validatePayload in src/app/api/rate-schedules/route.ts), kept as the
 * oracle the schemas are compared with. It threw on a null tier and accepted
 * Infinity; the schemas refuse both, so the comparison leaves them out.
 */
function legacyValidatePayload(tiers: unknown, service_charge: unknown, tax_rate: unknown): string | null {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return "tiers must be a non-empty array (at least 1 tier required)";
  }
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const isLast = i === tiers.length - 1;
    if (typeof tier.min_kwh !== "number" || tier.min_kwh <= 0) return `Tier ${i + 1}: min_kwh must be greater than 0`;
    if (typeof tier.rate_per_kwh !== "number" || tier.rate_per_kwh <= 0) {
      return `Tier ${i + 1}: rate_per_kwh must be greater than 0`;
    }
    if (!isLast && typeof tier.max_kwh !== "number") return `Tier ${i + 1}: only the last tier may have max_kwh null`;
    if (i > 0) {
      const prev = tiers[i - 1];
      if (typeof prev.max_kwh === "number" && tier.min_kwh !== prev.max_kwh + 1) {
        return `Tier ${i + 1}: min_kwh must be ${prev.max_kwh + 1} (contiguous with tier ${i})`;
      }
    }
  }
  if (typeof service_charge !== "number" || service_charge < 0) return "service_charge must be a number >= 0";
  if (typeof tax_rate !== "number" || tax_rate < 0 || tax_rate > 1) {
    return "tax_rate must be a number between 0 and 1 (inclusive)";
  }
  return null;
}

describe("CreateRateScheduleBody", () => {
  it.each([
    ["a typical body", CREATE],
    ["one open-ended tier with no label", { ...CREATE, tiers: [{ min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }] }],
    ["tiers with keys the editor carries", { ...CREATE, tiers: [{ ...TIERS[0], note: "x" }, { ...TIERS[1], max_kwh: null }] }],
    ["a last tier with a max_kwh", { ...CREATE, tiers: [TIERS[0], { ...TIERS[1] }] }],
    ["fractional kWh", { ...CREATE, tiers: [{ min_kwh: 0.5, max_kwh: 10.5, rate_per_kwh: 1 }, { min_kwh: 11.5, max_kwh: null, rate_per_kwh: 1 }] }],
    ["a seed id without RFC version bits", { ...CREATE, microgrid_id: "00000000-0000-0000-0000-000000000001" }],
    ["an upper-case id", { ...CREATE, microgrid_id: MICROGRID_ID.toUpperCase() }],
    ["no service charge or tax, and a tax rate of 1", { ...CREATE, service_charge: 0, tax_rate: 1 }],
  ])("accepts %s", (_label, body) => {
    expect(firstIssue(CreateRateScheduleBody, body)).toBe("ok");
  });

  it("keeps each tier as sent", () => {
    const tiers = [{ min_kwh: 1, max_kwh: 5, rate_per_kwh: 1, extra: true }, { min_kwh: 6, max_kwh: "open", rate_per_kwh: 1 }];
    expect(CreateRateScheduleBody.parse({ ...CREATE, tiers }).tiers).toEqual(tiers);
  });

  it.each([undefined, 7, "not-a-uuid", "660e8400e29b41d4a716446655440001", `${MICROGRID_ID}x`])(
    "refuses microgrid_id %s",
    (microgrid_id) => {
      expect(firstIssue(CreateRateScheduleBody, { ...CREATE, microgrid_id })).toEqual({
        field: "microgrid_id",
        message: "microgrid_id must be a valid UUID",
      });
    }
  );

  it.each([
    ["no tiers", [], "tiers must be a non-empty array (at least 1 tier required)"],
    ["tiers that are not a list", { min_kwh: 1 }, "tiers must be a non-empty array (at least 1 tier required)"],
    ["a first tier from 0", [{ min_kwh: 0, max_kwh: null, rate_per_kwh: 1 }], "Tier 1: min_kwh must be greater than 0"],
    ["a string min_kwh", [{ min_kwh: "1", max_kwh: null, rate_per_kwh: 1 }], "Tier 1: min_kwh must be greater than 0"],
    ["a null tier", [null], "Tier 1: min_kwh must be greater than 0"],
    ["a tier that is a number", [TIERS[0], 7], "Tier 2: min_kwh must be greater than 0"],
    ["an infinite min_kwh", [{ min_kwh: Infinity, max_kwh: null, rate_per_kwh: 1 }], "Tier 1: min_kwh must be greater than 0"],
    ["a zero rate", [{ min_kwh: 1, max_kwh: null, rate_per_kwh: 0 }], "Tier 1: rate_per_kwh must be greater than 0"],
    ["an open tier before the last", [{ ...TIERS[0], max_kwh: null }, TIERS[2]], "Tier 1: only the last tier may have max_kwh null"],
    ["a missing max_kwh before the last", [{ min_kwh: 1, rate_per_kwh: 1 }, TIERS[2]], "Tier 1: only the last tier may have max_kwh null"],
    ["a gap", [TIERS[0], { ...TIERS[1], min_kwh: 52 }, TIERS[2]], "Tier 2: min_kwh must be 51 (contiguous with tier 1)"],
    ["a gap before the last tier", [TIERS[0], TIERS[1], { ...TIERS[2], min_kwh: 150 }], "Tier 3: min_kwh must be 151 (contiguous with tier 2)"],
    // A contiguity fault in tier 2 is reported before a type fault in tier 3.
    ["two faults", [TIERS[0], { ...TIERS[1], min_kwh: 60 }, { ...TIERS[2], rate_per_kwh: "x" }], "Tier 2: min_kwh must be 51 (contiguous with tier 1)"],
  ])("refuses %s under tiers", (_label, tiers, message) => {
    expect(firstIssue(CreateRateScheduleBody, { ...CREATE, tiers })).toEqual({ field: "tiers", message });
  });

  it.each([-1, "0", null, undefined, Infinity])("refuses service_charge %s", (service_charge) => {
    expect(firstIssue(CreateRateScheduleBody, { ...CREATE, service_charge })).toEqual({
      field: "service_charge",
      message: "service_charge must be a number >= 0",
    });
  });

  it.each([-0.01, 1.01, "0.18", null, undefined])("refuses tax_rate %s", (tax_rate) => {
    expect(firstIssue(CreateRateScheduleBody, { ...CREATE, tax_rate })).toEqual({
      field: "tax_rate",
      message: "tax_rate must be a number between 0 and 1 (inclusive)",
    });
  });

  it("checks the fields in the routes' old order: microgrid_id, tiers, service_charge, tax_rate", () => {
    const bad = { microgrid_id: "x", tiers: [], service_charge: -1, tax_rate: 2 };
    expect(firstIssue(CreateRateScheduleBody, bad)).toMatchObject({ field: "microgrid_id" });
    expect(firstIssue(CreateRateScheduleBody, { ...bad, microgrid_id: MICROGRID_ID })).toMatchObject({ field: "tiers" });
    expect(firstIssue(CreateRateScheduleBody, { ...bad, microgrid_id: MICROGRID_ID, tiers: TIERS })).toMatchObject({
      field: "service_charge",
    });
  });

  it("refuses unknown top-level keys, and a body that is not an object, with no field", () => {
    expect(firstIssue(CreateRateScheduleBody, { ...CREATE, service_charge_description: "Meter rental" })).toEqual({
      field: undefined,
      message: "Unknown field: service_charge_description",
    });
    for (const body of [[CREATE], null, "text", 7]) {
      expect(firstIssue(CreateRateScheduleBody, body)).toEqual({ field: undefined, message: "Request body must be an object" });
    }
  });
});

describe("ReviseRateScheduleBody", () => {
  it("accepts the schedule without a microgrid", () => {
    expect(firstIssue(ReviseRateScheduleBody, SCHEDULE)).toBe("ok");
  });

  it("refuses a microgrid_id, which comes from the existing schedule", () => {
    expect(firstIssue(ReviseRateScheduleBody, { ...SCHEDULE, microgrid_id: MICROGRID_ID })).toEqual({
      field: undefined,
      message: "Unknown field: microgrid_id",
    });
  });

  it("refuses an array body as not an object", () => {
    expect(firstIssue(ReviseRateScheduleBody, [SCHEDULE])).toEqual({ field: undefined, message: "Request body must be an object" });
  });

  it("answers a schedule with the hand-written check's message", () => {
    // A seeded generator, so a failure names a case that can be replayed.
    let seed = 20261118;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const MINS: unknown[] = [-1, 0, 1, 11, 21, 31, 0.5, "1", undefined];
    const MAXES: unknown[] = [null, undefined, 10, 20, 30, 10.5, "10"];
    const RATES: unknown[] = [0, 1, 250, -5, "1", null];
    const MONEY: unknown[] = [0, 1, 2000, -1, "1", null, 0.18, 1, 1.5];
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 20_000; i++) {
      const count = next(4);
      // Half the cases start from contiguous tiers and break at most one value.
      const tiers = Array.from({ length: count }, (_, k) =>
        i % 2 === 0
          ? { min_kwh: 1 + 10 * k, max_kwh: k === count - 1 ? null : 10 * (k + 1), rate_per_kwh: 100 }
          : { min_kwh: MINS[next(MINS.length)], max_kwh: MAXES[next(MAXES.length)], rate_per_kwh: RATES[next(RATES.length)] }
      ) as Record<string, unknown>[];
      if (i % 2 === 0 && count > 0 && next(2) === 0) {
        const key = (["min_kwh", "max_kwh", "rate_per_kwh"] as const)[next(3)];
        tiers[next(count)][key] = [...MINS, ...MAXES, ...RATES][next(MINS.length + MAXES.length + RATES.length)];
      }
      const service_charge = i % 3 === 0 ? MONEY[next(MONEY.length)] : 0;
      const tax_rate = i % 5 === 0 ? MONEY[next(MONEY.length)] : 0.18;
      const expected = legacyValidatePayload(tiers, service_charge, tax_rate);
      const actual = firstIssue(ReviseRateScheduleBody, { tiers, service_charge, tax_rate });
      const label = JSON.stringify({ tiers, service_charge, tax_rate });
      if (expected === null) {
        expect(actual, label).toBe("ok");
        accepted++;
      } else {
        expect(actual === "ok" ? actual : actual.message, label).toBe(expected);
        refused++;
      }
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });
});

const CONFIG = {
  seller: { legal_name: "Acme Co" },
  branding: { primary_color: "#163a5f", accent_color: "#2f7d32", document_title: "Invoice" },
  payment: { due_days_after_issue: 8 },
  tax: { show_section: true, category_label: "VAT @ 18%", rate_pct: 18 },
  notices: { vat_text: null, payment_instructions_text: null, signature_disclaimer: null },
};
const SETTINGS = { invoice_prefix: "NFE", invoice_config: CONFIG };
const PREFIX_FORMAT = "Invoice prefix must be 2-8 uppercase letters or digits (e.g. NFE, ACME01).";
const PREFIX_TYPE = "invoice_prefix must be a string or null.";
const SAVE_CONFIG = "Invoice configuration is invalid. See the highlighted fields.";
const PREVIEW_CONFIG = "Invoice configuration is invalid. Save your changes to see the field errors.";

const CONFIG_FAULTS: [string, unknown][] = [
  ["a missing invoice_config", undefined],
  ["an invoice_config that is not an object", "x"],
  ["an unknown key at its top level", { ...CONFIG, extra: 1 }],
  ["a bad colour", { ...CONFIG, branding: { primary_color: "not-a-hex" } }],
  ["a seller without a legal name", { ...CONFIG, seller: { trade_name: "Acme" } }],
  ["a fractional due date", { ...CONFIG, payment: { due_days_after_issue: 1.5 } }],
  ["a shown 0% tax section", { ...CONFIG, tax: { show_section: true, rate_pct: 0 } }],
  ["a tax section that does not say whether it is shown", { ...CONFIG, tax: {} }],
];

describe.each([
  ["SaveInvoiceSettingsBody", SaveInvoiceSettingsBody, SAVE_CONFIG],
  ["PreviewInvoiceBody", PreviewInvoiceBody, PREVIEW_CONFIG],
] as const)("%s", (_name, schema, configMessage) => {
  it("accepts a typical body, a null prefix and an empty invoice_config", () => {
    expect(firstIssue(schema, SETTINGS)).toBe("ok");
    expect(firstIssue(schema, { ...SETTINGS, invoice_prefix: null })).toBe("ok");
    expect(firstIssue(schema, { invoice_prefix: "ACME01", invoice_config: {} })).toBe("ok");
  });

  it("drops unknown keys inside invoice_config's sections, as InvoiceConfigSchema does", () => {
    const parsed = schema.parse({ ...SETTINGS, invoice_config: { ...CONFIG, payment: { due_days_after_issue: 8, extra: 1 } } });
    expect(parsed.invoice_config.payment).toEqual({ due_days_after_issue: 8 });
  });

  it.each(["nfe", "N", "NFE-01", "ABCDEFGHI", " NFE"])("refuses the prefix %j", (invoice_prefix) => {
    expect(firstIssue(schema, { ...SETTINGS, invoice_prefix })).toEqual({ field: "invoice_prefix", message: PREFIX_FORMAT });
  });

  it.each([undefined, 7, false, ["NFE"]])("refuses the prefix %j as the wrong type", (invoice_prefix) => {
    const body: Record<string, unknown> = { ...SETTINGS, invoice_prefix };
    if (invoice_prefix === undefined) delete body.invoice_prefix;
    expect(firstIssue(schema, body)).toEqual({ field: "invoice_prefix", message: PREFIX_TYPE });
  });

  it.each(CONFIG_FAULTS)("refuses %s with the route's one message", (_label, invoice_config) => {
    const body: Record<string, unknown> = { ...SETTINGS, invoice_config };
    if (invoice_config === undefined) delete body.invoice_config;
    expect(firstIssue(schema, body)).toEqual({ field: "invoice_config", message: configMessage });
  });

  it("checks the prefix before invoice_config", () => {
    expect(firstIssue(schema, { invoice_prefix: 7, invoice_config: "x" })).toEqual({ field: "invoice_prefix", message: PREFIX_TYPE });
  });

  it("refuses unknown top-level keys, and a body that is not an object, with no field", () => {
    expect(firstIssue(schema, { ...SETTINGS, community_id: "x" })).toEqual({ field: undefined, message: "Unknown field: community_id" });
    for (const body of [[SETTINGS], null, "text"]) {
      expect(firstIssue(schema, body)).toEqual({ field: undefined, message: "Request body must be an object" });
    }
  });
});

describe("the empty prefix", () => {
  it("is refused when saving and accepted by the preview", () => {
    expect(firstIssue(SaveInvoiceSettingsBody, { ...SETTINGS, invoice_prefix: "" })).toEqual({
      field: "invoice_prefix",
      message: PREFIX_FORMAT,
    });
    expect(PreviewInvoiceBody.parse({ ...SETTINGS, invoice_prefix: "" }).invoice_prefix).toBe("");
  });

  it("is the only prefix the preview accepts that saving does not", () => {
    const prefixes = ["", "A", "AB", "NFE", "ACME01", "ABCDEFGH", "ABCDEFGHI", "nfe", "NF E", "NFE\n", "ÄB", "12", "A-1"];
    for (const prefix of prefixes) {
      expect(PreviewInvoiceBody.shape.invoice_prefix.safeParse(prefix).success, prefix).toBe(
        prefix === "" || INVOICE_PREFIX_RE.test(prefix)
      );
      expect(SaveInvoiceSettingsBody.shape.invoice_prefix.safeParse(prefix).success, prefix).toBe(
        INVOICE_PREFIX_RE.test(prefix)
      );
    }
  });
});

// The JSON Schema a form reads, per input version. A change to a schema that
// alters its JSON Schema needs a new version: bump the constant in schemas.ts
// and add the new shape here, keeping the old one. invoice_config is
// InvoiceConfigSchema (src/lib/invoices/config-schema.ts), so a change there
// is a new version of both invoice bodies.
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

const SCHEDULE_PROPERTIES = {
  tiers: {
    minItems: 1,
    type: "array",
    items: {},
    title: "Tiers",
    description:
      "In order, each { label, min_kwh, max_kwh, rate_per_kwh }: min_kwh and rate_per_kwh above 0, each min_kwh one more than the previous max_kwh, and max_kwh null only on the last tier.",
  },
  service_charge: { type: "number", minimum: 0, title: "Service charge" },
  tax_rate: { type: "number", minimum: 0, maximum: 1, title: "Tax rate", description: "A fraction: 0.18 is 18%." },
};

const CREATE_RATE_SCHEDULE_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: {
      microgrid_id: {
        type: "string",
        format: "uuid",
        pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
      },
      ...SCHEDULE_PROPERTIES,
    },
    required: ["microgrid_id", "tiers", "service_charge", "tax_rate"],
    additionalProperties: false,
  },
};

const REVISE_RATE_SCHEDULE_SHAPES: Record<number, unknown> = {
  1: {
    $schema: SCHEMA,
    type: "object",
    properties: SCHEDULE_PROPERTIES,
    required: ["tiers", "service_charge", "tax_rate"],
    additionalProperties: false,
  },
};

const INVOICE_CONFIG_V1 = {
  type: "object",
  properties: {
    seller: {
      type: "object",
      properties: {
        legal_name: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        trade_name: {
          type: "string",
          maxLength: 200,
        },
        tax_ids: {
          maxItems: 4,
          type: "array",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                minLength: 1,
                maxLength: 20,
              },
              value: {
                type: "string",
                minLength: 1,
                maxLength: 64,
              },
            },
            required: ["label", "value"],
          },
        },
        address_lines: {
          maxItems: 6,
          type: "array",
          items: {
            type: "string",
            maxLength: 200,
          },
        },
        contact_email: {
          type: "string",
          pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
        },
        contact_phone: {
          type: "string",
          maxLength: 40,
        },
      },
      required: ["legal_name"],
    },
    branding: {
      type: "object",
      properties: {
        logo_storage_path: {
          anyOf: [
            {
              type: "string",
              maxLength: 500,
            },
            {
              type: "null",
            },
          ],
        },
        tagline: {
          type: "string",
          maxLength: 200,
        },
        primary_color: {
          type: "string",
          pattern: "^#[0-9a-fA-F]{6}$",
        },
        accent_color: {
          type: "string",
          pattern: "^#[0-9a-fA-F]{6}$",
        },
        whatsapp_number: {
          anyOf: [
            {
              type: "string",
              maxLength: 40,
            },
            {
              type: "null",
            },
          ],
        },
        document_title: {
          type: "string",
          maxLength: 40,
        },
      },
    },
    payment: {
      type: "object",
      properties: {
        due_days_after_issue: {
          type: "integer",
          minimum: 1,
          maximum: 60,
        },
      },
      required: ["due_days_after_issue"],
    },
    tax: {
      type: "object",
      properties: {
        show_section: {
          type: "boolean",
        },
        category_label: {
          type: "string",
          maxLength: 40,
        },
        rate_pct: {
          type: "integer",
          minimum: 0,
          maximum: 30,
        },
      },
    },
    notices: {
      type: "object",
      properties: {
        vat_text: {
          anyOf: [
            {
              type: "string",
              maxLength: 1000,
            },
            {
              type: "null",
            },
          ],
        },
        payment_instructions_text: {
          anyOf: [
            {
              type: "string",
              maxLength: 1000,
            },
            {
              type: "null",
            },
          ],
        },
        signature_disclaimer: {
          anyOf: [
            {
              type: "string",
              maxLength: 500,
            },
            {
              type: "null",
            },
          ],
        },
      },
    },
  },
  additionalProperties: false,
};

const invoiceShape = (prefixPattern: string) => ({
  $schema: SCHEMA,
  type: "object",
  properties: {
    invoice_prefix: { anyOf: [{ type: "string", pattern: prefixPattern }, { type: "null" }], title: "Invoice prefix" },
    invoice_config: { title: "Invoice settings", ...INVOICE_CONFIG_V1 },
  },
  required: ["invoice_prefix", "invoice_config"],
  additionalProperties: false,
});

const SAVE_INVOICE_SETTINGS_SHAPES: Record<number, unknown> = { 1: invoiceShape("^[A-Z0-9]{2,8}$") };
const PREVIEW_INVOICE_SHAPES: Record<number, unknown> = { 1: invoiceShape("^(?:[A-Z0-9]{2,8})?$") };

describe("pinned input versions", () => {
  it.each([
    ["CreateRateScheduleBody", CreateRateScheduleBody, CREATE_RATE_SCHEDULE_BODY_VERSION, CREATE_RATE_SCHEDULE_SHAPES, "CREATE_RATE_SCHEDULE_BODY_VERSION"],
    ["ReviseRateScheduleBody", ReviseRateScheduleBody, REVISE_RATE_SCHEDULE_BODY_VERSION, REVISE_RATE_SCHEDULE_SHAPES, "REVISE_RATE_SCHEDULE_BODY_VERSION"],
    ["SaveInvoiceSettingsBody", SaveInvoiceSettingsBody, SAVE_INVOICE_SETTINGS_BODY_VERSION, SAVE_INVOICE_SETTINGS_SHAPES, "SAVE_INVOICE_SETTINGS_BODY_VERSION"],
    ["PreviewInvoiceBody", PreviewInvoiceBody, PREVIEW_INVOICE_BODY_VERSION, PREVIEW_INVOICE_SHAPES, "PREVIEW_INVOICE_BODY_VERSION"],
  ] as const)("%s matches the shape pinned for its version", (_name, schema, version, shapes, constant) => {
    expect(
      z.toJSONSchema(schema, { io: "input" }),
      `The JSON Schema changed: bump ${constant} in src/lib/billing/schemas.ts and pin the new shape in this file.`
    ).toEqual(shapes[version]);
  });

  it("starts every version at 1", () => {
    expect(CREATE_RATE_SCHEDULE_BODY_VERSION).toBe(1);
    expect(REVISE_RATE_SCHEDULE_BODY_VERSION).toBe(1);
    expect(SAVE_INVOICE_SETTINGS_BODY_VERSION).toBe(1);
    expect(PREVIEW_INVOICE_BODY_VERSION).toBe(1);
  });
});

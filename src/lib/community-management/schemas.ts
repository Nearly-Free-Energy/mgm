/**
 * Body schemas for community management's write routes. Each route parses
 * with its schema (parseJsonBody), and COMMUNITY_MANAGEMENT_SURFACE's
 * actions take their input from the same schema, so the catalog and the
 * route share one definition (gui-surface.test.ts, check 2).
 *
 * These routes were in use before they were described, so each schema
 * takes what its route took and refuses what it refused, with the route's
 * own answers: the *_REFUSALS beside each, which parseJsonBody gives in
 * place of its generic 400. The capability's operations still validate
 * after the route, and schemas.test.ts holds each schema's answers to
 * theirs. A schema refuses more than its route did in two ways only: a key
 * the route ignored, and a value of a type the route read as null; both get
 * the generic 400. If an operation's validation changes, change its schema
 * and refusals with it.
 *
 * A change to a schema's JSON Schema is a new input version: bump its
 * constant (schemas.test.ts pins each version's shape).
 *
 * Client-safe: besides zod, its runtime imports are the currency and time
 * zone validators (src/lib/validation), which import nothing, and its
 * import of parse-body.ts is type-only. If any of these gains a server-only
 * or side-effecting runtime import, revisit.
 */
import { z } from "zod";
import type { BodyRefusals, RefusedBody } from "@/lib/validation/parse-body";
import { validateCurrency } from "@/lib/validation/currency";
import { validateTimezone } from "@/lib/validation/timezone";

type Issue = z.core.$ZodIssue;

const bodyError = (issue: { code: string; keys?: string[] }) =>
  issue.code === "unrecognized_keys"
    ? `Unknown field: ${(issue.keys ?? []).join(", ")}`
    : "Request body must be an object";

/** The answer each of these routes gave a body that was not JSON. */
const INVALID_JSON: RefusedBody = { status: 400, body: { error: "Invalid JSON body" } };

/** The loose UUID the operations check a device id with (8-4-4-4-12 hex digits), as z.guid() checks one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The top-level key an issue is under, or null for the body itself. */
const keyOf = (issue: Issue): string | null => (typeof issue.path[0] === "string" ? issue.path[0] : null);
/** An issue of the body itself not being an object. */
const notAnObject = (issue: Issue) => issue.path.length === 0 && issue.code === "invalid_type";

/** Text the route stores as given, trimmed, or as null when it is blank or null. */
const optionalText = (key: string, title: string) =>
  z.string({ error: `${key} must be text or null` }).nullable().optional().meta({ title });

const ADDRESS = {
  address_line1: optionalText("address_line1", "Address line 1"),
  address_line2: optionalText("address_line2", "Address line 2"),
  address_city: optionalText("address_city", "City"),
  address_region: optionalText("address_region", "Region"),
  address_country: optionalText("address_country", "Country"),
  address_postal_code: optionalText("address_postal_code", "Postal code"),
};

const NAME = "Name is required.";
const name = () => z.string({ error: NAME }).trim().min(1, { error: NAME }).meta({ title: "Name" });

// ── Communities ──

const ORG_ID = "Invalid organization id — expected UUID.";

/**
 * POST /api/communities. `org_id` is the organization the community goes
 * under, bound from the action's entity. Its refusal is the composer's
 * (composeCommunityManagement), which answered it before the capability.
 * Each send adds a community: names are not unique.
 */
export const CreateCommunityBody = z.strictObject(
  {
    org_id: z.guid({ error: ORG_ID }).meta({ title: "Organization" }),
    name: name(),
    ...ADDRESS,
    geography_notes: optionalText("geography_notes", "Geography notes"),
  },
  { error: bodyError }
);
export const CREATE_COMMUNITY_BODY_VERSION = 1;
export const CREATE_COMMUNITY_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    switch (keyOf(issue)) {
      case "org_id":
        return { status: 400, body: { error: issue.message, code: "community_invalid_org", field: "org_id" } };
      case "name":
        return { status: 422, body: { error: issue.message, code: "community_name_required", field: "name" } };
    }
    return null;
  },
};

/**
 * PATCH /api/communities/[id]. Only the keys sent are changed; blank text
 * or null clears a field. The community comes from the path and stays under
 * its organization. A body with no field is the capability's to refuse.
 */
export const UpdateCommunityBody = z.strictObject(
  {
    name: name().optional(),
    ...ADDRESS,
    geography_notes: optionalText("geography_notes", "Geography notes"),
  },
  { error: bodyError }
);
export const UPDATE_COMMUNITY_BODY_VERSION = 1;
export const UPDATE_COMMUNITY_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    if (notAnObject(issue)) return { status: 400, body: { error: "Invalid JSON body", code: "community_invalid_body" } };
    if (keyOf(issue) === "name") {
      return { status: 422, body: { error: issue.message, code: "community_name_required", field: "name" } };
    }
    return null;
  },
};

// ── Microgrids ──

const currency = () =>
  z
    .string({ error: "Currency is required." })
    .trim()
    .min(1, { error: "Currency is required." })
    .superRefine((value, ctx) => {
      const message = validateCurrency(value);
      if (message) ctx.addIssue({ code: "custom", message });
    })
    .meta({ title: "Currency", description: "An ISO 4217 code, such as UGX." });

const timezone = () =>
  z
    .string({ error: "Timezone is required." })
    .trim()
    .min(1, { error: "Timezone is required." })
    .superRefine((value, ctx) => {
      const message = validateTimezone(value);
      if (message) ctx.addIssue({ code: "custom", message });
    })
    .meta({ title: "Time zone", description: "An IANA zone id, such as Africa/Kampala, or UTC." });

/** The answers both microgrid routes gave for a name, a currency and a time zone. */
function microgridFieldRefusal(issue: Issue): RefusedBody | null {
  switch (keyOf(issue)) {
    case "name":
      return { status: 422, body: { error: issue.message, code: "microgrid_name_required", field: "name" } };
    case "currency":
      return { status: 422, body: { error: issue.message, code: "microgrid_invalid_currency", field: "currency" } };
    case "timezone":
      return { status: 422, body: { error: issue.message, code: "microgrid_invalid_timezone", field: "timezone" } };
  }
  return null;
}

/** A coordinate as the create route reads it: a number, or text it stores as a number when it is one and as none otherwise. */
const looseCoordinate = (key: "lat" | "lng", title: string) =>
  z
    .union([z.number(), z.string(), z.null()], { error: `${key} must be a number, text or null` })
    .optional()
    .meta({ title });

/**
 * POST /api/microgrids. `community_id` is the community it goes under,
 * bound from the action's entity; the route answered a malformed one itself,
 * with no code. A second send with the same name is refused: a microgrid's
 * name is unique in its community (microgrids_community_name_unique).
 */
export const CreateMicrogridBody = z.strictObject(
  {
    community_id: z.guid({ error: "Invalid community_id — expected UUID." }).meta({ title: "Community" }),
    name: name(),
    currency: currency(),
    timezone: timezone().optional(),
    lat: looseCoordinate("lat", "Latitude"),
    lng: looseCoordinate("lng", "Longitude"),
    ...ADDRESS,
  },
  { error: bodyError }
);
export const CREATE_MICROGRID_BODY_VERSION = 1;
export const CREATE_MICROGRID_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    if (keyOf(issue) === "community_id") return { status: 400, body: { error: issue.message, field: "community_id" } };
    return microgridFieldRefusal(issue);
  },
};

/** A coordinate as the update route reads it: a number, numeric text, or blank text or null to clear it. */
const coordinate = (key: "lat" | "lng", title: string) =>
  z
    .union(
      [
        z.number(),
        z.string().refine((s) => s.trim() === "" || Number.isFinite(Number(s)), { error: `Invalid ${key} value.` }),
        z.null(),
      ],
      { error: `${key} must be a number, text or null` }
    )
    .optional()
    .meta({ title, description: "Blank text or null clears it." });

/**
 * PATCH /api/microgrids/[id]. Only the keys sent are changed; blank text or
 * null clears a field. The microgrid comes from the path and stays under
 * its community. A body with no field is the capability's to refuse.
 */
export const UpdateMicrogridBody = z.strictObject(
  {
    name: name().optional(),
    currency: currency().optional(),
    timezone: timezone().optional(),
    ...ADDRESS,
    lat: coordinate("lat", "Latitude"),
    lng: coordinate("lng", "Longitude"),
  },
  { error: bodyError }
);
export const UPDATE_MICROGRID_BODY_VERSION = 1;
export const UPDATE_MICROGRID_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    if (notAnObject(issue)) return { status: 400, body: { error: "Invalid JSON body", code: "microgrid_invalid_body" } };
    const key = keyOf(issue);
    // The coordinate the route refused is text that is not a number. It read
    // any other type as null, which the union refuses as a whole.
    if ((key === "lat" || key === "lng") && issue.code === "custom") {
      return { status: 422, body: { error: issue.message, code: "microgrid_invalid_coordinate", field: key } };
    }
    return microgridFieldRefusal(issue);
  },
};

// ── Tenants ──

const ACCOUNT_NUMBER_MAX = 30;
const METER_SERIAL_MAX = 50;
const METER_TYPE_MAX = 50;
const CUSTOMER_TYPE = "customer_type must be 'residential' or 'commercial'";
const METER_TYPE = "meter_type must be a non-empty string";
const PHONE_REQUIRED = "tenant_phone_required";
const tooLong = (key: string, max: number) => `${key} must be ${max} characters or fewer`;

/** Text with a length limit: null or blank text stores none. */
const limitedText = (key: string, max: number, title: string) =>
  z
    .string({ error: `${key} must be a string or null` })
    .trim()
    .max(max, { error: tooLong(key, max) })
    .nullable()
    .meta({ title });

const customerType = () => z.enum(["residential", "commercial"], { error: CUSTOMER_TYPE });

/**
 * POST /api/tenants/with-meter. `microgrid_id` is the microgrid the tenant
 * belongs to, bound from the action's entity; the route answered a missing
 * one itself, with no code. With `device_id` the tenant gets that meter as
 * its primary consumption meter; without it, or with null or blank text,
 * it is billed from readings typed by hand. Each send without a meter adds
 * a tenant: names are not unique.
 */
export const CreateTenantBody = z.strictObject(
  {
    microgrid_id: z
      .string({ error: "microgrid_id is required." })
      .trim()
      .min(1, { error: "microgrid_id is required." })
      .meta({ title: "Microgrid" }),
    display_name: z
      .string({ error: "display_name is required." })
      .trim()
      .min(1, { error: "display_name is required." })
      .meta({ title: "Name" }),
    device_id: z
      .string({ error: "device_id must be a string, null, or omitted." })
      .nullable()
      .optional()
      .meta({ title: "Meter", description: "The meter's device id; null or blank for a tenant with no meter." }),
    primary_phone: z.string({ error: PHONE_REQUIRED }).trim().min(1, { error: PHONE_REQUIRED }).meta({ title: "Phone" }),
    account_number: limitedText("account_number", ACCOUNT_NUMBER_MAX, "Account number").optional(),
    meter_serial: limitedText("meter_serial", METER_SERIAL_MAX, "Meter serial").optional(),
    meter_type: z
      .string({ error: METER_TYPE })
      .trim()
      .max(METER_TYPE_MAX, { error: tooLong("meter_type", METER_TYPE_MAX) })
      .nullable()
      .optional()
      .meta({ title: "Meter type" }),
    customer_type: customerType().nullable().optional().meta({ title: "Customer type" }),
    primary_email: optionalText("primary_email", "Email"),
    ...ADDRESS,
    unit_label: optionalText("unit_label", "Unit"),
    geography_notes: optionalText("geography_notes", "Geography notes"),
  },
  { error: bodyError }
);
export const CREATE_TENANT_BODY_VERSION = 1;
export const CREATE_TENANT_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    const key = keyOf(issue);
    const at = (status: 400 | 422, code: string): RefusedBody => ({
      status,
      body: { error: issue.message, code, field: key ?? "" },
    });
    switch (key) {
      case "microgrid_id":
        return { status: 422, body: { error: issue.message, field: "microgrid_id" } };
      case "display_name":
        return at(422, "tenant_name_required");
      case "device_id":
        return at(422, "tenant_invalid_device");
      case "primary_phone":
        return at(400, "tenant_phone_required");
      case "account_number":
      case "meter_serial":
      case "meter_type":
        return at(400, issue.code === "too_big" ? `tenant_${key}_too_long` : `tenant_invalid_${key}`);
      case "customer_type":
        return at(400, "tenant_invalid_customer_type");
    }
    return null;
  },
};

/** The text fields PATCH /api/tenants/[id] reads as text or null, in the order it checks them, with their titles. */
const TENANT_TEXT = {
  primary_email: "Email",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  unit_label: "Unit",
  address_city: "City",
  address_region: "Region",
  address_country: "Country",
  address_postal_code: "Postal code",
  geography_notes: "Geography notes",
} as const;
type TenantText = keyof typeof TENANT_TEXT;
const tenantText = Object.fromEntries(
  (Object.entries(TENANT_TEXT) as [TenantText, string][]).map(([key, title]) => [
    key,
    z.string({ error: `${key} must be a string or null` }).trim().nullable().optional().meta({ title }),
  ])
) as Record<TenantText, z.ZodOptional<z.ZodNullable<z.ZodString>>>;

const DEVICE = "device_id must be a valid UUID or null";
const DISPLAY_NAME = "display_name must be a non-empty string";

/**
 * PATCH /api/tenants/[id]. Only the keys sent are changed; null or blank
 * text clears a text field. `device_id` makes that meter the tenant's
 * primary meter from today, and null or blank text unlinks it. The tenant
 * comes from the path. Unlike the other routes, this one always refused an
 * unknown key, before any other check. A body with no field is the
 * capability's to refuse.
 */
export const UpdateTenantBody = z.strictObject(
  {
    display_name: z.string({ error: DISPLAY_NAME }).trim().min(1, { error: DISPLAY_NAME }).optional().meta({ title: "Name" }),
    device_id: z
      .string({ error: DEVICE })
      .trim()
      .refine((s) => s === "" || UUID_RE.test(s), { error: DEVICE })
      .nullable()
      .optional()
      .meta({ title: "Meter", description: "The meter's device id; null or blank text unlinks the tenant's meter." }),
    ...tenantText,
    account_number: limitedText("account_number", ACCOUNT_NUMBER_MAX, "Account number").optional(),
    meter_serial: limitedText("meter_serial", METER_SERIAL_MAX, "Meter serial").optional(),
    primary_phone: z
      .string({ error: (issue) => (issue.input === null ? PHONE_REQUIRED : "primary_phone must be a string") })
      .trim()
      .min(1, { error: PHONE_REQUIRED })
      .optional()
      .meta({ title: "Phone" }),
    meter_type: z
      .string({ error: METER_TYPE })
      .trim()
      .min(1, { error: METER_TYPE })
      .max(METER_TYPE_MAX, { error: tooLong("meter_type", METER_TYPE_MAX) })
      .optional()
      .meta({ title: "Meter type" }),
    customer_type: customerType().optional().meta({ title: "Customer type" }),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? `Unsupported field: ${(issue.keys ?? [])[0]}` : "Request body must be an object",
  }
);
export const UPDATE_TENANT_BODY_VERSION = 1;
export const UPDATE_TENANT_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  unknownKeysFirst: true,
  issue(issue) {
    const answer = (code: string, reason?: string): RefusedBody => ({
      status: 400,
      body: { error: issue.message, code, ...(reason ? { reason } : {}) },
    });
    if (issue.code === "unrecognized_keys") return answer("tenant_unsupported_field", "unsupported_field");
    if (notAnObject(issue)) return answer("tenant_invalid_body");
    const key = keyOf(issue);
    switch (key) {
      case null:
        return null;
      case "display_name":
        return answer("tenant_invalid_display_name", "invalid_display_name");
      case "device_id":
        return answer("tenant_invalid_device", "invalid_device_id");
      case "primary_phone":
        return issue.message === PHONE_REQUIRED
          ? answer("tenant_phone_required", "tenant_phone_required")
          : answer("tenant_invalid_primary_phone", "invalid_primary_phone");
      case "account_number":
      case "meter_serial":
      case "meter_type":
        return issue.code === "too_big"
          ? answer(`tenant_${key}_too_long`, `${key}_too_long`)
          : answer(`tenant_invalid_${key}`, `invalid_${key}`);
      case "customer_type":
        return answer("tenant_invalid_customer_type", "invalid_customer_type");
      default:
        return answer(`tenant_invalid_${key}`, `invalid_${key}`);
    }
  },
};

const EMAIL = "Enter a valid email address.";

/**
 * POST /api/tenants/[id]/access. The unit comes from the path and the
 * account from this address: no field names an account by id. The address
 * is trimmed and lowercased, as Supabase Auth stores it and
 * fn_auth_sign_in_target compares it; nothing else is folded. This route
 * parsed with its schema from the start, so it answers the generic 400.
 */
export const TenantAccessGrantBody = z.strictObject(
  {
    email: z
      .string({ error: EMAIL })
      .trim()
      .toLowerCase()
      .max(254, { error: EMAIL })
      .pipe(z.email({ error: EMAIL }))
      .meta({ title: "Email address" }),
  },
  { error: bodyError }
);
export type TenantAccessGrantBody = z.output<typeof TenantAccessGrantBody>;
export const TENANT_ACCESS_GRANT_BODY_VERSION = 1;

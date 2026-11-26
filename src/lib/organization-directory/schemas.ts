/**
 * Body schemas for the organization directory's write routes. Each route
 * parses with its schema (parseJsonBody), and ORGANIZATION_DIRECTORY_SURFACE's
 * actions take their input from the same schema, so the catalog and the
 * route share one definition (gui-surface.test.ts, check 2).
 *
 * These routes were in use before they were described, so each schema takes
 * what its route took and refuses what it refused, with the route's own
 * answers: the *_REFUSALS beside each, which parseJsonBody gives in place of
 * its generic 400. A schema refuses more than its route did in two ways
 * only, as community management's do (../community-management/schemas.ts):
 * a key the route ignored, and a value of a type the route read as null or
 * blank; both get the generic 400. A body that is JSON but not an object
 * gets the answer the route gave its first field, which is what it gave
 * every such body but null (on null it failed with a 500).
 * schemas.test.ts holds each schema's answers to the route's own.
 *
 * A change to a schema's JSON Schema is a new input version: bump its
 * constant (schemas.test.ts pins each version's shape).
 *
 * Client-safe: besides zod, its runtime imports are the role constants
 * (@/lib/roles) and the email sender's address pattern
 * (@/lib/email/sender-input), which import nothing, and its import of
 * parse-body.ts is type-only. If any of these gains a server-only or
 * side-effecting runtime import, revisit.
 */
import { z } from "zod";
import { EMAIL_RE } from "@/lib/email/sender-input";
import { ORG_MANAGER, SUPER_ADMIN } from "@/lib/roles";
import type { BodyRefusals, RefusedBody } from "@/lib/validation/parse-body";

type Issue = z.core.$ZodIssue;

const bodyError = (issue: { code: string; keys?: string[] }) =>
  issue.code === "unrecognized_keys"
    ? `Unknown field: ${(issue.keys ?? []).join(", ")}`
    : "Request body must be an object";

/** The answer most of these routes gave a body that was not JSON. */
const INVALID_JSON: RefusedBody = { status: 400, body: { error: "Invalid JSON body" } };

/** The top-level key an issue is under, or null for the body itself. */
const keyOf = (issue: Issue): string | null => (typeof issue.path[0] === "string" ? issue.path[0] : null);
/** An issue of the body itself not being an object. */
const notAnObject = (issue: Issue) => issue.path.length === 0 && issue.code === "invalid_type";
/** An issue of a value of the wrong type, rather than a value of the right type the route refused. */
const wrongType = (issue: Issue) => issue.code === "invalid_type";

const acknowledged = (message: string) =>
  z.array(z.string({ error: message }).max(64, { error: message }), { error: message }).max(20, { error: message });

/**
 * The host's Confirmation (src/lib/gui/contract.ts) for a typed delete: what
 * the person typed. Optional in the schema, as community management's
 * delete bodies are, so that a request without one is answered by the
 * route, with 428 and what to type, rather than a 400: the route requires
 * it. `typed` has no length limit, because what it must match has none
 * (organizations.name is unbounded TEXT; a mail server's host name and an
 * account's address are checked when they are saved, not here).
 */
const typedConfirmation = (message: string) =>
  z
    .strictObject({ acknowledged: acknowledged(message), typed: z.string({ error: message }).optional() }, { error: message })
    .optional();

// ── Organizations ──

const NAME = "Name is required.";
const CITY = "City is required.";
const COUNTRY = "Country is required.";
const required = (message: string, title: string) =>
  z.string({ error: message }).trim().min(1, { error: message }).meta({ title });
/** Text the route stores trimmed, or as null when it is blank or null. */
const optionalText = (key: string, title: string) =>
  z.string({ error: `${key} must be text or null` }).nullable().optional().meta({ title });

/**
 * PATCH /api/organizations/[id]. Only the keys sent are changed. The name,
 * city and country cannot be cleared: each, when sent, must be text that is
 * not blank. The other address fields are stored trimmed, or as null when
 * blank. A body with no field is the route's to refuse ("No fields to
 * update."), after this parses it.
 */
export const UpdateOrganizationBody = z.strictObject(
  {
    name: required(NAME, "Name").optional(),
    address_line1: optionalText("address_line1", "Address line 1"),
    address_line2: optionalText("address_line2", "Address line 2"),
    address_city: required(CITY, "City").optional(),
    address_region: optionalText("address_region", "Region"),
    address_country: required(COUNTRY, "Country").optional(),
    address_postal_code: optionalText("address_postal_code", "Postal code"),
  },
  { error: bodyError }
);
export const UPDATE_ORGANIZATION_BODY_VERSION = 1;
export const UPDATE_ORGANIZATION_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    // The route found no field it knew in a body that was not an object.
    if (notAnObject(issue)) return { status: 400, body: { error: "No fields to update." } };
    const key = keyOf(issue);
    if (key === "name" || key === "address_city" || key === "address_country") {
      return { status: 422, body: { error: issue.message, field: key } };
    }
    return null;
  },
};

/**
 * DELETE /api/organizations/[id]. The organization comes from the path.
 * `confirmation` is a typed action's: the organization's name, which the
 * route requires.
 */
export const DeleteOrganizationBody = z.strictObject(
  { confirmation: typedConfirmation("confirmation needs the organization's name, typed") },
  { error: bodyError }
);
export const DELETE_ORGANIZATION_BODY_VERSION = 1;

// ── Email sender (RFC #186) ──

const LINE = /^[^\r\n]*$/;
const SENDER = {
  host: "Enter the mail server's name, for example smtp.example.com.",
  port: "Port must be 465 (TLS) or 587 (STARTTLS).",
  username: "Enter the username the mail server expects.",
  password: "The password is too long.",
  fromAddress: "Enter the address emails come from, for example notices@example.com.",
  fromName: "The sender name must be one line of at most 120 characters.",
  replyTo: "Enter a valid reply-to address, or leave it blank.",
  version: "version must be a positive integer or null.",
} as const;

/**
 * PUT /api/organizations/[id]/email-sender: test, then save. It takes what
 * parseSenderInput (@/lib/email/sender-input) takes and refuses what it
 * refuses, with its words, and the route still passes the parsed body to
 * parseSenderInput for its values. `password` is write-only: the catalog
 * and the form describe it, and nothing ever shows or prefills it. Blank
 * keeps the saved password while the server, port and username stay as
 * they are. `version` is the saved sender's version the person started
 * from (null before the first save); the route refuses any other with 409
 * version_conflict. Whether the host is a usable public name the route
 * checks after this (normalizeMailHost).
 */
export const SaveEmailSenderBody = z.strictObject(
  {
    host: z.string({ error: SENDER.host }).trim().min(1, { error: SENDER.host }).meta({ title: "Mail server" }),
    port: z.literal([465, 587], { error: SENDER.port }).meta({ title: "Port" }),
    username: z
      .string({ error: SENDER.username })
      .trim()
      .min(1, { error: SENDER.username })
      .max(320, { error: SENDER.username })
      .regex(LINE, { error: SENDER.username })
      .meta({ title: "Username" }),
    password: z
      .string({ error: SENDER.password })
      .max(1024, { error: SENDER.password })
      .optional()
      .meta({ title: "Password", description: "Leave blank to keep the saved one.", writeOnly: true }),
    fromAddress: z
      .string({ error: SENDER.fromAddress })
      .trim()
      .regex(EMAIL_RE, { error: SENDER.fromAddress })
      .max(320, { error: SENDER.fromAddress })
      .meta({ title: "From address" }),
    fromName: z
      .string({ error: SENDER.fromName })
      .trim()
      .max(120, { error: SENDER.fromName })
      .regex(LINE, { error: SENDER.fromName })
      .nullable()
      .optional()
      .meta({ title: "From name" }),
    replyTo: z
      .string({ error: SENDER.replyTo })
      .trim()
      .max(320, { error: SENDER.replyTo })
      .refine((value) => value === "" || EMAIL_RE.test(value), { error: SENDER.replyTo })
      .nullable()
      .optional()
      .meta({ title: "Reply-to address" }),
    version: z
      .int({ error: SENDER.version })
      .positive({ error: SENDER.version })
      .nullable()
      .optional()
      .meta({ title: "Saved version", description: "The saved settings' version you started from; null before the first save." }),
  },
  { error: bodyError }
);
export const SAVE_EMAIL_SENDER_BODY_VERSION = 1;
/** parseSenderInput's answer for a body that is not an object, JSON or not. */
const SENDER_NOT_AN_OBJECT: RefusedBody = { status: 422, body: { error: "Body must be an object.", field: "body" } };
/** The keys parseSenderInput read a value of another type from as blank, keeping it. */
const SENDER_LENIENT = new Set(["password", "fromName", "replyTo"]);
export const SAVE_EMAIL_SENDER_REFUSALS: BodyRefusals = {
  json: SENDER_NOT_AN_OBJECT,
  issue(issue) {
    if (notAnObject(issue)) return SENDER_NOT_AN_OBJECT;
    const key = keyOf(issue);
    if (key === null || !Object.hasOwn(SENDER, key)) return null;
    if (SENDER_LENIENT.has(key) && wrongType(issue)) return null;
    return { status: 422, body: { error: SENDER[key as keyof typeof SENDER], field: key } };
  },
};

/**
 * DELETE /api/organizations/[id]/email-sender. `confirmation` is a typed
 * action's: the saved mail server's name, which the route requires while a
 * sender is saved.
 */
export const RemoveEmailSenderBody = z.strictObject(
  { confirmation: typedConfirmation("confirmation needs the mail server's name, typed") },
  { error: bodyError }
);
export const REMOVE_EMAIL_SENDER_BODY_VERSION = 1;

// ── Plugins ──

const PLUGIN_REQUIRED = "plugin is required.";
const ENABLED = "enabled must be a boolean.";

/**
 * PATCH /api/organizations/[id]/plugins: turn one bundled plugin on or off
 * for the organization. Which names are plugins, which are core and what
 * each depends on stay the capability's to check (setOrganizationPluginEnabled).
 */
export const SetPluginBody = z.strictObject(
  {
    plugin: z
      .string({ error: PLUGIN_REQUIRED })
      .trim()
      .min(1, { error: PLUGIN_REQUIRED })
      .meta({ title: "Plugin", description: "A bundled plugin's name, such as billing." }),
    enabled: z.boolean({ error: ENABLED }).meta({ title: "On" }),
  },
  { error: bodyError }
);
export const SET_PLUGIN_BODY_VERSION = 1;
export const SET_PLUGIN_REFUSALS: BodyRefusals = {
  json: { status: 400, body: { error: "Invalid JSON body", code: "plugin_invalid_body" } },
  issue(issue) {
    if (notAnObject(issue) || keyOf(issue) === "plugin") {
      return { status: 400, body: { error: PLUGIN_REQUIRED, code: "unknown_plugin", field: "plugin" } };
    }
    if (keyOf(issue) === "enabled") return { status: 400, body: { error: ENABLED, code: "plugin_invalid", field: "enabled" } };
    return null;
  },
};

// ── Users ──

const ROLE = `Role must be one of '${SUPER_ADMIN}' or '${ORG_MANAGER}'.`;
const STAFF_ROLE = (message: string) =>
  z.enum([SUPER_ADMIN, ORG_MANAGER], { error: message }).meta({ title: "Role" });
/** A role's organization: read by the route only for org_manager, where it must be an organization's id. */
const SCOPE_ID = z
  .string({ error: "scope_id must be text or null" })
  .nullable()
  .optional()
  .meta({ title: "Organization", description: "The organization's id, for org_manager; null for super_admin." });

const INVITE_EMAIL = "A valid email is required.";
const inviteText = (key: string, title: string) =>
  z.string({ error: `${key} must be text or null` }).nullable().optional().meta({ title });

/**
 * POST /api/users/invite. The address is trimmed and kept as typed, as the
 * route kept it. `scope_id` is the organization an org_manager is invited
 * to, bound from the action's entity; the route ignores it for a
 * super_admin, and requires a UUID for an org_manager (its own 422, after
 * this parses). The names and phone fill only what the account's profile
 * leaves empty.
 */
export const InviteUserBody = z.strictObject(
  {
    email: z
      .string({ error: INVITE_EMAIL })
      .trim()
      .regex(EMAIL_RE, { error: INVITE_EMAIL })
      .meta({ title: "Email address" }),
    first_name: inviteText("first_name", "First name"),
    last_name: inviteText("last_name", "Last name"),
    phone: inviteText("phone", "Phone"),
    role: STAFF_ROLE(ROLE),
    scope_id: SCOPE_ID,
  },
  { error: bodyError }
);
export const INVITE_USER_BODY_VERSION = 1;
export const INVITE_USER_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    if (notAnObject(issue) || keyOf(issue) === "email") return { status: 422, body: { error: INVITE_EMAIL, field: "email" } };
    if (keyOf(issue) === "role") return { status: 422, body: { error: ROLE, field: "role" } };
    return null;
  },
};

/**
 * POST /api/users/[id]/resend-invite. The person comes from the path; the
 * route reads no field. The body is optional: the Users page sends none,
 * and the GUI host sends `{}`.
 */
export const ResendInviteBody = z.strictObject({}, { error: bodyError });
export const RESEND_INVITE_BODY_VERSION = 1;

const CHANGE_CONFIRMATION = "confirmation is a role change's, with nothing to tick or type";

/**
 * PATCH /api/users/[id]/role, which fn_change_user_role decides. `scope_id`
 * is read only for org_manager, where the route requires an organization's
 * id (its own 422, after this parses). `confirmation` is a ceremony's with
 * nothing to tick or type (org.change-role's prepare asks for neither), so
 * the route has nothing in it to check. If that prepare comes to ask for
 * something, add it here, bump the version and check it in the route.
 */
export const ChangeRoleBody = z.strictObject(
  {
    role: STAFF_ROLE(ROLE),
    scope_id: SCOPE_ID,
    confirmation: z
      .strictObject({ acknowledged: acknowledged(CHANGE_CONFIRMATION) }, { error: CHANGE_CONFIRMATION })
      .optional(),
  },
  { error: bodyError }
);
export const CHANGE_ROLE_BODY_VERSION = 1;
export const CHANGE_ROLE_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    if (notAnObject(issue) || keyOf(issue) === "role") return { status: 422, body: { error: ROLE } };
    return null;
  },
};

const PROFILE_FIELDS = ["first_name", "last_name", "phone"] as const;
const profileText = (key: (typeof PROFILE_FIELDS)[number], title: string) =>
  z.string({ error: `${key} must be a string or null.` }).nullable().optional().meta({ title });

/**
 * PATCH /api/users/[id]/profile. Only the keys sent are changed; blank text
 * or null clears a field. A body with no field is the route's to refuse,
 * after this parses it.
 */
export const UpdateProfileBody = z.strictObject(
  {
    first_name: profileText("first_name", "First name"),
    last_name: profileText("last_name", "Last name"),
    phone: profileText("phone", "Phone"),
  },
  { error: bodyError }
);
export const UPDATE_PROFILE_BODY_VERSION = 1;
export const UPDATE_PROFILE_REFUSALS: BodyRefusals = {
  json: INVALID_JSON,
  issue(issue) {
    if (notAnObject(issue)) return { status: 422, body: { error: "No updatable fields in request body." } };
    const key = keyOf(issue);
    if (key !== null && (PROFILE_FIELDS as readonly string[]).includes(key)) {
      return { status: 422, body: { error: issue.message, field: key } };
    }
    return null;
  },
};

/**
 * DELETE /api/users/[id]: remove a person's staff access. `confirmation` is
 * a typed action's: the person's email address, which the route requires
 * for anyone the caller can see.
 */
export const RemoveUserBody = z.strictObject(
  { confirmation: typedConfirmation("confirmation needs the person's email address, typed") },
  { error: bodyError }
);
export const REMOVE_USER_BODY_VERSION = 1;

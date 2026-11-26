/**
 * The organization directory's body schemas (../schemas.ts).
 *
 * Each route answered its own refusals before it parsed with a schema. For
 * each body in a corpus of faults, the answer through parseJsonBody with the
 * schema and its refusals is the answer the route gave before, written out
 * here from the route as it was. Where the route took a body, the schema
 * takes it too, or refuses it with the generic 400 for one of the two
 * reasons ../schemas.ts gives (a key the route ignored, a value of a type it
 * read as null or blank). The email sender's schema is held to
 * parseSenderInput itself, which the route still runs after it.
 *
 * And each schema's JSON Schema, pinned for its input version.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseSenderInput } from "@/lib/email/sender-input";
import { parseJsonBody, type BodyRefusals } from "@/lib/validation/parse-body";
import {
  CHANGE_ROLE_BODY_VERSION,
  CHANGE_ROLE_REFUSALS,
  ChangeRoleBody,
  DELETE_ORGANIZATION_BODY_VERSION,
  DeleteOrganizationBody,
  INVITE_USER_BODY_VERSION,
  INVITE_USER_REFUSALS,
  InviteUserBody,
  REMOVE_EMAIL_SENDER_BODY_VERSION,
  REMOVE_USER_BODY_VERSION,
  RESEND_INVITE_BODY_VERSION,
  RemoveEmailSenderBody,
  RemoveUserBody,
  ResendInviteBody,
  SAVE_EMAIL_SENDER_BODY_VERSION,
  SAVE_EMAIL_SENDER_REFUSALS,
  SET_PLUGIN_BODY_VERSION,
  SET_PLUGIN_REFUSALS,
  SaveEmailSenderBody,
  SetPluginBody,
  UPDATE_ORGANIZATION_BODY_VERSION,
  UPDATE_ORGANIZATION_REFUSALS,
  UPDATE_PROFILE_BODY_VERSION,
  UPDATE_PROFILE_REFUSALS,
  UpdateOrganizationBody,
  UpdateProfileBody,
} from "../schemas";

type Answer = { status: number; body: Record<string, unknown> } | { ok: unknown };

/** The route's answer to `raw` through parseJsonBody, or the parsed body. */
async function answer(raw: string, schema: z.ZodType, refusals?: BodyRefusals): Promise<Answer> {
  const parsed = await parseJsonBody(new Request("http://localhost", { method: "POST", body: raw }), schema, { refusals });
  if (parsed.ok) return { ok: parsed.data };
  return { status: parsed.response.status, body: (await parsed.response.json()) as Record<string, unknown> };
}
const json = (body: unknown) => JSON.stringify(body);
const generic = (error: string, field?: string) => ({ status: 400, body: { error, code: "invalid_body", ...(field ? { field } : {}) } });

describe("UpdateOrganizationBody (PATCH /api/organizations/[id])", () => {
  const route = (raw: string) => answer(raw, UpdateOrganizationBody, UPDATE_ORGANIZATION_REFUSALS);
  it.each([
    ["not JSON", "{", { status: 400, body: { error: "Invalid JSON body" } }],
    ["a blank name", json({ name: "  " }), { status: 422, body: { error: "Name is required.", field: "name" } }],
    ["a name that is not text", json({ name: 3 }), { status: 422, body: { error: "Name is required.", field: "name" } }],
    ["a null name", json({ name: null }), { status: 422, body: { error: "Name is required.", field: "name" } }],
    ["a blank city", json({ address_city: "" }), { status: 422, body: { error: "City is required.", field: "address_city" } }],
    ["a null country", json({ address_country: null }), { status: 422, body: { error: "Country is required.", field: "address_country" } }],
    // The route checked the name, then the city, then the country.
    ["a blank name and city", json({ address_city: "", name: "" }), { status: 422, body: { error: "Name is required.", field: "name" } }],
    ["a blank city and country", json({ address_country: "", address_city: "" }), { status: 422, body: { error: "City is required.", field: "address_city" } }],
    ["an array", json([]), { status: 400, body: { error: "No fields to update." } }],
    ["null, on which the route failed", "null", { status: 400, body: { error: "No fields to update." } }],
  ])("answers %s as the route did", async (_what, raw, expected) => {
    expect(await route(raw)).toEqual(expected);
  });

  it("takes the fields the page sends, trimming the required ones, and leaves the rest to the route", async () => {
    expect(await route(json({ name: " Acme ", address_city: " Kampala", address_line1: "", address_region: null }))).toEqual({
      ok: { name: "Acme", address_city: "Kampala", address_line1: "", address_region: null },
    });
    // No field: the route answers "No fields to update." after parsing.
    expect(await route(json({}))).toEqual({ ok: {} });
  });

  it("refuses what the route ignored or read as null with the generic 400", async () => {
    expect(await route(json({ name: "Acme", org_id: "x" }))).toEqual(generic("Unknown field: org_id"));
    expect(await route(json({ address_line1: 5 }))).toEqual(generic("address_line1 must be text or null", "address_line1"));
  });
});

describe("SaveEmailSenderBody (PUT /api/organizations/[id]/email-sender)", () => {
  const route = (raw: string) => answer(raw, SaveEmailSenderBody, SAVE_EMAIL_SENDER_REFUSALS);
  const good = {
    host: " smtp.example.test ",
    port: 587,
    username: "notices",
    password: " secret with spaces ",
    fromAddress: "notices@example.test",
    fromName: "Acme",
    replyTo: "",
    version: null,
  };
  /** Bodies parseSenderInput refuses or takes, each a fault of one or two fields. */
  const corpus: Record<string, unknown>[] = [
    good,
    { ...good, host: "" },
    { ...good, host: 5 },
    { ...good, port: 25 },
    { ...good, port: "587" },
    { ...good, username: "" },
    { ...good, username: "a\nb" },
    { ...good, username: "u".repeat(321) },
    { ...good, password: "p".repeat(1025) },
    { ...good, password: "" },
    { ...good, fromAddress: "nobody" },
    { ...good, fromAddress: `${"a".repeat(320)}@example.test` },
    { ...good, fromName: "two\nlines" },
    { ...good, fromName: "n".repeat(121) },
    { ...good, fromName: "" },
    { ...good, fromName: null },
    { ...good, replyTo: "nobody" },
    { ...good, replyTo: "reply@example.test" },
    { ...good, replyTo: null },
    { ...good, version: 0 },
    { ...good, version: 1.5 },
    { ...good, version: "1" },
    { ...good, version: 3 },
    { host: "", port: 25 },
    { ...good, port: 25, fromAddress: "nobody" },
    { ...good, username: "", version: 0 },
  ].map((body) => Object.fromEntries(Object.entries(body)));
  // Only the fields parseSenderInput requires.
  corpus.push({ host: good.host, port: good.port, username: good.username, fromAddress: good.fromAddress });

  it.each(corpus.map((body) => [json(body), body] as const))("answers %s as parseSenderInput does", async (raw, body) => {
    const before = parseSenderInput(body);
    const now = await route(raw);
    if (!before.ok) {
      expect(now).toEqual({ status: 422, body: { error: before.error, field: before.field } });
    } else {
      expect(now).toHaveProperty("ok");
      // The route runs parseSenderInput on what the schema returns: the same values.
      expect(parseSenderInput((now as { ok: unknown }).ok)).toEqual(before);
    }
  });

  it("answers a body that is not an object, JSON or not, as the route did", async () => {
    const notAnObject = { status: 422, body: { error: "Body must be an object.", field: "body" } };
    for (const raw of ["{", "null", "[]", '"smtp"']) expect(await route(raw)).toEqual(notAnObject);
  });

  it("refuses what parseSenderInput read as blank, or ignored, with the generic 400", async () => {
    // Each says what is wrong, not the route's answer for a bad value of the
    // right type ("The password is too long." for a password of 5).
    expect(await route(json({ ...good, password: 5 }))).toEqual(generic("password must be text.", "password"));
    expect(await route(json({ ...good, password: null }))).toEqual(generic("password must be text.", "password"));
    expect(await route(json({ ...good, fromName: 5 }))).toEqual(generic("fromName must be text or null.", "fromName"));
    expect(await route(json({ ...good, replyTo: false }))).toEqual(generic("replyTo must be text or null.", "replyTo"));
    expect(await route(json({ ...good, org_id: "x" }))).toEqual(generic("Unknown field: org_id"));
  });

  it("marks the password write-only, and only the password", () => {
    const described = z.toJSONSchema(SaveEmailSenderBody, { io: "input" }) as { properties: Record<string, { writeOnly?: boolean }> };
    expect(Object.entries(described.properties).filter(([, p]) => p.writeOnly).map(([k]) => k)).toEqual(["password"]);
  });
});

describe("SetPluginBody (PATCH /api/organizations/[id]/plugins)", () => {
  const route = (raw: string) => answer(raw, SetPluginBody, SET_PLUGIN_REFUSALS);
  const plugin = { status: 400, body: { error: "plugin is required.", code: "unknown_plugin", field: "plugin" } };
  const enabled = { status: 400, body: { error: "enabled must be a boolean.", code: "plugin_invalid", field: "enabled" } };
  it.each([
    ["not JSON", "{", { status: 400, body: { error: "Invalid JSON body", code: "plugin_invalid_body" } }],
    ["no plugin", json({ enabled: true }), plugin],
    ["a blank plugin", json({ plugin: " ", enabled: true }), plugin],
    ["a plugin that is not text", json({ plugin: 1, enabled: true }), plugin],
    ["no plugin and no enabled", json({}), plugin],
    ["enabled as text", json({ plugin: "billing", enabled: "yes" }), enabled],
    ["an array", json([]), plugin],
    ["null, on which the route failed", "null", plugin],
  ])("answers %s as the route did", async (_what, raw, expected) => {
    expect(await route(raw)).toEqual(expected);
  });

  it("trims the plugin's name, as the route did, and leaves whether it is one to the capability", async () => {
    expect(await route(json({ plugin: " billing ", enabled: false }))).toEqual({ ok: { plugin: "billing", enabled: false } });
    expect(await route(json({ plugin: "nonsense", enabled: true }))).toEqual({ ok: { plugin: "nonsense", enabled: true } });
    expect(await route(json({ plugin: "billing", enabled: true, note: "x" }))).toEqual(generic("Unknown field: note"));
  });
});

describe("InviteUserBody (POST /api/users/invite)", () => {
  const route = (raw: string) => answer(raw, InviteUserBody, INVITE_USER_REFUSALS);
  const email = { status: 422, body: { error: "A valid email is required.", field: "email" } };
  const role = { status: 422, body: { error: "Role must be one of 'super_admin' or 'org_manager'.", field: "role" } };
  it.each([
    ["not JSON", "{", { status: 400, body: { error: "Invalid JSON body" } }],
    ["no address", json({ role: "org_manager" }), email],
    ["an address that is not one", json({ email: "nobody", role: "org_manager" }), email],
    ["an address that is not text", json({ email: 5, role: "org_manager" }), email],
    ["a bad address and a bad role", json({ role: "tenant", email: "" }), email],
    ["the tenant role", json({ email: "a@example.test", role: "tenant" }), role],
    ["no role", json({ email: "a@example.test" }), role],
    ["an array", json([]), email],
    ["null, on which the route failed", "null", email],
  ])("answers %s as the route did", async (_what, raw, expected) => {
    expect(await route(raw)).toEqual(expected);
  });

  it("takes what the invitation form sends, trimming the address and keeping its case", async () => {
    const body = { email: " New.Person@Example.test ", first_name: "Ada", last_name: "", phone: "", role: "super_admin", scope_id: null };
    expect(await route(json(body))).toEqual({ ok: { ...body, email: "New.Person@Example.test" } });
    // The scope's form is the route's to check, for an org_manager only.
    expect(await route(json({ email: "a@example.test", role: "org_manager", scope_id: "not-a-uuid" }))).toHaveProperty("ok");
  });
});

describe("ChangeRoleBody (PATCH /api/users/[id]/role)", () => {
  const route = (raw: string) => answer(raw, ChangeRoleBody, CHANGE_ROLE_REFUSALS);
  const role = { status: 422, body: { error: "Role must be one of 'super_admin' or 'org_manager'." } };
  it.each([
    ["not JSON", "{", { status: 400, body: { error: "Invalid JSON body" } }],
    ["no role", json({}), role],
    ["the tenant role", json({ role: "tenant", scope_id: null }), role],
    ["the ems_operator role", json({ role: "ems_operator" }), role],
    ["an array", json([]), role],
    ["null, on which the route failed", "null", role],
  ])("answers %s as the route did", async (_what, raw, expected) => {
    expect(await route(raw)).toEqual(expected);
  });

  it("takes what the Users page sends, and a ceremony's confirmation with nothing in it", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(await route(json({ role: "org_manager", scope_id: id }))).toEqual({ ok: { role: "org_manager", scope_id: id } });
    expect(await route(json({ role: "super_admin", scope_id: null, confirmation: { acknowledged: [] } }))).toEqual({
      ok: { role: "super_admin", scope_id: null, confirmation: { acknowledged: [] } },
    });
    expect(await route(json({ role: "super_admin", confirmation: { acknowledged: [], typed: "x" } }))).toMatchObject({ status: 400 });
  });
});

describe("UpdateProfileBody (PATCH /api/users/[id]/profile)", () => {
  const route = (raw: string) => answer(raw, UpdateProfileBody, UPDATE_PROFILE_REFUSALS);
  it.each([
    ["not JSON", "{", { status: 400, body: { error: "Invalid JSON body" } }],
    ["a name that is not text", json({ first_name: 1 }), { status: 422, body: { error: "first_name must be a string or null.", field: "first_name" } }],
    ["a phone that is not text", json({ phone: [] }), { status: 422, body: { error: "phone must be a string or null.", field: "phone" } }],
    ["an array", json([]), { status: 422, body: { error: "No updatable fields in request body." } }],
    ["null, on which the route failed", "null", { status: 422, body: { error: "No updatable fields in request body." } }],
  ])("answers %s as the route did", async (_what, raw, expected) => {
    expect(await route(raw)).toEqual(expected);
  });

  it("takes the fields the profile forms send, and refuses a field the route ignored", async () => {
    expect(await route(json({ first_name: "Ada", phone: null }))).toEqual({ ok: { first_name: "Ada", phone: null } });
    expect(await route(json({}))).toEqual({ ok: {} });
    expect(await route(json({ email: "a@example.test" }))).toEqual(generic("Unknown field: email"));
  });
});

describe("the bodies with nothing but a confirmation", () => {
  it.each([
    ["DeleteOrganizationBody", DeleteOrganizationBody],
    ["RemoveEmailSenderBody", RemoveEmailSenderBody],
    ["RemoveUserBody", RemoveUserBody],
  ] as const)("%s parses no confirmation, for the route to refuse, or one with what was typed, however long", (_name, schema) => {
    expect(schema.parse({})).toEqual({});
    const long = "x".repeat(5_000);
    expect(schema.parse({ confirmation: { acknowledged: [], typed: long } })).toEqual({ confirmation: { acknowledged: [], typed: long } });
    expect(schema.safeParse({ confirmation: { typed: "x" } }).success).toBe(false);
    expect(schema.safeParse({ name: "x" }).success).toBe(false);
  });

  it("ResendInviteBody takes the host's empty object and nothing else", () => {
    expect(ResendInviteBody.parse({})).toEqual({});
    expect(ResendInviteBody.safeParse({ email: "a@example.test" }).success).toBe(false);
  });
});

// ── Pinned input versions ──

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const nullableText = (title: string) => ({ title, type: ["string", "null"] });
const required = (title: string) => ({ type: "string", minLength: 1, title });
const confirmation = (typed: boolean) => ({
  type: "object",
  properties: {
    acknowledged: { maxItems: 20, type: "array", items: { type: "string", maxLength: 64 } },
    ...(typed ? { typed: { type: "string" } } : {}),
  },
  required: ["acknowledged"],
  additionalProperties: false,
});
const typedOnly = { $schema: SCHEMA, type: "object", properties: { confirmation: confirmation(true) }, additionalProperties: false };
const ROLE = { type: "string", enum: ["super_admin", "org_manager"], title: "Role" };
const SCOPE = {
  title: "Organization",
  description: "The organization's id, for org_manager; null for super_admin.",
  type: ["string", "null"],
};
const EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

const SHAPES: Record<string, Record<number, unknown>> = {
  UpdateOrganizationBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        name: required("Name"),
        address_line1: nullableText("Address line 1"),
        address_line2: nullableText("Address line 2"),
        address_city: required("City"),
        address_region: nullableText("Region"),
        address_country: required("Country"),
        address_postal_code: nullableText("Postal code"),
      },
      additionalProperties: false,
    },
  },
  DeleteOrganizationBody: { 1: typedOnly },
  SaveEmailSenderBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        host: required("Mail server"),
        port: { type: "number", enum: [465, 587], title: "Port" },
        username: { type: "string", minLength: 1, maxLength: 320, pattern: "^[^\\r\\n]*$", title: "Username" },
        password: { title: "Password", description: "Leave blank to keep the saved one.", writeOnly: true, type: "string", maxLength: 1024 },
        fromAddress: { type: "string", maxLength: 320, pattern: EMAIL_PATTERN, title: "From address" },
        fromName: { title: "From name", anyOf: [{ type: "string", maxLength: 120, pattern: "^[^\\r\\n]*$" }, { type: "null" }] },
        replyTo: { title: "Reply-to address", anyOf: [{ type: "string", maxLength: 320 }, { type: "null" }] },
        version: {
          title: "Saved version",
          description: "The saved settings' version you started from; null before the first save.",
          anyOf: [{ type: "integer", exclusiveMinimum: 0, maximum: 9007199254740991 }, { type: "null" }],
        },
      },
      required: ["host", "port", "username", "fromAddress"],
      additionalProperties: false,
    },
  },
  RemoveEmailSenderBody: { 1: typedOnly },
  SetPluginBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        plugin: { type: "string", minLength: 1, title: "Plugin", description: "A bundled plugin's name, such as billing." },
        enabled: { type: "boolean", title: "On" },
      },
      required: ["plugin", "enabled"],
      additionalProperties: false,
    },
  },
  InviteUserBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        email: { type: "string", pattern: EMAIL_PATTERN, title: "Email address" },
        first_name: nullableText("First name"),
        last_name: nullableText("Last name"),
        phone: nullableText("Phone"),
        role: ROLE,
        scope_id: SCOPE,
      },
      required: ["email", "role"],
      additionalProperties: false,
    },
  },
  ResendInviteBody: { 1: { $schema: SCHEMA, type: "object", properties: {}, additionalProperties: false } },
  ChangeRoleBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: { role: ROLE, scope_id: SCOPE, confirmation: confirmation(false) },
      required: ["role"],
      additionalProperties: false,
    },
  },
  UpdateProfileBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: { first_name: nullableText("First name"), last_name: nullableText("Last name"), phone: nullableText("Phone") },
      additionalProperties: false,
    },
  },
  RemoveUserBody: { 1: typedOnly },
};

describe("pinned input versions", () => {
  it.each([
    ["UpdateOrganizationBody", UpdateOrganizationBody, UPDATE_ORGANIZATION_BODY_VERSION, "UPDATE_ORGANIZATION_BODY_VERSION"],
    ["DeleteOrganizationBody", DeleteOrganizationBody, DELETE_ORGANIZATION_BODY_VERSION, "DELETE_ORGANIZATION_BODY_VERSION"],
    ["SaveEmailSenderBody", SaveEmailSenderBody, SAVE_EMAIL_SENDER_BODY_VERSION, "SAVE_EMAIL_SENDER_BODY_VERSION"],
    ["RemoveEmailSenderBody", RemoveEmailSenderBody, REMOVE_EMAIL_SENDER_BODY_VERSION, "REMOVE_EMAIL_SENDER_BODY_VERSION"],
    ["SetPluginBody", SetPluginBody, SET_PLUGIN_BODY_VERSION, "SET_PLUGIN_BODY_VERSION"],
    ["InviteUserBody", InviteUserBody, INVITE_USER_BODY_VERSION, "INVITE_USER_BODY_VERSION"],
    ["ResendInviteBody", ResendInviteBody, RESEND_INVITE_BODY_VERSION, "RESEND_INVITE_BODY_VERSION"],
    ["ChangeRoleBody", ChangeRoleBody, CHANGE_ROLE_BODY_VERSION, "CHANGE_ROLE_BODY_VERSION"],
    ["UpdateProfileBody", UpdateProfileBody, UPDATE_PROFILE_BODY_VERSION, "UPDATE_PROFILE_BODY_VERSION"],
    ["RemoveUserBody", RemoveUserBody, REMOVE_USER_BODY_VERSION, "REMOVE_USER_BODY_VERSION"],
  ] as const)("%s matches the shape pinned for its version", (name, schema, version, constant) => {
    expect(version).toBe(1);
    expect(
      JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" }))),
      `The JSON Schema changed: bump ${constant} in src/lib/organization-directory/schemas.ts and pin the new shape in this file.`
    ).toEqual(SHAPES[name][version]);
  });
});

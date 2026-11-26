/**
 * Community management's body schemas (../schemas.ts).
 *
 * TenantAccessGrantBody: one address, trimmed and lowercased, and no other
 * field, so no caller names an account by id.
 *
 * The schemas of the routes that answered their own refusals before they
 * parsed with a schema: for each body in a corpus of single and double
 * faults, the route's answer through parseJsonBody with the schema and its
 * refusals is the answer the route gave before, which is its pre-check's
 * (the composer's or the route's own) or else the capability operation's.
 * Where the route took the body, the schema takes it too, or refuses it
 * with the generic 400 for one of the two reasons ../schemas.ts gives (a key
 * the route ignored, a value of a type it read as null), and the operation
 * writes the same from the schema's output as from the body itself. A body
 * that is JSON but not an object is in the corpus too: null, on which a
 * create route failed with a 500, gets the answer that route gave every
 * other such body.
 *
 * And each schema's JSON Schema, pinned for its input version.
 */
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import { parseJsonBody, type BodyRefusals } from "@/lib/validation/parse-body";
import { createCommunityOperation, updateCommunityOperation } from "../operations/communities";
import { createMicrogridOperation, updateMicrogridOperation } from "../operations/microgrids";
import { createTenantOperation, updateTenantOperation } from "../operations/tenants";
import type { CommunityManagementRepository, CommunityManagementResult, OrganizationScope } from "../types";
import {
  CREATE_COMMUNITY_BODY_VERSION,
  CREATE_COMMUNITY_REFUSALS,
  CREATE_MICROGRID_BODY_VERSION,
  CREATE_MICROGRID_REFUSALS,
  CREATE_TENANT_BODY_VERSION,
  CREATE_TENANT_REFUSALS,
  CreateCommunityBody,
  CreateMicrogridBody,
  CreateTenantBody,
  DELETE_COMMUNITY_BODY_VERSION,
  DELETE_MICROGRID_BODY_VERSION,
  DELETE_TENANT_BODY_VERSION,
  DeleteCommunityBody,
  DeleteMicrogridBody,
  DeleteTenantBody,
  REVOKE_TENANT_ACCESS_BODY_VERSION,
  RevokeTenantAccessBody,
  TENANT_ACCESS_GRANT_BODY_VERSION,
  TenantAccessGrantBody,
  UPDATE_COMMUNITY_BODY_VERSION,
  UPDATE_COMMUNITY_REFUSALS,
  UPDATE_MICROGRID_BODY_VERSION,
  UPDATE_MICROGRID_REFUSALS,
  UPDATE_TENANT_BODY_VERSION,
  UPDATE_TENANT_REFUSALS,
  UpdateCommunityBody,
  UpdateMicrogridBody,
  UpdateTenantBody,
} from "../schemas";

describe("TenantAccessGrantBody", () => {
  it("trims and lowercases the address, and folds nothing else", () => {
    expect(TenantAccessGrantBody.parse({ email: "  Renter.Name+Unit@Example.TEST " })).toEqual({
      email: "renter.name+unit@example.test",
    });
  });

  it.each([
    [{}, "Enter a valid email address.", "email"],
    [{ email: 42 }, "Enter a valid email address.", "email"],
    [{ email: "" }, "Enter a valid email address.", "email"],
    [{ email: "not-an-address" }, "Enter a valid email address.", "email"],
    [{ email: `${"a".repeat(250)}@example.test` }, "Enter a valid email address.", "email"],
    [{ email: "renter@example.test", user_id: "00000000-0000-4000-8000-000000000001" }, "Unknown field: user_id", undefined],
    [null, "Request body must be an object", undefined],
  ])("refuses %j", (body, message, field) => {
    const parsed = TenantAccessGrantBody.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const [issue] = parsed.error.issues;
    expect(issue.message).toBe(message);
    expect(typeof issue.path[0] === "string" ? issue.path[0] : undefined).toBe(field);
  });
});

// ── The routes' own answers ──

const ORG = "e2780000-0000-4000-8000-0000000000aa";
const COMMUNITY = "e2780000-0000-4000-8001-0000000000aa";
const MICROGRID = "e2780000-0000-4000-8002-0000000000aa";
const TENANT = "e2780000-0000-4000-8004-0000000000aa";
const DEVICE = "e2780000-0000-4000-8007-0000000000aa";
const SCOPE: OrganizationScope = { organizationId: ORG, userId: "e2780000-0000-4000-8009-0000000000aa", roles: [] };

type Answer = "accepted" | { status: number; body: Record<string, unknown> };
type Write = [method: string, args: unknown[]];

/** A repository on which every read finds the record and every write succeeds, recording the writes. */
function fakeRepository(writes: Write[]): CommunityManagementRepository {
  const write =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      writes.push([method, args]);
      return result;
    };
  return {
    getAuthenticatedUserId: async () => SCOPE.userId,
    getUserRoles: async () => [],
    isPluginEnabled: async () => true,
    getCommunityOrganizationId: async () => ORG,
    getMicrogridOrganization: async () => ({ microgridId: MICROGRID, communityId: COMMUNITY, orgId: ORG }),
    findTenant: async () => ({ data: { id: TENANT, microgrid_id: MICROGRID }, error: null }),
    findDeviceLink: async () => null,
    getOpenDeviceLink: async () => null,
    refetchTenant: async () => ({ data: { id: TENANT }, error: null }),
    countBillingLineItems: async () => ({ count: 0, error: null }),
    getMicrogridCurrencyUse: async () => ({ data: { currency: "UGX", closedPeriods: 0 }, error: null }),
    resolveHierarchyLevels: async () => [],
    insertCommunity: write("insertCommunity", { data: { id: COMMUNITY }, error: null }),
    updateCommunity: write("updateCommunity", { data: { id: COMMUNITY }, error: null }),
    insertMicrogrid: write("insertMicrogrid", { data: { id: MICROGRID }, error: null }),
    updateMicrogrid: write("updateMicrogrid", { data: { id: MICROGRID }, error: null }),
    createTenant: write("createTenant", { data: TENANT, error: null }),
    updateTenantFields: write("updateTenantFields", { data: { id: TENANT }, error: null }),
    replaceDeviceLink: write("replaceDeviceLink", { id: "link", error: null }),
    closeDeviceLink: write("closeDeviceLink", null),
    deleteDeviceLink: write("deleteDeviceLink", null),
    deleteTenant: write("deleteTenant", { data: [{ id: TENANT }], error: null }),
  } as unknown as CommunityManagementRepository;
}

/** The route's answer for an operation's result, as its mapError builds it. */
function operationAnswer(result: CommunityManagementResult<unknown>): Answer {
  if (result.ok) return "accepted";
  const { status, code, message, field, reason } = result;
  return {
    status,
    body: { error: message, code, ...(field !== undefined ? { field } : {}), ...(reason !== undefined ? { reason } : {}) },
  };
}

async function schemaAnswer(schema: z.ZodType, refusals: BodyRefusals, body: unknown): Promise<{ answer: Answer; data?: unknown }> {
  const request = new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await parseJsonBody(request, schema, { refusals });
  if (parsed.ok) return { answer: "accepted", data: parsed.data };
  return { answer: { status: parsed.response.status, body: await parsed.response.json() } };
}

interface Route {
  name: string;
  schema: z.ZodObject;
  refusals: BodyRefusals;
  base: Record<string, unknown>;
  /**
   * What the route answered before the capability ran, or null when it went
   * on. It reads fields as the route did (`field`), so it throws on null, as
   * the route did.
   */
  pre?: (body: unknown) => Answer | null;
  run(repo: CommunityManagementRepository, body: unknown): Promise<CommunityManagementResult<unknown>>;
  /**
   * Why the route took a body the schema refuses with the generic 400: a
   * key it ignored, or a value of a type it read as null. Null when neither
   * explains it, which fails the test.
   */
  lenient(key: string, value: unknown): string | null;
}

const isText = (v: unknown) => typeof v === "string" || v === null;
/** A field read off the body as the create routes read it, unchecked: a TypeError on null, undefined on any other value that is not an object. */
const field = (body: unknown, key: string): unknown => (body as Record<string, unknown>)[key];
const ADDRESS_KEYS = ["address_line1", "address_line2", "address_city", "address_region", "address_country", "address_postal_code"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A route's leniency: the keys it read, and those of them whose values of another type it read as null. */
const leniency =
  (read: readonly string[], asNull: readonly string[], coordinates: readonly string[] = []) =>
  (key: string, value: unknown): string | null => {
    if (!read.includes(key)) return "a key the route ignored";
    if (asNull.includes(key) && !isText(value)) return "a value the route read as null";
    if (coordinates.includes(key) && !isText(value) && typeof value !== "number") return "a value the route read as null";
    return null;
  };

const ROUTES: Route[] = [
  {
    name: "POST /api/communities",
    schema: CreateCommunityBody,
    refusals: CREATE_COMMUNITY_REFUSALS,
    base: { org_id: ORG, name: "Kisakye", address_city: "Entebbe", geography_notes: "By the lake" },
    // composeCommunityManagement, with org_id or "".
    pre: (b) =>
      typeof field(b, "org_id") === "string" && UUID.test(field(b, "org_id") as string)
        ? null
        : { status: 400, body: { error: "Invalid organization id — expected UUID.", code: "community_invalid_org", field: "org_id" } },
    run: (repo, body) => createCommunityOperation(repo, SCOPE, body),
    lenient: leniency(["org_id", "name", ...ADDRESS_KEYS, "geography_notes"], [...ADDRESS_KEYS, "geography_notes"]),
  },
  {
    name: "PATCH /api/communities/[id]",
    schema: UpdateCommunityBody,
    refusals: UPDATE_COMMUNITY_REFUSALS,
    base: { name: "Kisakye", address_city: "Entebbe" },
    run: (repo, body) => updateCommunityOperation(repo, SCOPE, COMMUNITY, body),
    lenient: leniency(["name", ...ADDRESS_KEYS, "geography_notes"], [...ADDRESS_KEYS, "geography_notes"]),
  },
  {
    name: "POST /api/microgrids",
    schema: CreateMicrogridBody,
    refusals: CREATE_MICROGRID_REFUSALS,
    base: { community_id: COMMUNITY, name: "Site A", currency: "UGX", timezone: "Africa/Kampala", lat: "0.3", lng: 32.5, address_city: "Kampala" },
    // The route's own check, before it read the community.
    pre: (b) =>
      typeof field(b, "community_id") === "string" && UUID.test(field(b, "community_id") as string)
        ? null
        : { status: 400, body: { error: "Invalid community_id — expected UUID.", field: "community_id" } },
    run: (repo, body) => createMicrogridOperation(repo, SCOPE, body),
    lenient: leniency(["community_id", "name", "currency", "timezone", "lat", "lng", ...ADDRESS_KEYS], ADDRESS_KEYS, ["lat", "lng"]),
  },
  {
    name: "PATCH /api/microgrids/[id]",
    schema: UpdateMicrogridBody,
    refusals: UPDATE_MICROGRID_REFUSALS,
    base: { name: "Site A", currency: "UGX", timezone: "UTC", lat: "", lng: "32.5" },
    run: (repo, body) => updateMicrogridOperation(repo, SCOPE, MICROGRID, body),
    lenient: leniency(["name", "currency", "timezone", "lat", "lng", ...ADDRESS_KEYS], ADDRESS_KEYS, ["lat", "lng"]),
  },
  {
    name: "POST /api/tenants/with-meter",
    schema: CreateTenantBody,
    refusals: CREATE_TENANT_REFUSALS,
    base: {
      microgrid_id: MICROGRID,
      display_name: "Block A, Unit 1",
      device_id: DEVICE,
      primary_phone: "+256700000000",
      account_number: "ACC-1",
      meter_serial: "SN-1",
      meter_type: "Smart Submeter",
      customer_type: "residential",
      primary_email: "a@example.test",
      unit_label: "A1",
    },
    // The route's own check, before it read the microgrid.
    pre: (b) =>
      typeof field(b, "microgrid_id") === "string" && (field(b, "microgrid_id") as string).trim()
        ? null
        : { status: 422, body: { error: "microgrid_id is required.", field: "microgrid_id" } },
    run: (repo, body) => createTenantOperation(repo, SCOPE, body),
    lenient: leniency(
      [
        "microgrid_id",
        "display_name",
        "device_id",
        "primary_phone",
        "account_number",
        "meter_serial",
        "meter_type",
        "customer_type",
        "primary_email",
        ...ADDRESS_KEYS,
        "unit_label",
        "geography_notes",
      ],
      ["primary_email", ...ADDRESS_KEYS, "unit_label", "geography_notes"]
    ),
  },
  {
    name: "PATCH /api/tenants/[id]",
    schema: UpdateTenantBody,
    refusals: UPDATE_TENANT_REFUSALS,
    base: { display_name: "Block A, Unit 1", primary_phone: "+256700000000", device_id: DEVICE, account_number: "ACC-1", customer_type: "commercial" },
    run: (repo, body) => updateTenantOperation(repo, SCOPE, TENANT, body),
    // The route refused every unknown key and every type it did not read.
    lenient: () => null,
  },
];

/** Values each key is tried with, beside leaving it out. */
const PROBES: unknown[] = [
  null,
  "",
  "   ",
  " Text ",
  42,
  -1.5,
  true,
  [],
  {},
  "not-a-uuid",
  DEVICE,
  "x".repeat(31),
  "x".repeat(51),
  "12.5",
  "abc",
  "residential",
  "commercial",
  "UGX",
  "XY",
  "Africa/Kampala",
  "Kampala",
  "UTC",
];
const DOUBLE_FAULTS: unknown[] = [null, "", 42, "x".repeat(51)];
const OMIT = Symbol("omit");

/** JSON bodies that are not objects, each tried once. */
const NOT_OBJECTS: unknown[] = [[], null, "x", 1, true];

function bodiesOf(route: Route): { body: unknown; changed: [string, unknown][] }[] {
  const keys = [...new Set([...Object.keys(route.schema.shape), ...Object.keys(route.base)])];
  const set = (body: Record<string, unknown>, key: string, value: unknown) => {
    const next = { ...body };
    if (value === OMIT) delete next[key];
    else next[key] = value;
    return next;
  };
  const out: { body: unknown; changed: [string, unknown][] }[] = [{ body: route.base, changed: [] }];
  for (const key of keys) for (const value of [OMIT, ...PROBES]) out.push({ body: set(route.base, key, value), changed: [[key, value]] });
  out.push({ body: { ...route.base, extra: "x" }, changed: [["extra", "x"]] });
  out.push({ body: {}, changed: [] });
  for (const body of NOT_OBJECTS) out.push({ body, changed: [] });
  for (const [i, a] of keys.entries()) {
    for (const b of keys.slice(i + 1)) {
      for (const va of DOUBLE_FAULTS) {
        for (const vb of DOUBLE_FAULTS) out.push({ body: set(set(route.base, a, va), b, vb), changed: [[a, va], [b, vb]] });
      }
    }
    out.push({ body: { ...set(route.base, a, null), extra: 1 }, changed: [[a, null], ["extra", 1]] });
  }
  return out;
}

describe("each described route's schema keeps the route's own answers", () => {
  let info: MockInstance<typeof console.info>;
  beforeAll(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterAll(() => info.mockRestore());

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s", async (_name, route) => {
    const problems: string[] = [];
    let accepted = 0;
    let refused = 0;
    let newlyRefused = 0;
    const failed: string[] = [];
    // The route's answer, or, where it failed with a 500, the answer it gave
    // every other body that is not an object.
    const routeAnswer = async (body: unknown, raw: Write[]): Promise<Answer> => {
      try {
        return route.pre?.(body) ?? operationAnswer(await route.run(fakeRepository(raw), body));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        failed.push(JSON.stringify(body));
        return routeAnswer([], raw);
      }
    };
    for (const { body, changed } of bodiesOf(route)) {
      const show = JSON.stringify(body);
      const raw: Write[] = [];
      const before = await routeAnswer(body, raw);
      const { answer, data } = await schemaAnswer(route.schema, route.refusals, body);
      if (answer !== "accepted" && answer.body.code === "invalid_body") {
        // The generic 400: only for a body the route read more loosely.
        newlyRefused++;
        if (answer.status !== 400 || !changed.some(([key, value]) => route.lenient(key, value) !== null)) {
          problems.push(`${show}: the schema answers ${JSON.stringify(answer)}, the route answered ${JSON.stringify(before)}`);
        }
        continue;
      }
      // Otherwise the route goes on with the schema's output, as it now does, and answers as before.
      const shaped: Write[] = [];
      const after =
        answer === "accepted"
          ? (route.pre?.(data as Record<string, unknown>) ?? operationAnswer(await route.run(fakeRepository(shaped), data)))
          : answer;
      if (before === "accepted") accepted++;
      else refused++;
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        problems.push(`${show}: answered ${JSON.stringify(after)}, the route answered ${JSON.stringify(before)}`);
      } else if (JSON.stringify(shaped) !== JSON.stringify(raw)) {
        problems.push(`${show}: the schema's output writes ${JSON.stringify(shaped)}, the body wrote ${JSON.stringify(raw)}`);
      }
    }
    expect(problems).toEqual([]);
    // Only a create route, reading its parent id off null, failed.
    expect(failed).toEqual(route.pre ? ["null"] : []);
    // The corpus reaches both answers, so the comparison shows something.
    expect(accepted).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(10);
    if (route.name !== "PATCH /api/tenants/[id]") expect(newlyRefused).toBeGreaterThan(0);
    else expect(newlyRefused).toBe(0);
  });

  it("answers a body that is not JSON as each route did, with no code", async () => {
    for (const route of ROUTES) {
      const parsed = await parseJsonBody(
        new Request("http://localhost/api/x", { method: "POST", body: "{not json" }),
        route.schema,
        { refusals: route.refusals }
      );
      if (parsed.ok) throw new Error(route.name);
      expect([parsed.response.status, await parsed.response.json()], route.name).toEqual([400, { error: "Invalid JSON body" }]);
    }
  });

  it("refuses an unknown key on PATCH /api/tenants/[id] before any field, naming the first", async () => {
    const { answer } = await schemaAnswer(UpdateTenantBody, UPDATE_TENANT_REFUSALS, { display_name: "", zz: 1, yy: 2 });
    expect(answer).toEqual({
      status: 400,
      body: { error: "Unsupported field: zz", code: "tenant_unsupported_field", reason: "unsupported_field" },
    });
  });
});

describe("the delete bodies", () => {
  it.each([
    ["DeleteCommunityBody", DeleteCommunityBody],
    ["DeleteMicrogridBody", DeleteMicrogridBody],
    ["DeleteTenantBody", DeleteTenantBody],
  ] as const)("%s parses no confirmation, for the route to refuse, or one with the typed name, however long", (_name, schema) => {
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ confirmation: { acknowledged: [], typed: "Kisakye" } })).toEqual({
      confirmation: { acknowledged: [], typed: "Kisakye" },
    });
    // A name has no length limit, so neither has what is typed for it.
    const long = "x".repeat(5_000);
    expect(schema.parse({ confirmation: { acknowledged: [], typed: long } })).toEqual({ confirmation: { acknowledged: [], typed: long } });
    expect(schema.safeParse({ confirmation: { typed: "Kisakye" } }).success).toBe(false);
    expect(schema.safeParse({ name: "Kisakye" }).success).toBe(false);
  });

  it("RevokeTenantAccessBody takes no confirmation, or one with nothing typed", () => {
    expect(RevokeTenantAccessBody.parse({})).toEqual({});
    expect(RevokeTenantAccessBody.parse({ confirmation: { acknowledged: [] } })).toEqual({ confirmation: { acknowledged: [] } });
    expect(RevokeTenantAccessBody.safeParse({ confirmation: { acknowledged: [], typed: "a@example.test" } }).success).toBe(false);
  });
});

// ── Pinned input versions ──

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const text = (title: string) => ({ type: ["string", "null"], title });
const ADDRESS_SHAPE = {
  address_line1: text("Address line 1"),
  address_line2: text("Address line 2"),
  address_city: text("City"),
  address_region: text("Region"),
  address_country: text("Country"),
  address_postal_code: text("Postal code"),
};
const NAME_SHAPE = { type: "string", minLength: 1, title: "Name" };
const CURRENCY_SHAPE = { type: "string", minLength: 1, title: "Currency", description: "An ISO 4217 code, such as UGX." };
const TIMEZONE_SHAPE = {
  type: "string",
  minLength: 1,
  title: "Time zone",
  description: "An IANA zone id, such as Africa/Kampala, or UTC.",
};
const GUID = "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$";
const confirmationShape = (typed: boolean) => ({
  type: "object",
  properties: {
    acknowledged: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } },
    ...(typed ? { typed: { type: "string" } } : {}),
  },
  required: ["acknowledged"],
  additionalProperties: false,
});
const deleteShape = (typed: boolean) => ({
  $schema: SCHEMA,
  type: "object",
  properties: { confirmation: confirmationShape(typed) },
  additionalProperties: false,
});
const limited = (max: number, title: string) => ({ anyOf: [{ type: "string", maxLength: max }, { type: "null" }], title });
const CUSTOMER_TYPES = { type: "string", enum: ["residential", "commercial"] };

const SHAPES: Record<string, Record<number, unknown>> = {
  CreateCommunityBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        org_id: { type: "string", format: "uuid", pattern: GUID, title: "Organization" },
        name: NAME_SHAPE,
        ...ADDRESS_SHAPE,
        geography_notes: text("Geography notes"),
      },
      required: ["org_id", "name"],
      additionalProperties: false,
    },
  },
  UpdateCommunityBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: { name: NAME_SHAPE, ...ADDRESS_SHAPE, geography_notes: text("Geography notes") },
      additionalProperties: false,
    },
  },
  CreateMicrogridBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        community_id: { type: "string", format: "uuid", pattern: GUID, title: "Community" },
        name: NAME_SHAPE,
        currency: CURRENCY_SHAPE,
        timezone: TIMEZONE_SHAPE,
        lat: { type: ["number", "string", "null"], title: "Latitude" },
        lng: { type: ["number", "string", "null"], title: "Longitude" },
        ...ADDRESS_SHAPE,
      },
      required: ["community_id", "name", "currency"],
      additionalProperties: false,
    },
  },
  UpdateMicrogridBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        name: NAME_SHAPE,
        currency: CURRENCY_SHAPE,
        timezone: TIMEZONE_SHAPE,
        ...ADDRESS_SHAPE,
        lat: { type: ["number", "string", "null"], title: "Latitude", description: "Blank text or null clears it." },
        lng: { type: ["number", "string", "null"], title: "Longitude", description: "Blank text or null clears it." },
      },
      additionalProperties: false,
    },
  },
  CreateTenantBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        microgrid_id: { type: "string", minLength: 1, title: "Microgrid" },
        display_name: { type: "string", minLength: 1, title: "Name" },
        device_id: {
          type: ["string", "null"],
          title: "Meter",
          description: "The meter's device id; null or blank for a tenant with no meter.",
        },
        primary_phone: { type: "string", minLength: 1, title: "Phone" },
        account_number: limited(30, "Account number"),
        meter_serial: limited(50, "Meter serial"),
        meter_type: { anyOf: [{ type: "string", maxLength: 50 }, { type: "null" }], title: "Meter type" },
        customer_type: { anyOf: [CUSTOMER_TYPES, { type: "null" }], title: "Customer type" },
        primary_email: text("Email"),
        ...ADDRESS_SHAPE,
        unit_label: text("Unit"),
        geography_notes: text("Geography notes"),
      },
      required: ["microgrid_id", "display_name", "primary_phone"],
      additionalProperties: false,
    },
  },
  UpdateTenantBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        display_name: { type: "string", minLength: 1, title: "Name" },
        device_id: {
          type: ["string", "null"],
          title: "Meter",
          description: "The meter's device id; null or blank text unlinks the tenant's meter.",
        },
        primary_email: text("Email"),
        address_line1: text("Address line 1"),
        address_line2: text("Address line 2"),
        unit_label: text("Unit"),
        address_city: text("City"),
        address_region: text("Region"),
        address_country: text("Country"),
        address_postal_code: text("Postal code"),
        geography_notes: text("Geography notes"),
        account_number: limited(30, "Account number"),
        meter_serial: limited(50, "Meter serial"),
        primary_phone: { type: "string", minLength: 1, title: "Phone" },
        meter_type: { type: "string", minLength: 1, maxLength: 50, title: "Meter type" },
        customer_type: { ...CUSTOMER_TYPES, title: "Customer type" },
      },
      additionalProperties: false,
    },
  },
  TenantAccessGrantBody: {
    1: {
      $schema: SCHEMA,
      type: "object",
      properties: { email: { type: "string", maxLength: 254, title: "Email address" } },
      required: ["email"],
      additionalProperties: false,
    },
  },
  DeleteCommunityBody: { 1: deleteShape(true) },
  DeleteMicrogridBody: { 1: deleteShape(true) },
  DeleteTenantBody: { 1: deleteShape(true) },
  RevokeTenantAccessBody: { 1: deleteShape(false) },
};

describe("pinned input versions", () => {
  it.each([
    ["CreateCommunityBody", CreateCommunityBody, CREATE_COMMUNITY_BODY_VERSION, "CREATE_COMMUNITY_BODY_VERSION"],
    ["UpdateCommunityBody", UpdateCommunityBody, UPDATE_COMMUNITY_BODY_VERSION, "UPDATE_COMMUNITY_BODY_VERSION"],
    ["CreateMicrogridBody", CreateMicrogridBody, CREATE_MICROGRID_BODY_VERSION, "CREATE_MICROGRID_BODY_VERSION"],
    ["UpdateMicrogridBody", UpdateMicrogridBody, UPDATE_MICROGRID_BODY_VERSION, "UPDATE_MICROGRID_BODY_VERSION"],
    ["CreateTenantBody", CreateTenantBody, CREATE_TENANT_BODY_VERSION, "CREATE_TENANT_BODY_VERSION"],
    ["UpdateTenantBody", UpdateTenantBody, UPDATE_TENANT_BODY_VERSION, "UPDATE_TENANT_BODY_VERSION"],
    ["TenantAccessGrantBody", TenantAccessGrantBody, TENANT_ACCESS_GRANT_BODY_VERSION, "TENANT_ACCESS_GRANT_BODY_VERSION"],
    ["DeleteCommunityBody", DeleteCommunityBody, DELETE_COMMUNITY_BODY_VERSION, "DELETE_COMMUNITY_BODY_VERSION"],
    ["DeleteMicrogridBody", DeleteMicrogridBody, DELETE_MICROGRID_BODY_VERSION, "DELETE_MICROGRID_BODY_VERSION"],
    ["DeleteTenantBody", DeleteTenantBody, DELETE_TENANT_BODY_VERSION, "DELETE_TENANT_BODY_VERSION"],
    ["RevokeTenantAccessBody", RevokeTenantAccessBody, REVOKE_TENANT_ACCESS_BODY_VERSION, "REVOKE_TENANT_ACCESS_BODY_VERSION"],
  ] as const)("%s matches the shape pinned for its version", (name, schema, version, constant) => {
    expect(version).toBe(1);
    expect(
      JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" }))),
      `The JSON Schema changed: bump ${constant} in src/lib/community-management/schemas.ts and pin the new shape in this file.`
    ).toEqual(SHAPES[name][version]);
  });
});

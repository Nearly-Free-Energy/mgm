/**
 * Metering's body schemas (../schemas.ts): each version's JSON Schema is
 * pinned, so a change to what a route accepts is a new input version; the
 * refusals keep the text the routes gave before they parsed with these, which
 * the pages show; the credentials are write-only; and the kit can draw each
 * form a person fills, apart from the connection's.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldsOf } from "@/lib/gui/kit/action-form";
import type { Json } from "@/lib/gui/contract";
import {
  CHECK_CONNECTION_BODY_VERSION,
  CheckConnectionBody,
  DELETE_EDGE_BODY_VERSION,
  DeleteEdgeBody,
  EDIT_DEVICE_BODY_VERSION,
  EDIT_EDGE_BODY_VERSION,
  EditDeviceBody,
  EditEdgeBody,
  RECORD_OPENING_REGISTER_BODY_VERSION,
  REGISTER_EDGES_BODY_VERSION,
  RecordOpeningRegisterBody,
  RegisterEdgesBody,
  SAVE_CONNECTION_BODY_VERSION,
  SAVE_DEVICES_BODY_VERSION,
  SaveConnectionBody,
  SaveDevicesBody,
  editDeviceRefusal,
} from "../schemas";

/** The first issue as parseJsonBody answers it: its top-level key and message. */
function firstIssue(schema: z.ZodType, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return "ok";
  const issue = parsed.error.issues[0];
  return { field: typeof issue.path[0] === "string" ? issue.path[0] : undefined, message: issue.message };
}
const message = (schema: z.ZodType, input: unknown) => {
  const first = firstIssue(schema, input);
  return first === "ok" ? "ok" : first.message;
};

const json = (schema: z.ZodType) => JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" })));
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

/** What a person fills, as the host hands it to the kit: bound fields and `confirmation` removed (describeInput). */
function personInput(schema: z.ZodType, hidden: string[] = []): Json {
  const s = json(schema) as { properties: Record<string, Json>; required?: string[] };
  for (const key of [...hidden, "confirmation"]) delete s.properties[key];
  if (s.required) s.required = s.required.filter((k) => ![...hidden, "confirmation"].includes(k));
  return s as unknown as Json;
}

const CONFIRMATION = {
  type: "object",
  properties: {
    acknowledged: { maxItems: 20, type: "array", items: { type: "string", maxLength: 64 } },
    typed: { type: "string", maxLength: 200 },
  },
  required: ["acknowledged"],
  additionalProperties: false,
};
const DEVICE_TYPES = ["consumption_meter", "grid_meter", "pv_meter", "battery", "inverter", "ev_charger", "other"];
const ID_HINT = "As OpenEMS reports it: 1 to 64 characters: letters, digits, '_', '.', ':' or '-'";

describe("SaveConnectionBody", () => {
  const DIRECT = { type: "direct_url", backendUrl: "https://openems.example.com", known_edge_ids: [] };

  it(`is version ${SAVE_CONNECTION_BODY_VERSION}, with its four credentials write-only`, () => {
    expect(SAVE_CONNECTION_BODY_VERSION).toBe(1);
    const secret = (title: string) => ({ type: "string", title, writeOnly: true });
    expect(json(SaveConnectionBody)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        type: { type: "string", enum: ["cloud_aws", "direct_url"], title: "Connection type" },
        backendUrl: {
          type: "string",
          pattern: "\\S",
          title: "Backend address",
          description: "An absolute https:// address (http:// for localhost only), with no credentials in it",
        },
        known_edge_ids: {
          type: "array",
          items: { type: "string" },
          title: "Known edge ids",
          description:
            "Edge ids to check on the backend before saving. Leave empty to list the edges with the OpenEMS UI username and password.",
        },
        region: { type: "string", title: "AWS region" },
        accessKeyId: { type: "string", title: "AWS access key id" },
        secretAccessKey: secret("AWS secret access key"),
        basicAuthUsername: { type: "string", title: "OpenEMS UI username" },
        basicAuthPassword: secret("OpenEMS UI password"),
        bearerToken: secret("Bearer token"),
        keycloakTokenUrl: { type: "string", title: "Keycloak token address" },
        keycloakClientId: { type: "string", title: "Keycloak client id" },
        keycloakClientSecret: secret("Keycloak client secret"),
        confirmed_name: {
          type: "string",
          title: "Microgrid name, typed",
          deprecated: true,
          description:
            "The OpenEMS Backend page's field. Other clients send the name in confirmation.typed, which the route reads instead whenever a confirmation is sent.",
        },
        confirmation: CONFIRMATION,
      },
      required: ["type", "backendUrl", "known_edge_ids"],
      additionalProperties: false,
    });
  });

  it("marks exactly the credentials write-only, so the catalog and a form carry no value of theirs", () => {
    const properties = json(SaveConnectionBody).properties as Record<string, { writeOnly?: boolean }>;
    expect(Object.keys(properties).filter((k) => properties[k].writeOnly === true).sort()).toEqual([
      "basicAuthPassword",
      "bearerToken",
      "keycloakClientSecret",
      "secretAccessKey",
    ]);
  });

  it("accepts what the OpenEMS Backend page sends", () => {
    expect(firstIssue(SaveConnectionBody, { ...DIRECT, basicAuthUsername: "", known_edge_ids: ["edge0"] })).toBe("ok");
    expect(
      firstIssue(SaveConnectionBody, {
        type: "cloud_aws",
        backendUrl: "https://lambda.example.com/",
        region: "us-east-1",
        accessKeyId: "AKIA",
        secretAccessKey: "s",
        known_edge_ids: [],
        confirmed_name: "Site",
      }),
    ).toBe("ok");
    expect(firstIssue(SaveConnectionBody, { ...DIRECT, confirmation: { acknowledged: [], typed: "Site" } })).toBe("ok");
  });

  it("refuses with the text the route gave", () => {
    expect(message(SaveConnectionBody, { type: "bogus" })).toBe("type must be 'cloud_aws' or 'direct_url'");
    expect(message(SaveConnectionBody, { type: "direct_url", known_edge_ids: [] })).toBe("backendUrl is required");
    expect(message(SaveConnectionBody, { ...DIRECT, backendUrl: "  " })).toBe("backendUrl is required");
    expect(message(SaveConnectionBody, { ...DIRECT, known_edge_ids: "edge0,edge1" })).toBe("known_edge_ids must be an array of strings");
    expect(message(SaveConnectionBody, { ...DIRECT, known_edge_ids: undefined })).toBe("known_edge_ids must be an array of strings");
    expect(message(SaveConnectionBody, { ...DIRECT, known_edge_ids: [1] })).toBe("known_edge_ids must be an array of strings");
    expect(message(SaveConnectionBody, null)).toBe("Request body must be an object");
    expect(firstIssue(SaveConnectionBody, { ...DIRECT, password: "x" })).toEqual({ field: undefined, message: "Unknown field: password" });
  });
});

describe("CheckConnectionBody", () => {
  it(`is version ${CHECK_CONNECTION_BODY_VERSION}: an empty object, with nothing to fill`, () => {
    expect(CHECK_CONNECTION_BODY_VERSION).toBe(1);
    expect(json(CheckConnectionBody)).toEqual({ $schema: SCHEMA, type: "object", properties: {}, additionalProperties: false });
    expect(firstIssue(CheckConnectionBody, {})).toBe("ok");
    expect(message(CheckConnectionBody, { edges: [] })).toBe("Unknown field: edges");
    expect(fieldsOf(personInput(CheckConnectionBody))).toEqual([]);
  });
});

describe("RegisterEdgesBody", () => {
  it(`is version ${REGISTER_EDGES_BODY_VERSION}`, () => {
    expect(REGISTER_EDGES_BODY_VERSION).toBe(1);
    expect(json(RegisterEdgesBody)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        edges: {
          minItems: 1,
          type: "array",
          items: {
            type: "object",
            properties: {
              openems_edge_id: { type: "string", pattern: "\\S", title: "OpenEMS edge id", description: ID_HINT },
              name: { type: "string", pattern: "\\S", title: "Name" },
              role: { anyOf: [{ type: "string", title: "Role" }, { type: "null" }] },
            },
            required: ["openems_edge_id", "name"],
            additionalProperties: false,
          },
          title: "Edges",
        },
      },
      required: ["edges"],
      additionalProperties: false,
    });
  });

  it("accepts what the Add Edge dialog sends, and refuses with the route's text", () => {
    expect(firstIssue(RegisterEdgesBody, { edges: [{ openems_edge_id: "edge0", name: "Edge 0" }] })).toBe("ok");
    expect(firstIssue(RegisterEdgesBody, { edges: [{ openems_edge_id: "edge0", name: "Edge 0", role: null }] })).toBe("ok");
    const EDGES = "Request body must include a non-empty `edges` array";
    for (const body of [null, {}, { edges: [] }, { edges: "x" }]) expect(message(RegisterEdgesBody, body)).toBe(EDGES);
    const ENTRY = "Each edge must include non-empty openems_edge_id and name strings";
    for (const entry of [{ name: "Edge 0" }, { openems_edge_id: " ", name: "Edge 0" }, { openems_edge_id: "edge0", name: "" }, null]) {
      expect(message(RegisterEdgesBody, { edges: [entry] })).toBe(ENTRY);
    }
    // The id's format is the route's rule, with its own reason.
    expect(firstIssue(RegisterEdgesBody, { edges: [{ openems_edge_id: "edge 0", name: "Edge 0" }] })).toBe("ok");
  });

  it("is drawn by the kit as rows", () => {
    expect(fieldsOf(personInput(RegisterEdgesBody))?.map((f) => f.kind)).toEqual(["rows"]);
  });
});

describe("EditEdgeBody", () => {
  it(`is version ${EDIT_EDGE_BODY_VERSION}`, () => {
    expect(EDIT_EDGE_BODY_VERSION).toBe(1);
    expect(json(EditEdgeBody)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        role: { anyOf: [{ type: "string", title: "Role" }, { type: "null" }] },
      },
      additionalProperties: false,
    });
  });

  it("accepts what the edge form sends, and leaves a blank name and an empty body to the route", () => {
    for (const body of [{ name: "Edge 0", role: null }, { name: "Edge 0", role: "main" }, { name: "   " }, {}]) {
      expect(firstIssue(EditEdgeBody, body)).toBe("ok");
    }
  });

  it("refuses the retired and immutable fields with the route's copy", () => {
    expect(message(EditEdgeBody, { openems_edge_id: "edge1" })).toBe(
      "openems_edge_id is no longer editable via PATCH. Remove and rediscover the edge to link a different OpenEMS edge.",
    );
    expect(message(EditEdgeBody, { name: "x", openems_backend_url: "http://x", data_source_type: "modbus_direct" })).toBe(
      "Legacy fields are no longer accepted: data_source_type, openems_backend_url. OpenEMS is the only supported type and backend URL lives on the microgrid (see PUT /api/microgrids/[id]/openems-backend).",
    );
    expect(message(EditEdgeBody, { name: "x", foo: 1 })).toBe("Unknown field: foo");
    expect(message(EditEdgeBody, null)).toBe("Request body must be an object");
  });

  it("is drawn by the kit", () => {
    expect(fieldsOf(personInput(EditEdgeBody))?.map((f) => [f.key, f.kind])).toEqual([
      ["name", "text"],
      ["role", "text"],
    ]);
  });
});

describe("DeleteEdgeBody", () => {
  it(`is version ${DELETE_EDGE_BODY_VERSION}: the host's confirmation, or nothing`, () => {
    expect(DELETE_EDGE_BODY_VERSION).toBe(1);
    expect(json(DeleteEdgeBody)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: { confirmation: CONFIRMATION },
      additionalProperties: false,
    });
    expect(firstIssue(DeleteEdgeBody, {})).toBe("ok");
    expect(firstIssue(DeleteEdgeBody, { confirmation: { acknowledged: [], typed: "Edge 0" } })).toBe("ok");
    expect(message(DeleteEdgeBody, { confirmation: { typed: "Edge 0" } })).toBe("confirmation must be { acknowledged: string[], typed?: string }");
    expect(fieldsOf(personInput(DeleteEdgeBody))).toEqual([]);
  });
});

describe("SaveDevicesBody", () => {
  const EDGE = "0a7e0000-0000-4000-8000-00000000000A";
  const DEVICE = { componentId: "meter0", factoryId: "Meter.Socomec", openemsChannelAddress: "meter0/ActiveProductionEnergy", deviceType: "consumption_meter", name: "Main" };

  it(`is version ${SAVE_DEVICES_BODY_VERSION}`, () => {
    expect(SAVE_DEVICES_BODY_VERSION).toBe(1);
    expect(json(SaveDevicesBody)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        edgeId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" },
        devices: {
          minItems: 1,
          type: "array",
          items: {
            type: "object",
            properties: {
              componentId: { type: "string", title: "OpenEMS component id", description: ID_HINT },
              factoryId: { anyOf: [{ type: "string", title: "OpenEMS factory id" }, { type: "null" }] },
              openemsChannelAddress: { anyOf: [{ type: "string", title: "Channel address" }, { type: "null" }] },
              deviceType: { type: "string", enum: DEVICE_TYPES, title: "Device type" },
              name: { type: "string", title: "Name", description: "Blank: the component id" },
            },
            required: ["componentId", "deviceType", "name"],
            additionalProperties: false,
          },
          title: "Devices",
        },
      },
      required: ["edgeId", "devices"],
      additionalProperties: false,
    });
  });

  it("accepts what Discover devices and the inline meter picker send", () => {
    expect(firstIssue(SaveDevicesBody, { edgeId: EDGE, devices: [DEVICE, { ...DEVICE, openemsChannelAddress: null }] })).toBe("ok");
    expect(firstIssue(SaveDevicesBody, { edgeId: EDGE, devices: [{ componentId: "meter1", factoryId: "F", deviceType: "consumption_meter", name: "M" }] })).toBe("ok");
    // The component id's format is the route's rule, with its own reason.
    expect(firstIssue(SaveDevicesBody, { edgeId: EDGE, devices: [{ ...DEVICE, componentId: "meter 0" }] })).toBe("ok");
  });

  it("refuses with the text the route gave", () => {
    expect(message(SaveDevicesBody, { devices: [DEVICE] })).toBe("Request body must include edgeId and devices");
    expect(message(SaveDevicesBody, { edgeId: EDGE })).toBe("Request body must include edgeId and devices");
    expect(message(SaveDevicesBody, null)).toBe("Request body must include edgeId and devices");
    expect(message(SaveDevicesBody, { edgeId: "edge0", devices: [DEVICE] })).toBe("Invalid edgeId — expected UUID.");
    expect(message(SaveDevicesBody, { edgeId: " ", devices: [DEVICE] })).toBe("edgeId must be a non-empty string");
    expect(message(SaveDevicesBody, { edgeId: 7, devices: [DEVICE] })).toBe("edgeId must be a non-empty string");
    expect(message(SaveDevicesBody, { edgeId: EDGE, devices: "not-an-array" })).toBe("devices must be a non-empty array");
    expect(message(SaveDevicesBody, { edgeId: EDGE, devices: [] })).toBe("devices must be a non-empty array");
    const ROW = "Each device must have componentId (string), deviceType (string), and name (string)";
    for (const row of [null, { ...DEVICE, componentId: 1 }, { ...DEVICE, name: undefined }, { ...DEVICE, deviceType: undefined }]) {
      expect(message(SaveDevicesBody, { edgeId: EDGE, devices: [row] })).toBe(ROW);
    }
    expect(message(SaveDevicesBody, { edgeId: EDGE, devices: [{ ...DEVICE, deviceType: "meter" }] })).toBe(
      `deviceType must be one of ${DEVICE_TYPES.join(", ")}.`,
    );
  });

  it("is drawn by the kit as rows once the host binds the edge", () => {
    expect(fieldsOf(personInput(SaveDevicesBody, ["edgeId"]))?.map((f) => f.kind)).toEqual(["rows"]);
  });
});

describe("EditDeviceBody", () => {
  it(`is version ${EDIT_DEVICE_BODY_VERSION}`, () => {
    expect(EDIT_DEVICE_BODY_VERSION).toBe(1);
    expect(json(EditDeviceBody)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        device_type: { type: "string", enum: DEVICE_TYPES, title: "Device type" },
        name: { type: "string", pattern: "\\S", title: "Name" },
      },
      additionalProperties: false,
    });
  });

  it("refuses with the route's text and reason", () => {
    const refused = (body: unknown) => {
      const parsed = EditDeviceBody.safeParse(body);
      if (parsed.success) return "ok";
      const issue = parsed.error.issues[0];
      return { message: issue.message, ...editDeviceRefusal(issue) };
    };
    expect(refused({})).toBe("ok");
    expect(refused({ device_type: "battery", name: "Battery" })).toBe("ok");
    expect(refused({ openems_component_id: "meter1" })).toEqual({ message: "Unsupported field: openems_component_id", reason: "unsupported_field" });
    expect(refused({ edge_id: "x" })).toEqual({ message: "Unsupported field: edge_id", reason: "unsupported_field" });
    expect(refused({ device_type: "toaster" })).toEqual({
      message: `device_type must be one of ${DEVICE_TYPES.join(", ")}.`,
      reason: "invalid_device_type",
    });
    expect(refused({ device_type: null })).toMatchObject({ reason: "invalid_device_type" });
    for (const name of ["   ", "", null, 3]) expect(refused({ name })).toEqual({ message: "name must be a non-empty string", reason: "name_required" });
    expect(refused([])).toEqual({ message: "Request body must be an object" });
  });

  it("is drawn by the kit", () => {
    expect(fieldsOf(personInput(EditDeviceBody))?.map((f) => [f.key, f.kind])).toEqual([
      ["device_type", "choice"],
      ["name", "text"],
    ]);
  });
});

describe("RecordOpeningRegisterBody", () => {
  it(`is version ${RECORD_OPENING_REGISTER_BODY_VERSION}`, () => {
    expect(RECORD_OPENING_REGISTER_BODY_VERSION).toBe(1);
    expect(json(RecordOpeningRegisterBody)).toEqual({
      $schema: SCHEMA,
      type: "object",
      properties: {
        device_id: { type: "string" },
        reading_kwh: { type: "number", title: "Opening register (kWh)", description: "The meter's register at the time read, 0 or more" },
        read_at: {
          type: "string",
          title: "Read at",
          description: "When the register was read: an ISO 8601 time with its offset, not in the future",
        },
      },
      required: ["device_id", "reading_kwh", "read_at"],
      additionalProperties: false,
    });
  });

  it("accepts what the opening register dialog sends, and leaves the value rules to the capability", () => {
    const BODY = { device_id: "x", reading_kwh: 1234.5, read_at: "2026-09-01T00:00:00Z" };
    expect(firstIssue(RecordOpeningRegisterBody, BODY)).toBe("ok");
    // Below zero, or not a time: the capability's 422s.
    expect(firstIssue(RecordOpeningRegisterBody, { ...BODY, reading_kwh: -1, read_at: "yesterday" })).toBe("ok");
    expect(firstIssue(RecordOpeningRegisterBody, { ...BODY, reading_kwh: "12" })).toEqual({ field: "reading_kwh", message: "reading_kwh must be a number" });
  });

  it("is drawn by the kit once the host binds the meter", () => {
    expect(fieldsOf(personInput(RecordOpeningRegisterBody, ["device_id"]))?.map((f) => [f.key, f.kind])).toEqual([
      ["reading_kwh", "number"],
      ["read_at", "text"],
    ]);
  });
});

/**
 * Body schemas for metering's write actions. The routes parse with these
 * (parseJsonBody), and METERING_SURFACE's actions (./surface.ts) take their
 * input from them, so the catalog's schema and the route's parse are one
 * definition: gui-surface.test.ts check 2 holds the two together. A change
 * to a schema's JSON Schema is a new input version: bump its constant
 * (__tests__/schemas.test.ts pins each version's shape).
 *
 * Shape only, as payments' are: what a field holds and which fields there
 * are. A body of the wrong shape (a field of the wrong JSON type, a required
 * one missing, one the route does not take) is answered 400 `invalid_body`.
 * Each rule on a value stays where it was, and so does its answer: an
 * OpenEMS id outside the stored format (400 with its own `reason` and the id
 * named), a blank edge name (422), a backend address MGM does not contact
 * (400), an opening register below zero or in the future (422, from the
 * capability), and every rule that reads more than one field or the
 * database. Where a page or a test reads a refusal's text, the schema gives
 * the text the route gave.
 *
 * Client-safe: its runtime imports are zod, @/lib/openems/ids (zod only) and
 * @/lib/types/domain (the enum values database.gen.ts holds). If any of them
 * gains a server-only or side-effecting import, revisit.
 */
import { z } from "zod";
import { OPENEMS_ID_FORMAT_HINT } from "@/lib/openems/ids";
import { DEVICE_TYPE_VALUES, MICROGRID_EMS_TYPE_VALUES } from "@/lib/types/domain";

type ObjectIssue = { code: string; keys?: string[] };
const unknownField = (issue: ObjectIssue) => `Unknown field: ${(issue.keys ?? []).join(", ")}`;
const bodyError = (issue: ObjectIssue) =>
  issue.code === "unrecognized_keys" ? unknownField(issue) : "Request body must be an object";

/** A UUID as the metering routes' UUID_RE reads one, which is any letter case. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const CONFIRMATION = "confirmation must be { acknowledged: string[], typed?: string }";
/**
 * The host's Confirmation (src/lib/gui/contract.ts) for a step with no
 * digest: the acknowledgements ticked and the name typed. Optional, because
 * the legacy pages that call these routes confirm in the browser and send
 * none; each route checks the typed name when one is sent.
 */
const typedConfirmation = z
  .strictObject(
    {
      acknowledged: z
        .array(z.string({ error: CONFIRMATION }).max(64, { error: CONFIRMATION }), { error: CONFIRMATION })
        .max(20, { error: CONFIRMATION }),
      typed: z.string({ error: CONFIRMATION }).max(200, { error: CONFIRMATION }).optional(),
    },
    { error: CONFIRMATION }
  )
  .optional();

const text = (field: string) => z.string({ error: `${field} must be a string` });
// A nullable field takes its meta before .nullable(), so zod writes it as
// anyOf [the field, null], the form of "this or null" the kit's form draws
// (src/lib/gui/kit/action-form.tsx), rather than a type array it does not.
/** A credential: write-only, so no form prefills or shows it and the catalog carries only that it is one. */
const credential = (field: string, title: string) =>
  text(field).meta({ title, writeOnly: true }).optional();

// ── The connection ────────────────────────────────────────────────────────

const EDGE_IDS = "known_edge_ids must be an array of strings";

/**
 * PUT /api/microgrids/[id]/openems-backend: test, save and discover the
 * microgrid's OpenEMS connection. The microgrid comes from the path.
 *
 * Its four credentials are write-only. A credential left out keeps the one
 * stored, while the backend address (and, for the Keycloak secret, its token
 * address) stays the same; the route decides that, and which fields each
 * connection type takes and needs.
 *
 * The microgrid's name, typed, confirms a save on a microgrid with closed
 * billing periods: in `confirmation.typed`, as the host's ceremony sends it,
 * or in `confirmed_name`, as the OpenEMS Backend page does.
 */
export const SaveConnectionBody = z.strictObject(
  {
    type: z
      .enum(MICROGRID_EMS_TYPE_VALUES, { error: "type must be 'cloud_aws' or 'direct_url'" })
      .meta({ title: "Connection type" }),
    backendUrl: z
      .string({ error: "backendUrl is required" })
      .regex(/\S/, { error: "backendUrl is required" })
      .meta({
        title: "Backend address",
        description: "An absolute https:// address (http:// for localhost only), with no credentials in it",
      }),
    known_edge_ids: z.array(z.string({ error: EDGE_IDS }), { error: EDGE_IDS }).meta({
      title: "Known edge ids",
      description:
        "Edge ids to check on the backend before saving. Leave empty to list the edges with the OpenEMS UI username and password.",
    }),
    region: text("region").meta({ title: "AWS region" }).optional(),
    accessKeyId: text("accessKeyId").meta({ title: "AWS access key id" }).optional(),
    secretAccessKey: credential("secretAccessKey", "AWS secret access key"),
    basicAuthUsername: text("basicAuthUsername").meta({ title: "OpenEMS UI username" }).optional(),
    basicAuthPassword: credential("basicAuthPassword", "OpenEMS UI password"),
    bearerToken: credential("bearerToken", "Bearer token"),
    keycloakTokenUrl: text("keycloakTokenUrl").meta({ title: "Keycloak token address" }).optional(),
    keycloakClientId: text("keycloakClientId").meta({ title: "Keycloak client id" }).optional(),
    keycloakClientSecret: credential("keycloakClientSecret", "Keycloak client secret"),
    confirmed_name: text("confirmed_name")
      .meta({
        title: "Microgrid name, typed",
        description: "Confirms a save on a microgrid with closed billing periods, as confirmation.typed does",
      })
      .optional(),
    confirmation: typedConfirmation,
  },
  { error: bodyError }
);
export const SAVE_CONNECTION_BODY_VERSION = 1;

/**
 * POST /api/microgrids/[id]/openems-backend/discover: check the saved
 * connection and list the edges the backend reports. The microgrid comes
 * from the path; the body is empty, and the pages send none.
 */
export const CheckConnectionBody = z.strictObject({}, { error: bodyError });
export const CHECK_CONNECTION_BODY_VERSION = 1;

// ── Edges ─────────────────────────────────────────────────────────────────

const EDGES = "Request body must include a non-empty `edges` array";
const EDGE_ENTRY = "Each edge must include non-empty openems_edge_id and name strings";

const RegisterEdgeEntry = z.strictObject(
  {
    openems_edge_id: z
      .string({ error: EDGE_ENTRY })
      .regex(/\S/, { error: EDGE_ENTRY })
      .meta({ title: "OpenEMS edge id", description: `As OpenEMS reports it: ${OPENEMS_ID_FORMAT_HINT}` }),
    name: z.string({ error: EDGE_ENTRY }).regex(/\S/, { error: EDGE_ENTRY }).meta({ title: "Name" }),
    role: text("role").meta({ title: "Role" }).nullable().optional(),
  },
  { error: (issue) => (issue.code === "unrecognized_keys" ? unknownField(issue) : EDGE_ENTRY) }
);

/**
 * POST /api/microgrids/[id]/edges/register: link edges the backend reports
 * to the microgrid, or rename those already linked. The microgrid comes from
 * the path. The id's format is the route's rule (`invalid_edge_id`, the id
 * named), so the schema describes it rather than refusing it.
 */
export const RegisterEdgesBody = z.strictObject(
  {
    edges: z
      .array(RegisterEdgeEntry, { error: EDGES })
      .min(1, { error: EDGES })
      .meta({ title: "Edges" }),
  },
  { error: (issue) => (issue.code === "unrecognized_keys" ? unknownField(issue) : EDGES) }
);
export const REGISTER_EDGES_BODY_VERSION = 1;

const LEGACY_EDGE_FIELDS = ["data_source_type", "openems_backend_url"] as const;

/**
 * PATCH /api/edges/[id]: rename an edge or change its role. The edge comes
 * from the path; at least one field is the route's rule, and so is a blank
 * name (422). The OpenEMS edge id is not editable, and the fields retired
 * by #101 are refused with the copy the route always gave.
 */
export const EditEdgeBody = z.strictObject(
  {
    name: z.string({ error: "name must be a non-empty string" }).meta({ title: "Name" }).optional(),
    role: z.string({ error: "role must be a string or null" }).meta({ title: "Role" }).nullable().optional(),
  },
  {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return "Request body must be an object";
      const keys = issue.keys ?? [];
      if (keys.includes("openems_edge_id")) {
        return "openems_edge_id is no longer editable via PATCH. Remove and rediscover the edge to link a different OpenEMS edge.";
      }
      const legacy = LEGACY_EDGE_FIELDS.filter((k) => keys.includes(k));
      if (legacy.length > 0) {
        return `Legacy fields are no longer accepted: ${legacy.join(", ")}. OpenEMS is the only supported type and backend URL lives on the microgrid (see PUT /api/microgrids/[id]/openems-backend).`;
      }
      return unknownField(issue);
    },
  }
);
export const EDIT_EDGE_BODY_VERSION = 1;

/**
 * DELETE /api/edges/[id]. The edge comes from the path. `confirmation` is
 * the host's for a typed action: the edge's name, typed. The route requires
 * it of every request that sends a body; the Edges page confirms in the
 * browser and sends none, which the route reads as {} and lets through.
 */
export const DeleteEdgeBody = z.strictObject({ confirmation: typedConfirmation }, { error: bodyError });
export const DELETE_EDGE_BODY_VERSION = 1;

// ── Devices ───────────────────────────────────────────────────────────────

const DEVICES_PRESENCE = "Request body must include edgeId and devices";
const DEVICES = "devices must be a non-empty array";
const DEVICE_ROW = "Each device must have componentId (string), deviceType (string), and name (string)";
const DEVICE_TYPES = `must be one of ${DEVICE_TYPE_VALUES.join(", ")}.`;
const blank = (input: unknown) => typeof input === "string" && input.trim() === "";

const DeviceRow = z.strictObject(
  {
    componentId: z
      .string({ error: DEVICE_ROW })
      .meta({ title: "OpenEMS component id", description: `As OpenEMS reports it: ${OPENEMS_ID_FORMAT_HINT}` }),
    factoryId: text("factoryId").meta({ title: "OpenEMS factory id" }).nullable().optional(),
    openemsChannelAddress: text("openemsChannelAddress").meta({ title: "Channel address" }).nullable().optional(),
    deviceType: z
      .enum(DEVICE_TYPE_VALUES, { error: (issue) => (typeof issue.input === "string" ? `deviceType ${DEVICE_TYPES}` : DEVICE_ROW) })
      .meta({ title: "Device type" }),
    name: z.string({ error: DEVICE_ROW }).meta({ title: "Name", description: "Blank: the component id" }),
  },
  { error: (issue) => (issue.code === "unrecognized_keys" ? unknownField(issue) : DEVICE_ROW) }
);

/**
 * POST /api/devices: save devices discovered on an edge, or reclassify and
 * rename those already saved. `edgeId` is the edge's own id (bound by the
 * host), not OpenEMS's. The component id's format is the route's rule
 * (`invalid_component_id`).
 */
export const SaveDevicesBody = z.strictObject(
  {
    edgeId: z
      .string({ error: (issue) => (issue.input === undefined ? DEVICES_PRESENCE : "edgeId must be a non-empty string") })
      .regex(UUID_PATTERN, {
        error: (issue) => (blank(issue.input) ? "edgeId must be a non-empty string" : "Invalid edgeId — expected UUID."),
      }),
    devices: z
      .array(DeviceRow, { error: (issue) => (issue.input === undefined ? DEVICES_PRESENCE : DEVICES) })
      .min(1, { error: DEVICES })
      .meta({ title: "Devices" }),
  },
  { error: (issue) => (issue.code === "unrecognized_keys" ? unknownField(issue) : DEVICES_PRESENCE) }
);
export const SAVE_DEVICES_BODY_VERSION = 1;

const DEVICE_TYPE = `device_type ${DEVICE_TYPES}`;
const NAME_REQUIRED = "name must be a non-empty string";

/**
 * PATCH /api/devices/[id]: reclassify or rename a saved device. The device
 * comes from the path; at least one field is the route's rule. Identity
 * fields (the component id, the edge) are not editable. Each refusal keeps
 * the `reason` the route always sent (EDIT_DEVICE_REFUSAL).
 */
export const EditDeviceBody = z.strictObject(
  {
    device_type: z.enum(DEVICE_TYPE_VALUES, { error: DEVICE_TYPE }).meta({ title: "Device type" }).optional(),
    name: z.string({ error: NAME_REQUIRED }).regex(/\S/, { error: NAME_REQUIRED }).meta({ title: "Name" }).optional(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? `Unsupported field: ${issue.keys?.[0] ?? ""}` : "Request body must be an object",
  }
);
export const EDIT_DEVICE_BODY_VERSION = 1;

/** The `reason` PATCH /api/devices/[id] sends with each refusal of its body, for parseJsonBody's `refusal`. */
export function editDeviceRefusal(issue: z.core.$ZodIssue): Record<string, string> | undefined {
  if (issue.code === "unrecognized_keys") return { reason: "unsupported_field" };
  if (issue.path[0] === "device_type") return { reason: "invalid_device_type" };
  if (issue.path[0] === "name") return { reason: "name_required" };
  return undefined;
}

// ── Readings ──────────────────────────────────────────────────────────────

/**
 * POST /api/meter-readings/opening: a meter's register at the start of its
 * first billable period. `device_id` is the meter (bound by the host). That
 * the register is 0 or more and the time a real one not in the future are
 * the capability's rules (422).
 */
export const RecordOpeningRegisterBody = z.strictObject(
  {
    device_id: text("device_id"),
    reading_kwh: z
      .number({ error: "reading_kwh must be a number" })
      .meta({ title: "Opening register (kWh)", description: "The meter's register at the time read, 0 or more" }),
    read_at: text("read_at").meta({
      title: "Read at",
      description: "When the register was read: an ISO 8601 time with its offset, not in the future",
    }),
  },
  { error: bodyError }
);
export const RECORD_OPENING_REGISTER_BODY_VERSION = 1;

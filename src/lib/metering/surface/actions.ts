import "server-only";

/**
 * The prepare steps of metering's actions that confirm with more than a
 * button: saving the OpenEMS connection (`metering.save-connection`, a
 * ceremony) and deleting an edge (`metering.delete-edge`, typed).
 *
 * Each reads through the person's own client (row-level security) and
 * composes no capability, as the routes read; neither reads a stored
 * credential or the vendor system. The routes are the authority on every
 * write and check again: prepare only shows what the write will do and
 * refuses what the route would refuse anyway. A refusal carries fixed copy,
 * never a database message.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Loaded, SurfaceRequest } from "@/lib/gui/surface";
import { countEntityDescendants } from "@/lib/entity-descendants";
import { CONNECTION_DRAFT_PERIOD_REFUSAL, EDGE_UNNAMED_REFUSAL, connectionClosedPeriodsWarning } from "../copy";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const SAVE_CONNECTION_ACTION = { id: "metering.save-connection", title: "Save the OpenEMS connection" } as const;
export const CHECK_CONNECTION_ACTION = { id: "metering.check-connection", title: "Check the OpenEMS connection" } as const;
export const REGISTER_EDGES_ACTION = { id: "metering.register-edges", title: "Register edges" } as const;
export const EDIT_EDGE_ACTION = { id: "metering.edit-edge", title: "Edit edge" } as const;
export const DELETE_EDGE_ACTION = { id: "metering.delete-edge", title: "Delete edge" } as const;
export const SAVE_DEVICES_ACTION = { id: "metering.save-devices", title: "Save newly discovered devices" } as const;
export const EDIT_DEVICE_ACTION = { id: "metering.edit-device", title: "Edit device" } as const;
export const RECORD_OPENING_REGISTER_ACTION = {
  id: "metering.record-opening-register",
  title: "Record the opening register",
} as const;

export const SAVE_CONNECTION_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This microgrid could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not check this microgrid's billing periods right now. Try again shortly." },
  // The route's hard 409 (PUT /api/microgrids/[id]/openems-backend, branch (a)), from ../copy.
  draft: { ok: false, status: 409, message: CONNECTION_DRAFT_PERIOD_REFUSAL },
} as const satisfies Record<string, Refusal>;

/** What the save does, in the ceremony's statement. */
export const SAVE_CONNECTION_STATEMENT =
  "Saving tests the connection with the details entered, saves them and lists the edges the backend reports. A credential left blank keeps the one saved, only while the backend address stays the same.";

/**
 * metering.save-connection's ceremony. The route refuses any save while the
 * microgrid has a draft billing period, so this does too; with closed
 * periods it asks for the microgrid's name, typed, which the host sends as
 * `confirmation.typed` and the route checks as it checks the page's
 * `confirmed_name`, with the route's warning. Prepare runs before the form
 * (ADR-006 decision 10), so it shows the address saved now, not the one
 * entered. If the route's period rule changes, change this with it.
 */
export async function prepareSaveConnection(
  req: SurfaceRequest,
  input: { params: Record<string, string>; body?: unknown },
): Promise<Loaded<Ceremony>> {
  const microgridId = input.params.id;
  const { data: microgrid, error } = await req.supabase
    .from("microgrids")
    .select("id, name, ems_backend_url")
    .eq("id", microgridId)
    .maybeSingle<{ id: string; name: string; ems_backend_url: string | null }>();
  if (error) return SAVE_CONNECTION_REFUSALS.unavailable;
  if (!microgrid) return SAVE_CONNECTION_REFUSALS.notFound;

  const { data: periods, error: periodsError } = await req.supabase
    .from("billing_periods")
    .select("status")
    .eq("microgrid_id", microgridId)
    .in("status", ["draft", "closed"]);
  if (periodsError) return SAVE_CONNECTION_REFUSALS.unavailable;
  const statuses = ((periods ?? []) as { status: string }[]).map((p) => p.status);
  if (statuses.includes("draft")) return SAVE_CONNECTION_REFUSALS.draft;
  const closed = statuses.filter((s) => s === "closed").length;

  const name = microgrid.name.trim();
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: SAVE_CONNECTION_STATEMENT,
      facts: [
        { label: "Microgrid", value: req.fmt.text(name) },
        { label: "Backend saved now", value: req.fmt.text(microgrid.ems_backend_url ?? "None") },
      ],
      // The route's 409 for branch (b), from ../copy.
      warnings: closed > 0 ? [connectionClosedPeriodsWarning(closed)] : [],
      acknowledgements: [],
      ...(closed > 0 ? { typed: name } : {}),
    },
  };
}

export const DELETE_EDGE_REFUSALS = {
  notFound: { ok: false, status: 404, message: "Edge not found." },
  unavailable: { ok: false, status: 503, message: "Could not load this edge right now. Try again shortly." },
  // The route's 409 for an edge with no name to type, from ../copy.
  unnamed: { ok: false, status: 409, message: EDGE_UNNAMED_REFUSAL },
} as const satisfies Record<string, Refusal>;

/**
 * metering.delete-edge's confirmation: the edge's name to type, and what goes
 * with it, counted as the Edges page's delete dialog counts it
 * (countEntityDescendants, through the person's own client).
 */
export async function prepareDeleteEdge(
  req: SurfaceRequest,
  input: { params: Record<string, string>; body?: unknown },
): Promise<Loaded<Ceremony>> {
  const { data: edge, error } = await req.supabase
    .from("edges")
    .select("id, name")
    .eq("id", input.params.id)
    .maybeSingle<{ id: string; name: string | null }>();
  if (error) return DELETE_EDGE_REFUSALS.unavailable;
  if (!edge) return DELETE_EDGE_REFUSALS.notFound;
  const name = edge.name?.trim();
  if (!name) return DELETE_EDGE_REFUSALS.unnamed;

  const counts = await countEntityDescendants(req.supabase, "edge", edge.id);
  if (counts.kind !== "edge") return DELETE_EDGE_REFUSALS.unavailable;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: "Deleting an edge deletes its devices, their meter readings and their tenant assignments. Bills keep their figures.",
      facts: [
        { label: "Edge", value: req.fmt.text(name) },
        { label: "Devices", value: req.fmt.number(counts.devices) },
        { label: "Tenant assignments", value: req.fmt.number(counts.tenant_devices) },
        { label: "Bills that lose their meter link", value: req.fmt.number(counts.billing_line_items_nulled) },
      ],
      warnings:
        counts.readings_in_closed_periods > 0
          ? [`${counts.readings_in_closed_periods} meter readings taken during closed billing periods are deleted with it.`]
          : [],
      acknowledgements: [],
      typed: name,
    },
  };
}

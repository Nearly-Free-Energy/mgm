import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { meteringFixturesEnabled } from "@/lib/config/metering-fixtures";
import { OPENEMS_ID_FORMAT_HINT, parseOpenEmsId } from "@/lib/openems/ids";
import {
  SYNTHETIC_EDGE_ID_PREFIX,
  isSyntheticEdgeId,
} from "@/lib/metering/fixture-provider";
import { RegisterEdgesBody } from "@/lib/metering/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/microgrids/[id]/edges/register — bulk-register discovered edges.
 *
 * Replaces the retired POST /api/edges manual-create path. Idempotent on
 * (microgrid_id, openems_edge_id) — ON CONFLICT DO UPDATE refreshes name/role.
 *
 * The body is `RegisterEdgesBody` (`@/lib/metering/schemas`), the
 * `metering.register-edges` action's input: a body of another shape answers
 * 400 `invalid_body`, with the text below for a missing `edges` array or an
 * entry without its id or name.
 *
 * Permission: RLS-enforced (the edges INSERT policy runs
 * user_can_access_microgrid(microgrid_id)).
 *
 * Each openems_edge_id is trimmed and must fit OPENEMS_ID_PATTERN
 * (`@/lib/openems/ids`), else 400 `invalid_edge_id` with
 * `field: "openems_edge_id"` and the refused id (trimmed, cut to 100
 * characters) in `openems_edge_id` and `error`.
 *
 * Ids starting with SYNTHETIC-EDGE- are refused (400) unless
 * MGM_METERING_FIXTURES is on. That refusal comes after the route checks the
 * session with Supabase Auth (401 otherwise), so only a caller with a live
 * session can see it.
 *
 * Returns { inserted, updated, edges } where `inserted + updated` equals
 * the input edge count on success.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: microgridId } = await params;

  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID" },
      { status: 400 }
    );
  }

  // Every entry is checked before any DB write: its shape by the schema
  // (a non-empty `edges` array of entries with a non-blank id and name),
  // then its id's format, bailing on the first malformed row.
  const parsed = await parseJsonBody(request, RegisterEdgesBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  for (const entry of body.edges) {
    if (parseOpenEmsId(entry.openems_edge_id) === null) {
      // Named, so an operator registering a batch of discovered edges can
      // tell which one to leave out. Cut to 100 characters, as discovery cuts
      // a skipped component id.
      const shown = entry.openems_edge_id.trim().slice(0, 100);
      return NextResponse.json(
        {
          error: `Edge id '${shown}' cannot be registered: ids are ${OPENEMS_ID_FORMAT_HINT}.`,
          field: "openems_edge_id",
          reason: "invalid_edge_id",
          openems_edge_id: shown,
        },
        { status: 400 }
      );
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Reserved synthetic ids are registered only where they are read:
  // FixtureMeteringPlugin registers the synthetic provider only while
  // MGM_METERING_FIXTURES is on. If it registers by another rule, revisit.
  // This route is the only place the prefix is refused. MGM_METERING_FIXTURES
  // is an environment variable the database never sees, so a direct insert or
  // update under RLS still accepts the prefix (docs/setup.md § "Synthetic site
  // data"). The database's format CHECK on edges.openems_edge_id
  // (20261124160100) accepts the prefix like any other id. If a migration adds
  // a rule on the prefix itself, or another route starts writing the column,
  // revisit.
  if (!meteringFixturesEnabled() && body.edges.some((e) => isSyntheticEdgeId(e.openems_edge_id.trim()))) {
    return NextResponse.json(
      {
        error: `Edge ids starting with ${SYNTHETIC_EDGE_ID_PREFIX} are reserved for synthetic data, which this installation does not generate.`,
        field: "openems_edge_id",
      },
      { status: 400 }
    );
  }

  // MGM runtime gate: metering writes fail closed while the plugin is disabled.
  const pluginGate = await gateRoute(supabase, {
    plugin: "metering",
    target: { kind: "microgrid", id: microgridId },
    method: "POST",
  });
  if (pluginGate) return pluginGate;

  // Snapshot existing edges to compute inserted-vs-updated counts.
  const { data: existingRows, error: existingErr } = await supabase
    .from("edges")
    .select("id, openems_edge_id")
    .eq("microgrid_id", microgridId)
    .in(
      "openems_edge_id",
      body.edges.map((e) => e.openems_edge_id.trim())
    );

  if (existingErr) {
    return NextResponse.json(
      { error: `Failed to read existing edges: ${existingErr.message}` },
      { status: 500 }
    );
  }

  const existingIds = new Set(
    (existingRows ?? []).map((r) => r.openems_edge_id)
  );

  // Upsert: on conflict (microgrid_id, openems_edge_id) update name + role.
  // The UNIQUE constraint lives on 00001_schema.sql → (microgrid_id, openems_edge_id).
  const rows = body.edges.map((e) => ({
    microgrid_id: microgridId,
    openems_edge_id: e.openems_edge_id.trim(),
    name: e.name.trim(),
    role: e.role?.trim() || null,
  }));

  const { data: upserted, error: upsertErr } = await supabase
    .from("edges")
    .upsert(rows, { onConflict: "microgrid_id,openems_edge_id" })
    .select("id, microgrid_id, openems_edge_id, name, role");

  if (upsertErr) {
    if (
      upsertErr.code === "42501" ||
      upsertErr.message.includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "You do not have permission to register edges on this microgrid." },
        { status: 403 }
      );
    }
    if (upsertErr.code === "23505") {
      // Unique (microgrid_id, name) — two discovered edges would collapse
      // to the same display name.
      return NextResponse.json(
        {
          error: `Two edges have the same name. Ensure each edge has a unique display name within the microgrid.`,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `Failed to register edges: ${upsertErr.message}` },
      { status: 500 }
    );
  }

  const insertedCount = (upserted ?? []).filter(
    (r) => !existingIds.has(r.openems_edge_id)
  ).length;
  const updatedCount = (upserted ?? []).length - insertedCount;

  revalidatePath(`/microgrids/${microgridId}/setup/edges`, "page");

  return NextResponse.json(
    {
      inserted: insertedCount,
      updated: updatedCount,
      edges: upserted ?? [],
    },
    { status: 200 }
  );
}

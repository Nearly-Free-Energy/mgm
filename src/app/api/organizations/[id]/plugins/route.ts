import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  listOrganizationPlugins,
  PluginServiceError,
  setOrganizationPluginEnabled,
  listOrganizationPluginAudit,
} from "@/lib/plugins/state";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(error: unknown): NextResponse {
  if (error instanceof PluginServiceError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.field !== undefined ? { field: error.field } : {}),
      },
      { status: error.status }
    );
  }
  return NextResponse.json(
    { error: "Could not load plugin settings.", code: "plugin_unavailable" },
    { status: 500 }
  );
}

/**
 * GET /api/organizations/[id]/plugins — trusted bundled plugin states.
 *
 * Returns definitions merged with organization state, dependency readiness,
 * and recent audit history. Missing state rows default to enabled so
 * existing deployments need no backfill.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid organization id — expected UUID.", code: "invalid_org_id" },
      { status: 400 }
    );
  }
  const supabase = await createClient();
  try {
    const [plugins, audit] = await Promise.all([
      listOrganizationPlugins(supabase, id),
      listOrganizationPluginAudit(supabase, id, 20),
    ]);
    return NextResponse.json(
      {
        plugins: plugins.map((status) => ({
          name: status.plugin.name,
          displayName: status.plugin.displayName,
          description: status.plugin.description,
          version: status.version,
          enabled: status.enabled,
          core: status.plugin.core,
          dependencies: status.plugin.dependencies,
          disabledDependencies: status.disabledDependencies,
          ready: status.ready,
          provides: status.plugin.provides,
          routes: status.plugin.routes,
        })),
        audit: audit.map((entry) => ({
          id: entry.id,
          plugin_name: entry.plugin_name,
          action: entry.action,
          previous_enabled: entry.previous_enabled,
          new_enabled: entry.new_enabled,
          actor_user_id: entry.actor_user_id,
          created_at: entry.created_at,
        })),
      },
      { status: 200 }
    );
  } catch (error) {
    return mapError(error);
  }
}

/**
 * PATCH /api/organizations/[id]/plugins — enable or disable a bundled plugin.
 *
 * Dependency breaks are rejected before any write; disabling preserves all
 * domain rows. Every change is recorded in `mgm_plugin_audit_log` by the
 * atomic database function.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid organization id — expected UUID.", code: "invalid_org_id" },
      { status: 400 }
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "plugin_invalid_body" },
      { status: 400 }
    );
  }
  if (typeof body.plugin !== "string" || !body.plugin.trim()) {
    return NextResponse.json(
      { error: "plugin is required.", code: "unknown_plugin", field: "plugin" },
      { status: 400 }
    );
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      {
        error: "enabled must be a boolean.",
        code: "plugin_invalid",
        field: "enabled",
      },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  try {
    const status = await setOrganizationPluginEnabled(
      supabase,
      id,
      body.plugin.trim(),
      body.enabled
    );
    revalidatePath("/settings/plugins", "page");
    return NextResponse.json(
      {
        plugin: {
          name: status.plugin.name,
          displayName: status.plugin.displayName,
          version: status.version,
          enabled: status.enabled,
          ready: status.ready,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return mapError(error);
  }
}

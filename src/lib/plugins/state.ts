import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import type {
  MgmPlugin,
  MgmPluginAuditLog,
} from "@/lib/types/domain";
import {
  getBundledPlugin,
  resolvePluginStatuses,
  validatePluginToggle,
  type MgmPluginName,
  type ResolvedPluginStatus,
} from "./bundled";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PluginServiceError extends Error {
  status: number;
  code: string;
  field?: string;

  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = "PluginServiceError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export type OrganizationPluginStatus = ResolvedPluginStatus & {
  stateRow: MgmPlugin | null;
};

function mapPostgresError(error: { code?: string; message?: string }): PluginServiceError {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code === "42501" || message.includes("row-level security")) {
    return new PluginServiceError(
      403,
      "plugin_forbidden",
      "Not authorized to manage plugins for this organization."
    );
  }
  if (code === "P0001") {
    if (message.includes("Unknown plugin")) {
      return new PluginServiceError(400, "unknown_plugin", message);
    }
    if (message.includes("cannot be disabled")) {
      return new PluginServiceError(409, "plugin_core_locked", message);
    }
    return new PluginServiceError(400, "plugin_invalid", message);
  }
  return new PluginServiceError(
    500,
    "plugin_unavailable",
    message ? `Could not update plugin state: ${message}` : "Could not update plugin state."
  );
}

async function requireOrganizationAccess(
  supabase: SupabaseClient,
  orgId: string
): Promise<void> {
  if (!UUID_RE.test(orgId)) {
    throw new PluginServiceError(
      400,
      "invalid_org_id",
      "Invalid organization id — expected UUID.",
      "org_id"
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new PluginServiceError(
      401,
      "plugin_unauthenticated",
      "Authentication required."
    );
  }

  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    throw new PluginServiceError(
      403,
      "plugin_forbidden",
      "Not authorized to manage plugins for this organization."
    );
  }
}

async function readPluginRows(
  supabase: SupabaseClient,
  orgId: string
): Promise<MgmPlugin[]> {
  const { data, error } = await supabase
    .from("mgm_plugins")
    .select("*")
    .eq("org_id", orgId)
    .returns<MgmPlugin[]>();

  if (error) throw mapPostgresError(error);
  return data ?? [];
}

function mergeStatuses(
  rows: MgmPlugin[]
): OrganizationPluginStatus[] {
  const rowByName = new Map(rows.map((row) => [row.plugin_name, row]));
  const states = Object.fromEntries(
    rows.map((row) => [
      row.plugin_name,
      { enabled: row.enabled, version: row.version },
    ])
  ) as Partial<Record<MgmPluginName, { enabled: boolean; version: string }>>;

  return resolvePluginStatuses(states).map((status) => ({
    ...status,
    stateRow: rowByName.get(status.plugin.name) ?? null,
  }));
}

export async function listOrganizationPlugins(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrganizationPluginStatus[]> {
  await requireOrganizationAccess(supabase, orgId);
  return mergeStatuses(await readPluginRows(supabase, orgId));
}

export async function setOrganizationPluginEnabled(
  supabase: SupabaseClient,
  orgId: string,
  pluginName: string,
  enabled: boolean
): Promise<OrganizationPluginStatus> {
  await requireOrganizationAccess(supabase, orgId);

  const plugin = getBundledPlugin(pluginName);
  if (!plugin) {
    throw new PluginServiceError(
      400,
      "unknown_plugin",
      `Unknown plugin: ${pluginName}. Only bundled MGM plugins can be changed.`,
      "plugin"
    );
  }
  if (typeof enabled !== "boolean") {
    throw new PluginServiceError(
      400,
      "plugin_invalid",
      "enabled must be a boolean.",
      "enabled"
    );
  }

  const current = mergeStatuses(await readPluginRows(supabase, orgId));
  const validation = validatePluginToggle({
    pluginName: plugin.name,
    enabled,
    states: Object.fromEntries(
      current.map((status) => [
        status.plugin.name,
        { enabled: status.enabled, version: status.version },
      ])
    ),
  });
  if (!validation.ok) {
    const status =
      validation.code === "unknown_plugin" ? 400 : validation.code === "plugin_core_locked" ||
      validation.code === "plugin_dependency_required" ||
      validation.code === "plugin_dependency_disabled"
        ? 409
        : 400;
    throw new PluginServiceError(status, validation.code, validation.message);
  }

  const existing = current.find((status) => status.plugin.name === plugin.name);
  if (
    existing &&
    existing.enabled === enabled &&
    existing.version === plugin.version
  ) {
    return existing;
  }

  const { data, error } = await supabase.rpc("fn_mgm_set_plugin_enabled", {
    _enabled: enabled,
    _org_id: orgId,
    _plugin_name: plugin.name,
    _plugin_version: plugin.version,
  });

  if (error) throw mapPostgresError(error);
  if (!data) {
    throw new PluginServiceError(
      500,
      "plugin_unavailable",
      "Could not update plugin state."
    );
  }

  const updated = mergeStatuses(await readPluginRows(supabase, orgId));
  const next = updated.find((status) => status.plugin.name === plugin.name);
  if (!next) {
    throw new PluginServiceError(
      500,
      "plugin_unavailable",
      "Could not read updated plugin state."
    );
  }
  return next;
}

export async function listOrganizationPluginAudit(
  supabase: SupabaseClient,
  orgId: string,
  limit = 20
): Promise<MgmPluginAuditLog[]> {
  await requireOrganizationAccess(supabase, orgId);
  const { data, error } = await supabase
    .from("mgm_plugin_audit_log")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100))
    .returns<MgmPluginAuditLog[]>();

  if (error) throw mapPostgresError(error);
  return data ?? [];
}

export async function isCommunityManagementEnabled(
  supabase: SupabaseClient,
  orgId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("mgm_plugin_enabled_for_org", {
    _org_id: orgId,
    _plugin_name: "community-management",
  });
  if (error) return false;
  return data === true;
}

export async function isMeteringEnabled(
  supabase: SupabaseClient,
  orgId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("mgm_plugin_enabled_for_org", {
    _org_id: orgId,
    _plugin_name: "metering",
  });
  if (error) return false;
  return data === true;
}

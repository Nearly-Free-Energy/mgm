/**
 * The MGM plugin gate — one place that decides whether a plugin is live for
 * the organization a request targets.
 *
 * Provided on the root context as `mgmGate` (see `root.ts`). Routes whose
 * bodies still query Supabase directly call `gateRoute()` before doing any
 * work; capability routes are gated inside their composer instead.
 *
 * Policy (docs/cordis-runtime.md § "The gate"):
 *   - writes on a disabled non-core plugin → 409 `<plugin>_disabled`
 *   - reads always pass (disabling preserves data)
 *   - unresolvable target → pass; the route's own 404/403 applies and RLS
 *     stays the authority
 *   - organization or plugin state unreadable on a write → 503, fail closed
 */
import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { getMgmRuntime } from "./root";
import type { MgmCatalog } from "./services";

export type GateTarget =
  | { kind: "organization"; id: string }
  | { kind: "community"; id: string }
  | { kind: "microgrid"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "device"; id: string }
  | { kind: "billingPeriod"; id: string }
  | { kind: "lineItem"; id: string }
  | { kind: "rateSchedule"; id: string };

export type GateRequest = {
  plugin: MgmPluginName;
  target: GateTarget;
  /** HTTP method of the route. Only writes are gated. */
  method: string;
  /**
   * Overrides the method-derived classification. `write` gates a request
   * that changes data or calls the plugin's external integration even when
   * it is a GET; `read` exempts a POST that only computes a preview.
   */
  access?: "read" | "write";
};

export type GateDecision =
  | { ok: true; organizationId: string | null }
  | { ok: false; status: 409 | 503; code: string; message: string };

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Copy shown when a plugin is off; matches the capability composers. */
const DISABLED_MESSAGES: Partial<Record<MgmPluginName, string>> = {
  "community-management":
    "Community management is disabled for this organization. Enable it in Settings → Plugins; existing records are preserved.",
  metering:
    "Metering is disabled for this organization. Enable it in Settings → Plugins; configuration, assignments, and readings are preserved.",
  billing:
    "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.",
  payments:
    "Payments are disabled for this organization. Enable them in Settings → Plugins; history and reconciliation are preserved.",
  "synthetic-metering":
    "Synthetic metering is disabled for this organization. Enable it in Settings → Plugins; stored data is preserved.",
  pesapal:
    "The Pesapal provider is disabled for this organization. Enable it in Settings → Plugins; history is preserved.",
};

/** Error-code prefix per plugin, e.g. `billing_disabled`. */
function codePrefix(plugin: MgmPluginName): string {
  return plugin === "community-management" ? "community_management" : plugin;
}

type Embedded<T> = T | T[] | null | undefined;

function one<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type OrgRow = { org_id: string };
type MicrogridRow = { communities: Embedded<OrgRow> };
type EdgeRow = { microgrids: Embedded<MicrogridRow> };

/**
 * Resolve the organization that owns a target, through the caller's
 * RLS-scoped client. `null` means not visible (or not found). Throws when
 * the query itself fails.
 */
export async function resolveTargetOrganization(
  supabase: SupabaseClient,
  target: GateTarget
): Promise<string | null> {
  const single = async <T>(table: string, columns: string, id: string): Promise<T | null> => {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as T | null) ?? null;
  };

  switch (target.kind) {
    case "organization":
      return target.id;
    case "community": {
      const row = await single<OrgRow>("communities", "id, org_id", target.id);
      return row?.org_id ?? null;
    }
    case "microgrid": {
      const row = await single<MicrogridRow>(
        "microgrids",
        "id, communities!inner(org_id)",
        target.id
      );
      return one(row?.communities)?.org_id ?? null;
    }
    case "edge": {
      const row = await single<EdgeRow>(
        "edges",
        "id, microgrids!inner(communities!inner(org_id))",
        target.id
      );
      return one(one(row?.microgrids)?.communities)?.org_id ?? null;
    }
    case "device": {
      const row = await single<{ edges: Embedded<EdgeRow> }>(
        "devices",
        "id, edges!inner(microgrids!inner(communities!inner(org_id)))",
        target.id
      );
      return one(one(one(row?.edges)?.microgrids)?.communities)?.org_id ?? null;
    }
    case "billingPeriod": {
      const row = await single<{ microgrids: Embedded<MicrogridRow> }>(
        "billing_periods",
        "id, microgrids!inner(communities!inner(org_id))",
        target.id
      );
      return one(one(row?.microgrids)?.communities)?.org_id ?? null;
    }
    case "lineItem": {
      const row = await single<{ billing_periods: Embedded<{ microgrids: Embedded<MicrogridRow> }> }>(
        "billing_line_items",
        "id, billing_periods!inner(microgrids!inner(communities!inner(org_id)))",
        target.id
      );
      return (
        one(one(one(row?.billing_periods)?.microgrids)?.communities)?.org_id ?? null
      );
    }
    case "rateSchedule": {
      const row = await single<{ microgrids: Embedded<MicrogridRow> }>(
        "rate_schedules",
        "id, microgrids!inner(communities!inner(org_id))",
        target.id
      );
      return one(one(row?.microgrids)?.communities)?.org_id ?? null;
    }
  }
}

export class MgmGate {
  constructor(private readonly catalog: MgmCatalog) {}

  disabledMessage(plugin: MgmPluginName): string {
    const displayName = this.catalog.get(plugin)?.displayName ?? plugin;
    return (
      DISABLED_MESSAGES[plugin] ??
      `${displayName} is disabled for this organization. Enable it in Settings → Plugins.`
    );
  }

  async check(supabase: SupabaseClient, request: GateRequest): Promise<GateDecision> {
    if (!this.catalog.get(request.plugin)) {
      throw new Error(`Unknown MGM plugin "${request.plugin}"`);
    }
    const isWrite =
      request.access === undefined
        ? WRITE_METHODS.has(request.method.toUpperCase())
        : request.access === "write";
    if (!isWrite || this.catalog.isCore(request.plugin)) {
      return { ok: true, organizationId: null };
    }

    const prefix = codePrefix(request.plugin);
    const unavailable: GateDecision = {
      ok: false,
      status: 503,
      code: `${prefix}_gate_unavailable`,
      message: `Could not verify whether ${
        this.catalog.get(request.plugin)?.displayName ?? request.plugin
      } is enabled. Retry the request.`,
    };

    let organizationId: string | null;
    try {
      organizationId = await resolveTargetOrganization(supabase, request.target);
    } catch {
      return unavailable;
    }
    if (!organizationId) return { ok: true, organizationId: null };

    let enabled: boolean;
    try {
      enabled = await isPluginEnabledForOrg(supabase, organizationId, request.plugin);
    } catch {
      return unavailable;
    }
    if (!enabled) {
      return {
        ok: false,
        status: 409,
        code: `${prefix}_disabled`,
        message: this.disabledMessage(request.plugin),
      };
    }
    return { ok: true, organizationId };
  }
}

/** Run the root gate for one request and return its decision. */
export async function checkGate(
  supabase: SupabaseClient,
  request: GateRequest
): Promise<GateDecision> {
  const runtime = await getMgmRuntime();
  return runtime.gate.check(supabase, request);
}

/** The JSON response a blocked request returns. */
export function gateResponse(
  decision: Extract<GateDecision, { ok: false }>
): NextResponse {
  return NextResponse.json(
    { error: decision.message, code: decision.code },
    { status: decision.status }
  );
}

/**
 * Route entry point: returns a response to send when the gate blocks the
 * request, or `null` to continue.
 */
export async function gateRoute(
  supabase: SupabaseClient,
  request: GateRequest
): Promise<NextResponse | null> {
  const decision = await checkGate(supabase, request);
  return decision.ok ? null : gateResponse(decision);
}

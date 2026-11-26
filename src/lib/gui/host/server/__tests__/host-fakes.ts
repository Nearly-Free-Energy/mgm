import type { SupabaseClient, User } from "@supabase/supabase-js";
import { vi } from "vitest";
import type { Caller } from "@/lib/runtime/caller";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { Fmt } from "../../../surface";
import { hostContext, type HostContext } from "../access";

export const ORG_A = "e7100000-0000-4000-8000-000000000001";
export const ORG_B = "e7100000-0000-4000-8000-000000000002";

const USER = { id: "e7100000-0000-4000-8fff-000000000001", email: "host@test.local" } as User;

function role(r: "super_admin" | "org_manager", scopeId: string | null): UserRoleRecord {
  return {
    id: `role-${r}-${scopeId ?? "all"}`,
    user_id: USER.id,
    role: r,
    scope_type: "org",
    scope_id: scopeId,
    scope_org_id: scopeId,
    scope_microgrid_id: null,
    scope_tenant_id: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}
export const managerOf = (orgId: string) => role("org_manager", orgId);
export const superAdmin = () => role("super_admin", null);
/**
 * An `fn_tenant_home` row (20261118100100) for each of `units`, answering
 * only the unit asked for, as the function answers a caller holding a
 * tenant row for it. Pass to tableClient's `rpcs`.
 */
export function tenantHomes(
  units: readonly { id: string; name: string; unitLabel?: string | null; microgrid?: string; timezone?: string; orgId: string }[],
) {
  return {
    fn_tenant_home: (args: Record<string, unknown>): TableResult => {
      const unit = units.find((u) => u.id === args._tenant_id);
      return {
        data: unit
          ? [
              {
                tenant_id: unit.id,
                display_name: unit.name,
                unit_label: unit.unitLabel ?? null,
                microgrid_id: "e7100000-0000-4000-8003-000000000001",
                microgrid_name: unit.microgrid ?? "Kasana East",
                timezone: unit.timezone ?? "Africa/Kampala",
                currency: "UGX",
                organization_id: unit.orgId,
              },
            ]
          : [],
      };
    },
  };
}

/** A tenant row for the unit `tenantId` (RFC mgm#197): not staff, so it reaches no organization. */
export function tenantOf(tenantId: string): UserRoleRecord {
  return {
    id: `role-tenant-${tenantId}`,
    user_id: USER.id,
    role: "tenant",
    scope_type: "tenant",
    scope_id: tenantId,
    scope_org_id: null,
    scope_microgrid_id: null,
    scope_tenant_id: tenantId,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** Enough of Fmt for labels: a date prints as D(<date>), so a label that skips fmt shows. */
export const fakeFmt = { date: (d: string) => ({ t: "date", v: d, text: `D(${d})` }) } as unknown as Fmt;

/** An agent client's caller (RFC #259 § 2), for contextFor. */
export const AGENT_CALLER: Caller = { kind: "agent", clientId: "e7100000-0000-4000-8fff-0000000000c1" };

/** A HostContext over `newClient`, issued by hostContext as routes will; a browser session's unless `caller` says otherwise. */
export function contextFor(
  roles: UserRoleRecord[],
  newClient: () => Promise<SupabaseClient> = vi.fn(async () => ({}) as SupabaseClient),
  caller?: Caller,
): HostContext {
  const made = hostContext({ user: USER, roles }, new Headers({ "accept-language": "en-UG" }), {
    newClient,
    makeFmt: () => fakeFmt,
    now: new Date("2026-11-09T08:00:00Z"),
    ...(caller ? { caller } : {}),
  });
  if (!made.ok) throw new Error("fixture context refused");
  return made.ctx;
}

type TableResult = { data: unknown; error?: { message: string } | null };

/**
 * A client whose from(table) answers `results[table]` whatever the filters,
 * awaited or through maybeSingle() (the first row), and whose rpc(name,
 * args) answers `rpcs[name](args)`, or an error for a function not given.
 * `calls` records each query's table and the methods called on it, and each
 * call as table `rpc:<name>` with its arguments.
 */
export function tableClient(
  results: Record<string, TableResult>,
  rpcs: Record<string, (args: Record<string, unknown>) => TableResult> = {},
) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      calls.push({ table: `rpc:${name}`, ops: [["rpc", [args]]] });
      const answer = rpcs[name]?.(args) ?? { data: null, error: { message: `no fake for ${name}` } };
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
    from(table: string) {
      const ops: [string, unknown[]][] = [];
      calls.push({ table, ops });
      const result = { data: results[table]?.data ?? null, error: results[table]?.error ?? null };
      const chain: Record<string, unknown> = {
        maybeSingle: async () => (ops.push(["maybeSingle", []]), { data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data, error: result.error }),
        then: (resolve: (r: typeof result) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      for (const op of ["select", "eq", "in", "not", "lt", "gte", "lte", "order", "limit", "range"]) {
        chain[op] = (...args: unknown[]) => {
          ops.push([op, args]);
          return chain;
        };
      }
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

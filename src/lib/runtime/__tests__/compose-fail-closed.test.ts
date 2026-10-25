/**
 * The capability composers that read plugin state themselves fail closed and
 * leave the root as they found it (docs/cordis-runtime.md § "The gate",
 * § "Two lifetimes"). `gate.test.ts` covers the same for `checkGate`.
 *
 *   - Plugin state cannot be read: 503, and no scope is opened.
 *   - The read says the plugin is off: 409, and no scope is opened.
 *   - The scope opens but the capability plugin fails to load: 500, and the
 *     composer disposes what it opened.
 *
 * The plugin-state reads run for real, through supabase-js, against a fetch
 * that answers as each case says. That matters for the 503: supabase-js
 * resolves an unreachable database or a database error as `{ data: null,
 * error }` and never rejects (checked below), so a composer that only caught
 * a rejection would pass a rejecting fake and still answer 409 "disabled" in
 * production. The rejecting client is kept as a case of its own. Every
 * refusal is compared with the gate's for the same client, so the composers
 * and the gate cannot drift apart unnoticed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { composeBilling } from "@/lib/billing/compose";
import { composeCommunityManagement } from "@/lib/community-management/compose";
import { composeMetering } from "@/lib/metering/compose";
import { openOrganizationScope } from "@/lib/runtime/scope";
import { getMgmRuntime, resetMgmRuntimeForTests } from "../root";

const ORG = "550e8400-e29b-41d4-a716-446655440000";

/** Ways plugin state can fail to be read. */
const UNREADABLE = [
  { read: "unreachable", when: "the database is unreachable" },
  { read: "database-error", when: "the database answers with an error" },
  { read: "rejects", when: "the client call itself rejects" },
] as const;
type Unreadable = (typeof UNREADABLE)[number]["read"];

const state = vi.hoisted(() => ({
  /** How the plugin-state RPC answers. */
  read: "enabled" as "enabled" | "disabled" | Unreadable,
  /** Plugins whose capability constructor throws. */
  failing: new Set<string>(),
  /** The root registry size each failing constructor saw, to show the scope was open. */
  sizesAtFailure: [] as number[],
  root: null as { registry: { size: number } } | null,
}));

function failToConstruct(plugin: string) {
  if (!state.failing.has(plugin)) return;
  if (state.root) state.sizesAtFailure.push(state.root.registry.size);
  throw new Error("capability failed to construct");
}

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => [
    { user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: ORG },
  ],
}));

// Wrapped, not replaced: the spy records whether a composer opened a scope.
vi.mock("@/lib/runtime/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime/scope")>();
  return { ...actual, openOrganizationScope: vi.fn(actual.openOrganizationScope) };
});

vi.mock("@/lib/billing/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/capability")>();
  return {
    ...actual,
    BillingCapability: class extends actual.BillingCapability {
      constructor(...args: ConstructorParameters<typeof actual.BillingCapability>) {
        failToConstruct("billing");
        super(...args);
      }
    },
  };
});

vi.mock("@/lib/metering/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metering/capability")>();
  return {
    ...actual,
    MeteringCapability: class extends actual.MeteringCapability {
      constructor(...args: ConstructorParameters<typeof actual.MeteringCapability>) {
        failToConstruct("metering");
        super(...args);
      }
    },
  };
});

vi.mock("@/lib/community-management/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/community-management/capability")>();
  return {
    ...actual,
    CommunityManagementCapability: class extends actual.CommunityManagementCapability {
      constructor(
        ...args: ConstructorParameters<typeof actual.CommunityManagementCapability>
      ) {
        failToConstruct("community-management");
        super(...args);
      }
    },
  };
});

/** A supabase-js client whose requests answer per `state.read`. */
const postgrest = createClient("http://supabase.test", "anon-key", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: async () => {
      if (state.read === "unreachable") throw new TypeError("fetch failed");
      if (state.read === "database-error") {
        return Response.json(
          {
            code: "57014",
            message: "canceling statement due to statement timeout",
            details: null,
            hint: null,
          },
          { status: 500 }
        );
      }
      return Response.json(state.read === "enabled");
    },
  },
});

type FakeClient = SupabaseClient & { rpc: ReturnType<typeof vi.fn> };

/**
 * An authenticated caller whose plugin-state RPC goes through `postgrest`,
 * except in the `rejects` case, where the call itself rejects.
 */
function client(): FakeClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "mgm_plugin_enabled_for_org") throw new Error(`Unexpected RPC: ${fn}`);
      if (state.read === "rejects") throw new Error("fetch failed");
      return postgrest.rpc(fn, args);
    }),
  } as unknown as FakeClient;
}

type Composed =
  | { ok: true; data: { dispose(): Promise<void> } }
  | { ok: false; status: number; code: string; message: string };

const COMPOSERS: {
  plugin: MgmPluginName;
  compose(supabase: SupabaseClient): Promise<Composed>;
  failed: string;
}[] = [
  {
    plugin: "billing",
    compose: (supabase) => composeBilling({ supabase, organizationId: ORG }),
    failed: "billing_composition_failed",
  },
  {
    plugin: "metering",
    compose: (supabase) => composeMetering({ supabase, organizationId: ORG }),
    failed: "metering_composition_failed",
  },
  {
    plugin: "community-management",
    compose: (supabase) => composeCommunityManagement({ supabase, organizationId: ORG }),
    failed: "community_composition_failed",
  },
];

/** What the gate answers a write on this plugin with the same client. */
async function gateRefusal(plugin: MgmPluginName, supabase: SupabaseClient) {
  const runtime = await getMgmRuntime();
  const decision = await runtime.gate.check(supabase, {
    plugin,
    target: { kind: "organization", id: ORG },
    method: "POST",
  });
  if (decision.ok) throw new Error(`expected the gate to refuse ${plugin}`);
  return decision;
}

afterEach(async () => {
  state.read = "enabled";
  state.failing.clear();
  state.sizesAtFailure.length = 0;
  state.root = null;
  vi.clearAllMocks();
  await resetMgmRuntimeForTests();
});

describe("supabase-js", () => {
  it.each(UNREADABLE.filter(({ read }) => read !== "rejects"))(
    "resolves the plugin-state read with an error, not a rejection, when $when",
    async ({ read }) => {
      state.read = read;

      const answer = await client().rpc("mgm_plugin_enabled_for_org", {
        _org_id: ORG,
        _plugin_name: "billing",
      });

      expect(answer).toMatchObject({ data: null, error: expect.any(Object) });
    }
  );
});

describe.each(COMPOSERS)("$plugin composer", ({ plugin, compose, failed }) => {
  it.each(UNREADABLE)(
    "answers 503 like the gate and opens no scope when $when",
    async ({ read }) => {
      const runtime = await getMgmRuntime();
      const before = runtime.root.registry.size;
      state.read = read;
      const supabase = client();

      const result = await compose(supabase);

      expect(supabase.rpc).toHaveBeenCalledWith("mgm_plugin_enabled_for_org", {
        _org_id: ORG,
        _plugin_name: plugin,
      });
      expect(openOrganizationScope).not.toHaveBeenCalled();
      expect(runtime.root.registry.size).toBe(before);
      const { status, code, message } = await gateRefusal(plugin, supabase);
      expect(status).toBe(503);
      expect(result).toEqual({ ok: false, status, code, message });
    }
  );

  it("answers 409 like the gate and opens no scope when the plugin is off", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    state.read = "disabled";
    const supabase = client();

    const result = await compose(supabase);

    expect(openOrganizationScope).not.toHaveBeenCalled();
    expect(runtime.root.registry.size).toBe(before);
    const { status, code, message } = await gateRefusal(plugin, supabase);
    expect(status).toBe(409);
    expect(result).toEqual({ ok: false, status, code, message });
  });

  it("disposes the scope it opened when the capability plugin fails to load", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    state.root = runtime.root;
    state.failing.add(plugin);

    const result = await compose(client());

    expect(result).toMatchObject({ ok: false, status: 500, code: failed });
    expect(openOrganizationScope).toHaveBeenCalledTimes(1);
    // The scope was open when the capability failed, so the baseline below is
    // the composer's dispose, not a scope that never registered.
    expect(state.sizesAtFailure).toHaveLength(1);
    expect(state.sizesAtFailure[0]).toBeGreaterThan(before);
    expect(runtime.root.registry.size).toBe(before);
  });
});

describe("composeBilling readOnly", () => {
  it("skips the plugin-state read, so an unreadable state does not block a read-only caller", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    state.read = "unreachable";
    const supabase = client();

    const result = await composeBilling({ supabase, organizationId: ORG, readOnly: true });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(supabase.rpc).not.toHaveBeenCalled();
    if (result.ok) await result.data.dispose();
    expect(runtime.root.registry.size).toBe(before);
  });
});

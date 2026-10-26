/**
 * The capability composers that read plugin state themselves fail closed and
 * leave the root as they found it (docs/cordis-runtime.md § "The gate",
 * § "Two lifetimes"). `gate.test.ts` covers the same for `checkGate`.
 *
 *   - Plugin state cannot be read: 503, and no scope is opened.
 *   - The read says the plugin is off: 409, and no scope is opened.
 *   - The scope opens but the capability plugin fails to load: 500, and the
 *     composer disposes what it opened.
 *   - After composition, the capability reads plugin state again before a
 *     write, through the Supabase repository the composer handed it, and
 *     refuses with the same 409 or 503 when the plugin was turned off in
 *     between or its state cannot be read.
 *
 * The payments composers and `composeBillingReview` read no plugin state at
 * compose time, so only the load failure applies to them; if one starts to,
 * add it to COMPOSERS.
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
import { composeBillingReview } from "@/lib/cordis/billing-review";
import { composeMetering } from "@/lib/metering/compose";
import { composePayments, composePaymentsPublic } from "@/lib/payments/compose";
import { openOrganizationScope } from "@/lib/runtime/scope";
import { getMgmRuntime, resetMgmRuntimeForTests } from "../root";

const ORG = "550e8400-e29b-41d4-a716-446655440000";
const COMMUNITY = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID = "550e8400-e29b-41d4-a716-446655440002";

/** The rows a capability reads to resolve a microgrid's organization. */
const ROWS: Record<string, Record<string, unknown>> = {
  microgrids: { id: MICROGRID, community_id: COMMUNITY },
  communities: { id: COMMUNITY, org_id: ORG },
};

/** Ways plugin state can fail to be read. */
const UNREADABLE = [
  { read: "unreachable", when: "the database is unreachable" },
  { read: "database-error", when: "the database answers with an error" },
  { read: "rejects", when: "the client call itself rejects" },
] as const;
type Unreadable = (typeof UNREADABLE)[number]["read"];
type Read = "enabled" | "disabled" | Unreadable;

/** What a capability's re-check before a write can meet once composition passed. */
const AT_RECHECK: { read: Read; when: string }[] = [
  { read: "disabled", when: "the plugin has been turned off" },
  ...UNREADABLE,
];

const state = vi.hoisted(() => ({
  /** How the plugin-state RPC answers. */
  read: "enabled" as Read,
  /** When set, how successive plugin-state reads answer; the last one sticks. */
  reads: [] as Read[],
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

vi.mock("@/lib/payments/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/capability")>();
  return {
    ...actual,
    PaymentsCapability: class extends actual.PaymentsCapability {
      constructor(...args: ConstructorParameters<typeof actual.PaymentsCapability>) {
        failToConstruct("payments");
        super(...args);
      }
    },
  };
});

// composePayments builds its repository's writer from the service-role
// client; the capability under test never reaches it.
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));

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
 * except in the `rejects` case, where the call itself rejects. Its table
 * reads answer from ROWS.
 */
function client(): FakeClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "mgm_plugin_enabled_for_org") throw new Error(`Unexpected RPC: ${fn}`);
      if (state.reads.length > 0) {
        state.read = state.reads.length > 1 ? state.reads.shift()! : state.reads[0];
      }
      if (state.read === "rejects") throw new Error("fetch failed");
      return postgrest.rpc(fn, args);
    }),
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: ROWS[table] ?? null, error: null }),
      };
      return query;
    },
  } as unknown as FakeClient;
}

type Composed =
  | { ok: true; data: { dispose(): Promise<void> } }
  | { ok: false; status: number; code: string; message: string };

/** Compose, run one capability call, and dispose. */
async function afterComposing<T extends { dispose(): Promise<void> }>(
  composed: { ok: true; data: T } | { ok: false; code: string },
  call: (data: T) => Promise<unknown>
): Promise<unknown> {
  if (!composed.ok) throw new Error(`composition failed: ${composed.code}`);
  try {
    return await call(composed.data);
  } finally {
    await composed.data.dispose();
  }
}

const COMPOSERS: {
  plugin: MgmPluginName;
  compose(supabase: SupabaseClient): Promise<Composed>;
  failed: string;
  /** Composes, then makes a write that reaches the capability's plugin re-check. */
  write(supabase: SupabaseClient): Promise<unknown>;
}[] = [
  {
    plugin: "billing",
    compose: (supabase) => composeBilling({ supabase, organizationId: ORG }),
    failed: "billing_composition_failed",
    write: async (supabase) =>
      afterComposing(await composeBilling({ supabase, organizationId: ORG }), (data) =>
        data.billing.createTariff({ microgrid_id: MICROGRID })
      ),
  },
  {
    plugin: "metering",
    compose: (supabase) => composeMetering({ supabase, organizationId: ORG }),
    failed: "metering_composition_failed",
    write: async (supabase) =>
      afterComposing(await composeMetering({ supabase, organizationId: ORG }), (data) =>
        data.metering.discoverMeters(MICROGRID)
      ),
  },
  {
    plugin: "community-management",
    compose: (supabase) => composeCommunityManagement({ supabase, organizationId: ORG }),
    failed: "community_composition_failed",
    write: async (supabase) =>
      afterComposing(
        await composeCommunityManagement({ supabase, organizationId: ORG }),
        (data) => data.communityManagement.createCommunity({ org_id: ORG, name: "Community A" })
      ),
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
  state.reads = [];
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

describe.each(COMPOSERS)("$plugin composer", ({ plugin, compose, failed, write }) => {
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

  it.each(AT_RECHECK)(
    "refuses a write like the gate when, at the capability's re-check, $when",
    async ({ read }) => {
      // The composer's read passes; the capability's own read before the
      // write answers as the case says.
      state.reads = ["enabled", read];
      const supabase = client();

      const result = await write(supabase);

      // Both reads ask about this plugin for this organization, so a
      // repository wired to another plugin's state fails here.
      expect(supabase.rpc).toHaveBeenCalledTimes(2);
      expect(supabase.rpc).toHaveBeenLastCalledWith("mgm_plugin_enabled_for_org", {
        _org_id: ORG,
        _plugin_name: plugin,
      });
      const { status, code, message } = await gateRefusal(plugin, supabase);
      expect(status).toBe(read === "disabled" ? 409 : 503);
      expect(result).toEqual({ ok: false, status, code, message });
    }
  );
});

describe.each([
  {
    composer: "composePayments",
    compose: (supabase: SupabaseClient) => composePayments({ supabase, organizationId: ORG }),
  },
  {
    composer: "composePaymentsPublic",
    compose: (supabase: SupabaseClient) =>
      composePaymentsPublic({ supabase, organizationId: ORG }),
  },
])("$composer", ({ compose }) => {
  it("disposes the scope it opened when the capability plugin fails to load", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    state.root = runtime.root;
    state.failing.add("payments");
    const supabase = client();

    const result = await compose(supabase);

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      code: "payments_composition_failed",
    });
    // Payments reads plugin state per capability method, not when composing.
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(openOrganizationScope).toHaveBeenCalledTimes(1);
    expect(state.sizesAtFailure).toHaveLength(1);
    expect(state.sizesAtFailure[0]).toBeGreaterThan(before);
    expect(runtime.root.registry.size).toBe(before);
  });
});

describe("composeBillingReview", () => {
  it("disposes the scope it opened, and rethrows, when the capability plugin fails to load", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    // BillingReviewPlugin creates every root metering source for the request
    // in `apply`, once the scope is open, so a factory that throws fails the
    // load there. If the plugin stops creating sources in `apply`, the
    // rejection below fails; pick another seam.
    const unregister = runtime.meteringProviders.register("broken", () => {
      state.sizesAtFailure.push(runtime.root.registry.size);
      throw new Error("metering source failed to start");
    });

    try {
      await expect(
        composeBillingReview({ supabase: client(), organizationId: ORG, userId: "user-1" })
      ).rejects.toThrow("metering source failed to start");
    } finally {
      unregister();
    }

    expect(openOrganizationScope).toHaveBeenCalledTimes(1);
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

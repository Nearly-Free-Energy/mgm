/**
 * Which client the Payments plugin-state reads go through.
 *
 * `createSupabasePaymentsRepository(supabase, writer)` takes the request's
 * client first and, from `composePayments`, the service-role client as
 * `writer`. The `isPaymentsEnabled` / `isPesapalEnabled` reads must use the
 * first, the client the gate and the other composers read the same request's
 * plugin state through, so that `ensureCheckout` refuses on the same answer
 * they give. `capability-gating.test.ts` builds the repository with one
 * client for both and replaces the factory for the composers, so it cannot
 * see either slip checked here; if it comes to pass a distinct writer or to
 * compose through the real factory, revisit whether these cases still add
 * anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resetMgmRuntimeForTests } from "@/lib/runtime/root";
import { composePayments, composePaymentsPublic } from "../compose";
import { createSupabasePaymentsRepository } from "../infrastructure/supabase-repository";

const ORG = "550e8400-e29b-41d4-a716-446655440000";

const service = vi.hoisted(() => ({ client: { name: "service-role client" } }));

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => [
    { user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: ORG },
  ],
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => service.client }));
// Wrapped, not replaced: the spy records the clients each composer passes.
vi.mock("@/lib/payments/infrastructure/supabase-repository", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/payments/infrastructure/supabase-repository")
  >();
  return {
    ...actual,
    createSupabasePaymentsRepository: vi.fn(actual.createSupabasePaymentsRepository),
  };
});

type StateClient = SupabaseClient & { rpc: ReturnType<typeof vi.fn> };

/** A client whose plugin-state reads all answer `enabled`. */
function stateClient(enabled: boolean): StateClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc: vi.fn(async () => ({ data: enabled, error: null })),
  } as unknown as StateClient;
}

afterEach(async () => {
  vi.clearAllMocks();
  await resetMgmRuntimeForTests();
});

describe.each([
  ["isPaymentsEnabled", "payments"],
  ["isPesapalEnabled", "pesapal"],
] as const)("the Supabase payments repository's %s", (method, plugin) => {
  it.each([
    { enabled: true, there: "on" },
    { enabled: false, there: "off" },
  ])(
    "answers from the request's client, not the writer, when the plugin is $there there",
    async ({ enabled }) => {
      const reader = stateClient(enabled);
      const writer = stateClient(!enabled);

      const answer = await createSupabasePaymentsRepository(reader, writer)[method](ORG);

      expect(answer).toBe(enabled);
      expect(reader.rpc).toHaveBeenCalledWith("mgm_plugin_enabled_for_org", {
        _org_id: ORG,
        _plugin_name: plugin,
      });
      expect(writer.rpc).not.toHaveBeenCalled();
    }
  );
});

describe("the payments composers' repository", () => {
  it("composePayments reads through the request's client and writes through the service-role client", async () => {
    const request = stateClient(true);

    const composed = await composePayments({ supabase: request, organizationId: ORG });
    if (composed.ok) await composed.data.dispose();

    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    expect(createSupabasePaymentsRepository).toHaveBeenCalledTimes(1);
    expect(createSupabasePaymentsRepository).toHaveBeenCalledWith(request, service.client);
  });

  it("composePaymentsPublic reads and writes through the client it is given", async () => {
    const supabase = stateClient(true);

    const composed = await composePaymentsPublic({ supabase, organizationId: ORG });
    if (composed.ok) await composed.data.dispose();

    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    expect(createSupabasePaymentsRepository).toHaveBeenCalledTimes(1);
    expect(createSupabasePaymentsRepository).toHaveBeenCalledWith(supabase);
  });
});

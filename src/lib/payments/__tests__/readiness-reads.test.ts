/**
 * Payment readiness reads independent rows together.
 *
 * `getReadiness` loads the merchant account and both plugin states at once,
 * and the Supabase repository's `loadMerchantAccountPublic` loads the
 * community scope check, the override and the org default at once. Both
 * still judge the results in the order the reads used to run, so these
 * cases pin the outcomes (and which errors win) alongside the concurrency.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PaymentsCapability } from "../capability";
import { createSupabasePaymentsRepository } from "../infrastructure/supabase-repository";
import type { PaymentsRepository } from "../repository";
import { COMMUNITY, ORG, baseRepo, providers, scope } from "./fixtures";

const READY_ACCOUNT = {
  id: "acc-1",
  org_id: ORG,
  provider: "pesapal" as const,
  display_name: "Default Pesapal account",
  sandbox: false,
  consumer_key: "key",
  base_url: "https://pay.pesapal.com/v3",
  ipn_id: "ipn-1",
  ipn_url: null,
  version: 1,
  disabled: false,
  last_tested_at: null,
  last_test_status: "success",
  last_test_message: null,
  origin: "org_default" as const,
  community_id: null,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const capabilityFor = (repo: ReturnType<typeof baseRepo>) =>
  new PaymentsCapability(repo, scope(), providers(), () => true, (p) => p);

describe("getReadiness", () => {
  it("reads both plugin states while the merchant account loads", async () => {
    const account = deferred<{ ok: true; account: typeof READY_ACCOUNT; hasOverride: false }>();
    const isPaymentsEnabled = vi.fn(async () => true);
    const isPesapalEnabled = vi.fn(async () => true);
    const repo = baseRepo({
      loadMerchantAccountPublic: () => account.promise,
      isPaymentsEnabled,
      isPesapalEnabled,
    });

    const readiness = capabilityFor(repo).getReadiness(COMMUNITY);
    await vi.waitFor(() => {
      expect(isPaymentsEnabled).toHaveBeenCalledWith(ORG);
      expect(isPesapalEnabled).toHaveBeenCalledWith(ORG);
    });
    account.resolve({ ok: true, account: READY_ACCOUNT, hasOverride: false });

    expect(await readiness).toEqual({
      ok: true,
      data: { state: "ready", message: "Live account ready.", account: READY_ACCOUNT },
    });
  });

  const off = async (): Promise<boolean> => false;
  const unreadable = (): Promise<boolean> => Promise.reject(new Error("rpc"));

  it.each<[string, Partial<PaymentsRepository>]>([
    ["payments is off", { isPaymentsEnabled: off }],
    ["pesapal is off", { isPesapalEnabled: off }],
    ["payments state is unreadable", { isPaymentsEnabled: unreadable }],
    ["pesapal state is unreadable", { isPesapalEnabled: unreadable }],
    ["payments is off and pesapal is unreadable", { isPaymentsEnabled: off, isPesapalEnabled: unreadable }],
  ])("reports disabled when %s", async (_when, overrides) => {
    const repo = baseRepo({
      loadMerchantAccountPublic: async () => ({ ok: true as const, account: READY_ACCOUNT, hasOverride: false }),
      ...overrides,
    });
    const readiness = await capabilityFor(repo).getReadiness(COMMUNITY);
    expect(readiness).toEqual({
      ok: true,
      data: {
        state: "disabled",
        message: "Online payments are disabled. Manual payment recording remains available.",
      },
    });
  });

  it("reports the merchant-account refusal ahead of plugin state", async () => {
    const repo = baseRepo({
      loadMerchantAccountPublic: async () => ({
        ok: false as const,
        code: "payments_scope_mismatch",
        message: "Community not available in this organization.",
      }),
      isPaymentsEnabled: async () => false,
    });
    const readiness = await capabilityFor(repo).getReadiness(COMMUNITY);
    expect(readiness).toMatchObject({ ok: false, status: 500, code: "payments_unavailable" });
  });

  it("rejects with the merchant-account error, whatever the plugin reads do", async () => {
    const repo = baseRepo({
      loadMerchantAccountPublic: () => Promise.reject(new Error("Could not load payment account")),
      isPaymentsEnabled: () => Promise.reject(new Error("rpc")),
    });
    await expect(capabilityFor(repo).getReadiness(COMMUNITY)).rejects.toThrow(
      "Could not load payment account"
    );
  });
});

type Reply = { data: unknown; error: { message: string } | null };

/**
 * A client for `loadMerchantAccountPublic`: each table answers `replies`,
 * the merchant-account table by default-account or by-id lookup. `issued`
 * records the reads in the order they were sent.
 */
function merchantClient(replies: {
  scope?: Reply;
  override?: Reply;
  defaultAccount?: Reply;
  overrideAccount?: Reply;
}) {
  const issued: string[] = [];
  const pending: Array<() => void> = [];
  let held = true;
  const answer = (label: string, reply: Reply) => {
    issued.push(label);
    return new Promise<Reply>((resolve) => {
      const send = () => resolve(reply);
      if (held) pending.push(send);
      else send();
    });
  };
  const chain = (onTerminal: (filters: Record<string, unknown>) => Promise<Reply>) => {
    const filters: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => onTerminal(filters),
    };
    return builder;
  };
  const client = {
    from: (table: string) => {
      if (table === "communities") {
        return chain(() => answer("communities", replies.scope ?? { data: { id: COMMUNITY }, error: null }));
      }
      if (table === "community_payment_overrides") {
        return chain(() => answer("override", replies.override ?? { data: null, error: null }));
      }
      if (table === "payment_merchant_accounts") {
        return chain((filters) =>
          "id" in filters
            ? answer("override account", replies.overrideAccount ?? { data: null, error: null })
            : answer("default account", replies.defaultAccount ?? { data: null, error: null })
        );
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
  /** Answers every read sent so far, and every later one at once. */
  const release = () => {
    held = false;
    pending.splice(0).forEach((send) => send());
  };
  return { client, issued, release };
}

const ACCOUNT_ROW = { ...READY_ACCOUNT, origin: undefined, community_id: undefined };
const load = (client: SupabaseClient) =>
  createSupabasePaymentsRepository(client).loadMerchantAccountPublic({ orgId: ORG, communityId: COMMUNITY });

describe("loadMerchantAccountPublic", () => {
  it("sends the scope check, the override and the org default together", async () => {
    const { client, issued, release } = merchantClient({ defaultAccount: { data: ACCOUNT_ROW, error: null } });
    const loaded = load(client);
    await vi.waitFor(() =>
      expect([...issued].sort()).toEqual(["communities", "default account", "override"])
    );
    release();
    expect(await loaded).toMatchObject({ ok: true, hasOverride: false, account: { id: "acc-1", origin: "org_default" } });
  });

  it("answers no account when there is no override and no default", async () => {
    const { client, release } = merchantClient({});
    release();
    expect(await load(client)).toEqual({ ok: true, account: null, hasOverride: false });
  });

  it("refuses a community outside the org, whatever the other reads return", async () => {
    const { client, release } = merchantClient({
      scope: { data: null, error: null },
      override: { data: null, error: { message: "override failed" } },
      defaultAccount: { data: null, error: { message: "default failed" } },
    });
    release();
    expect(await load(client)).toMatchObject({ ok: false, code: "payments_scope_mismatch" });
  });

  it("throws the scope error first", async () => {
    const { client, release } = merchantClient({
      scope: { data: null, error: { message: "scope failed" } },
      override: { data: null, error: { message: "override failed" } },
    });
    release();
    await expect(load(client)).rejects.toThrow("Could not authorize community");
  });

  it("throws the override error ahead of the default's", async () => {
    const { client, release } = merchantClient({
      override: { data: null, error: { message: "override failed" } },
      defaultAccount: { data: null, error: { message: "default failed" } },
    });
    release();
    await expect(load(client)).rejects.toThrow("Could not load community payment override");
  });

  it("uses the override's account and ignores the default, even a failed default read", async () => {
    const { client, issued, release } = merchantClient({
      override: { data: { id: "ovr-1", merchant_account_id: "acc-2" }, error: null },
      overrideAccount: { data: { ...ACCOUNT_ROW, id: "acc-2" }, error: null },
      defaultAccount: { data: null, error: { message: "default failed" } },
    });
    release();
    expect(await load(client)).toMatchObject({
      ok: true,
      hasOverride: true,
      account: { id: "acc-2", origin: "community_override", community_id: COMMUNITY },
    });
    expect(issued).toContain("override account");
  });

  it("answers no account for an override that names none", async () => {
    const { client, issued, release } = merchantClient({
      override: { data: { id: "ovr-1", merchant_account_id: null }, error: null },
      defaultAccount: { data: ACCOUNT_ROW, error: null },
    });
    release();
    expect(await load(client)).toEqual({ ok: true, account: null, hasOverride: true });
    expect(issued).not.toContain("override account");
  });

  it("throws the default-account error when there is no override", async () => {
    const { client, release } = merchantClient({
      defaultAccount: { data: null, error: { message: "default failed" } },
    });
    release();
    await expect(load(client)).rejects.toThrow("Could not load payment account");
  });
});

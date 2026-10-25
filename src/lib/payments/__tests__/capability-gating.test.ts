/**
 * Which Payments capability methods refuse while a plugin is off.
 *
 * `composePayments` and `composePaymentsPublic` open their scope whatever
 * the plugin state, because history and verification stay available while
 * Payments is off, and the route-surface test counts a call to either as
 * gating the route. That is sound only while each capability method makes
 * the decision itself, so every method is classified here and the
 * classification is tested, not only declared:
 *
 * - refuses-when-disabled: 409 `payments_disabled` / `pesapal_disabled`, or
 *   503 `payments_gate_unavailable` when plugin state cannot be read, before
 *   a provider is obtained or anything is written;
 * - available-while-disabled: does its work with the plugins off, for the
 *   reason written beside it.
 *
 * A method added to `PaymentsCapabilityContract` fails the type check until
 * it is classified; a public method outside the contract fails the type
 * check and the prototype test. `payments-route-boundary.test.ts` covers the
 * other half: nothing a request runs reaches a provider, or writes payment
 * records, except through the capability, and a route credited with gating
 * through a composer has no other side effects, apart from the exceptions
 * that test lists with their reasons (`ALLOWED_IMPORTS`,
 * `ALLOWED_DIRECT_ACCESS`, among them the webhook's and worker's
 * notification queue).
 *
 * Plugin state comes from the Supabase repository's own reads, over a
 * supabase-js client whose fetch answers as each case says. A failed read
 * then reaches the capability as it does in production: supabase-js
 * resolves it as `{ data: null, error }` and never rejects, so the 503 holds
 * only while the repository turns that error into a rejection.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MGM_BUNDLED_PLUGINS, getBundledPlugin } from "@/lib/plugins/bundled";
import { MgmGate } from "@/lib/runtime/gate";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import type { MgmCatalog } from "@/lib/runtime/services";
import { PaymentsCapability } from "../capability";
import { composePayments, composePaymentsPublic } from "../compose";
import type { PaymentProviderClient } from "../providers/types";
import type {
  PaymentsCapabilityContract,
  PaymentsRepository,
  PaymentsResult,
  ProviderFactory,
} from "../repository";
import {
  ATTEMPT,
  COMMUNITY,
  LINE_ITEM,
  ORG,
  attempt,
  baseRepo,
  scope,
  verifiedProvider,
} from "./fixtures";

/** The repository the composers below receive, set per test. */
const composed = vi.hoisted(() => ({ repository: null as PaymentsRepository | null }));

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => [
    { user_id: "user-1", role: "super_admin", scope_type: "org", scope_id: null },
  ],
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/payments/infrastructure/supabase-repository", () => ({
  createSupabasePaymentsRepository: () => {
    if (!composed.repository) throw new Error("Set composed.repository first");
    return composed.repository;
  },
}));

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/** The rule the reasons below rest on, quoted from docs/payments-rollout.md. */
const ROLLOUT_RULE =
  "Plugin disablement blocks new checkout while keeping history and verification available.";

/** What the `payments_disabled` message promises the manager. */
const DISABLED_PROMISE = "history and reconciliation are preserved";

type Gating =
  | { gate: "refuses-when-disabled" }
  | {
      gate: "available-while-disabled";
      kind: "read" | "verification" | "reconciliation";
      reason: string;
      /** What would make `reason` wrong. */
      invalidatedBy: string;
    };

const GATING = {
  ensureCheckout: { gate: "refuses-when-disabled" },
  getReadiness: {
    gate: "available-while-disabled",
    kind: "read",
    reason:
      "Reports the plugins as disabled, which is how invoices and the billing page stop offering a payment link.",
    invalidatedBy: "readiness creating a checkout or contacting the provider",
  },
  stablePaymentLink: {
    gate: "available-while-disabled",
    kind: "read",
    reason:
      "Returns the stable MGM link without contacting the provider; following it reaches ensureCheckout, which refuses.",
    invalidatedBy: "the link starting a checkout other than through ensureCheckout",
  },
  listHistory: {
    gate: "available-while-disabled",
    kind: "read",
    reason:
      "The rollout rule keeps history available, and the payments_disabled message tells the manager it is preserved.",
    invalidatedBy: "the rollout rule or the payments_disabled message no longer promising history",
  },
  refreshPaymentStatus: {
    gate: "available-while-disabled",
    kind: "verification",
    reason:
      "The rollout rule keeps verification available: it asks the provider about an attempt already submitted, with the account version that submitted it, so a payment collected before the plugin was switched off is still recorded.",
    invalidatedBy:
      "the rollout rule no longer keeping verification available, or refresh submitting anything new to the provider",
  },
  handleNotification: {
    gate: "available-while-disabled",
    kind: "verification",
    reason:
      "The rollout rule keeps verification available: it stores and verifies the provider's notice about an attempt already submitted; refusing would drop evidence of a payment the customer has made.",
    invalidatedBy:
      "the rollout rule no longer keeping verification available, or notification handling submitting anything new to the provider",
  },
  reconcile: {
    gate: "available-while-disabled",
    kind: "reconciliation",
    reason:
      "The payments_disabled message promises reconciliation is preserved; it records a manager's resolution of a mismatched payment and never contacts the provider.",
    invalidatedBy:
      "the payments_disabled message no longer promising reconciliation, or reconcile contacting the provider",
  },
} as const satisfies Record<keyof PaymentsCapabilityContract, Gating>;

type Method = keyof typeof GATING;
type Refusing = {
  [M in Method]: (typeof GATING)[M]["gate"] extends "refuses-when-disabled" ? M : never;
}[Method];
type Available = Exclude<Method, Refusing>;

/** Private helpers on the prototype, unreachable through the contract. */
const PRIVATE_HELPERS = [
  "ensureActive",
  "requirePlugins",
  "scopeMismatch",
  "billToDescription",
  "applySnapshot",
  "parseEnvelope",
] as const;

/** Every repository method, so "nothing was written" cannot miss a new one. */
const REPOSITORY_ACCESS = {
  isPaymentsEnabled: "read",
  isPesapalEnabled: "read",
  getLineItemOrganization: "read",
  loadBillSnapshot: "read",
  resolveMerchantAccount: "read",
  loadAttemptAccount: "read",
  commitVerification: "write",
  loadMerchantAccountPublic: "read",
  findActiveAttempt: "read",
  findBlockedAttempt: "read",
  createAttempt: "write",
  updateAttemptTracking: "write",
  markAttemptStatus: "write",
  getAttempt: "read",
  listAttemptsForLineItem: "read",
  recordReceipt: "write",
  listExternalAdjustments: "read",
  listReceiptsForAttempt: "read",
  upsertNotification: "write",
  markNotification: "write",
  // `fn_payment_due_notifications` leases the rows it returns.
  dueNotifications: "write",
  findAttemptByReference: "read",
  findAttemptByTracking: "read",
  applyBillPayment: "write",
  reconcileAttempt: "write",
} as const satisfies Record<keyof PaymentsRepository, "read" | "write">;

type RepositoryMethod = keyof PaymentsRepository;

/** A fake repository that records which methods were called. */
function recordingRepo(overrides: Partial<PaymentsRepository> = {}) {
  const base = baseRepo(overrides);
  const called: RepositoryMethod[] = [];
  const repo = Object.fromEntries(
    (Object.keys(REPOSITORY_ACCESS) as RepositoryMethod[]).map((name) => [
      name,
      (...args: unknown[]) => {
        called.push(name);
        return (base[name] as (...args: unknown[]) => unknown)(...args);
      },
    ])
  ) as unknown as PaymentsRepository;
  const writes = () =>
    [...new Set(called.filter((name) => REPOSITORY_ACCESS[name] === "write"))].sort();
  return { repo, writes };
}

type ProviderOperation = Exclude<keyof PaymentProviderClient, "provider">;

/** Every provider operation, so "which operations ran" cannot miss a new one. */
const PROVIDER_OPERATIONS = {
  testConnection: true,
  createCheckout: true,
  getTransaction: true,
  parseNotification: true,
} as const satisfies Record<ProviderOperation, true>;

/** Wraps a provider factory so the operations its providers perform are recorded. */
function recordingProviders(factory: ProviderFactory) {
  const called: ProviderOperation[] = [];
  const forAccount = vi.fn<ProviderFactory["forAccount"]>(async (account) => {
    const result = await factory.forAccount(account);
    if (!result.ok) return result;
    const client = result.provider;
    const recorded = Object.fromEntries(
      (Object.keys(PROVIDER_OPERATIONS) as ProviderOperation[]).map((name) => [
        name,
        (...args: unknown[]) => {
          called.push(name);
          return (client[name] as (...args: unknown[]) => unknown)(...args);
        },
      ])
    );
    return { ...result, provider: { ...client, ...recorded } };
  });
  const operations = () => [...new Set(called)].sort();
  return { factory: { forAccount }, forAccount, operations };
}

/** How one plugin's state read answers. */
type Read = "on" | "off" | Failure;
type Failure = "network-failure" | "database-error";
type Reads = Partial<Record<"payments" | "pesapal", Read>>;

const FAILURES = {
  "network-failure": "a network failure",
  "database-error": "a database error",
} as const satisfies Record<Failure, string>;

const FAILURE_CASES = (Object.keys(FAILURES) as Failure[]).map((read) => ({ read, failure: FAILURES[read] }));

/** A supabase-js client whose plugin-state reads answer as `reads` says; unlisted plugins are on. */
function stateClient(reads: Reads): SupabaseClient {
  return createClient("http://supabase.test", "anon-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const { _plugin_name } = JSON.parse(String(init?.body)) as { _plugin_name: keyof Reads };
        const read = reads[_plugin_name] ?? "on";
        if (read === "network-failure") throw new TypeError("fetch failed");
        const failed = read === "database-error";
        const body = failed ? { code: "XX000", message: "plugin state unavailable", details: null, hint: null } : read === "on";
        return new Response(JSON.stringify(body), {
          status: failed ? 500 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
}

/** The Supabase repository's plugin-state reads over `client` (the module is mocked above for the composers). */
async function supabaseState(
  client: SupabaseClient
): Promise<Pick<PaymentsRepository, "isPaymentsEnabled" | "isPesapalEnabled">> {
  const { createSupabasePaymentsRepository } = await vi.importActual<
    typeof import("@/lib/payments/infrastructure/supabase-repository")
  >("@/lib/payments/infrastructure/supabase-repository");
  const { isPaymentsEnabled, isPesapalEnabled } = createSupabasePaymentsRepository(client);
  return { isPaymentsEnabled, isPesapalEnabled };
}

function capability(repo: PaymentsRepository, providers: ProviderFactory) {
  return new PaymentsCapability(repo, scope(), providers, () => true, (p) => p);
}

type Call = (capability: PaymentsCapability) => Promise<PaymentsResult<unknown>>;

/** A call each refusing method completes when both plugins are on. */
const REFUSING_CALLS: Record<Refusing, Call> = {
  ensureCheckout: (cap) => cap.ensureCheckout(LINE_ITEM),
};

type Refusal = {
  when: string;
  plugin: "payments" | "pesapal";
  read: Exclude<Read, "on">;
  status: 409 | 503;
  code: string;
};

const REFUSALS: Refusal[] = [
  { when: "Payments is off", plugin: "payments", read: "off", status: 409, code: "payments_disabled" },
  { when: "Pesapal is off", plugin: "pesapal", read: "off", status: 409, code: "pesapal_disabled" },
  ...(["payments", "pesapal"] as const).flatMap((plugin) =>
    FAILURE_CASES.map(({ read, failure }) => ({
      when: `reading the ${plugin} state meets ${failure}`,
      plugin,
      read,
      status: 503 as const,
      code: "payments_gate_unavailable",
    }))
  ),
];

/**
 * The gate decision a refusal must equal. A 409 is the gate's answer for the
 * plugin that is off; either unreadable read is worded as the Payments
 * gate's, since Payments is the plugin the capability belongs to.
 */
function gateDecision({ plugin, read, status }: Refusal) {
  const gated = status === 409 ? plugin : "payments";
  return new MgmGate(catalog).check(stateClient({ [gated]: read }), {
    plugin: gated,
    target: { kind: "organization", id: ORG },
    method: "POST",
  });
}

type Work = { provider: ProviderOperation[]; writes: RepositoryMethod[] };

/** A call each available method completes, and the work it does. */
const AVAILABLE_CALLS: Record<
  Available,
  {
    repo?: Partial<PaymentsRepository>;
    call: Call;
    does: Work;
    result?: object;
  }
> = {
  getReadiness: {
    call: (cap) => cap.getReadiness(COMMUNITY),
    does: { provider: [], writes: [] },
    result: { data: { state: "disabled" } },
  },
  stablePaymentLink: {
    call: (cap) => cap.stablePaymentLink(LINE_ITEM),
    does: { provider: [], writes: [] },
  },
  listHistory: {
    call: (cap) => cap.listHistory(LINE_ITEM),
    does: { provider: [], writes: [] },
  },
  refreshPaymentStatus: {
    repo: { getAttempt: async () => attempt() },
    call: (cap) => cap.refreshPaymentStatus(ATTEMPT),
    does: { provider: ["getTransaction"], writes: ["commitVerification"] },
  },
  handleNotification: {
    repo: {
      findAttemptByReference: async () => attempt(),
      getAttempt: async () => attempt("verified"),
    },
    call: (cap) =>
      cap.handleNotification({ OrderTrackingId: "TRACK-1", OrderMerchantReference: "MGM-test" }),
    does: { provider: ["getTransaction"], writes: ["commitVerification", "markNotification", "upsertNotification"] },
    result: { data: { processed: true } },
  },
  reconcile: {
    repo: { getAttempt: async () => attempt("needs_reconciliation") },
    call: (cap) => cap.reconcile(ATTEMPT, { action: "accept_exact" }),
    does: { provider: [], writes: ["reconcileAttempt"] },
  },
};

const DISABLED = [
  { when: "Payments is off", reads: { payments: "off" } },
  { when: "Pesapal is off", reads: { pesapal: "off" } },
  { when: "both are off", reads: { payments: "off", pesapal: "off" } },
] satisfies { when: string; reads: Reads }[];

const catalog: MgmCatalog = {
  plugins: MGM_BUNDLED_PLUGINS,
  get: (name) => getBundledPlugin(name),
  isCore: (name) => getBundledPlugin(name)?.core ?? false,
};

describe("Payments capability classification", () => {
  it("classifies every public method of the capability", () => {
    expectTypeOf<keyof PaymentsCapability>().toEqualTypeOf<keyof PaymentsCapabilityContract>();
    expectTypeOf<
      Extract<(typeof PRIVATE_HELPERS)[number], keyof PaymentsCapability>
    >().toBeNever();

    const helpers: readonly string[] = PRIVATE_HELPERS;
    const onPrototype = Object.getOwnPropertyNames(PaymentsCapability.prototype).filter(
      (name) => name !== "constructor"
    );
    expect(onPrototype.filter((name) => !helpers.includes(name)).sort()).toEqual(
      Object.keys(GATING).sort()
    );
    expect(helpers.filter((name) => !onPrototype.includes(name)), "Stale PRIVATE_HELPERS entry").toEqual([]);
  });

  it("gives every available method a reason and what would invalidate it", () => {
    for (const gating of Object.values(GATING)) {
      if (gating.gate !== "available-while-disabled") continue;
      expect(gating.reason.trim()).not.toBe("");
      expect(gating.invalidatedBy.trim()).not.toBe("");
    }
  });

  it("rests on rules that still hold", async () => {
    const rollout = readFileSync(path.join(REPO_ROOT, "docs", "payments-rollout.md"), "utf8");
    expect(rollout, "docs/payments-rollout.md changed: review GATING").toContain(ROLLOUT_RULE);

    const { repo } = recordingRepo({ isPaymentsEnabled: async () => false });
    const refused = await capability(repo, verifiedProvider().factory).ensureCheckout(LINE_ITEM);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message, "The payments_disabled message changed: review GATING").toContain(
        DISABLED_PROMISE
      );
    }
  });
});

describe.each([
  ["payments", "isPaymentsEnabled"],
  ["pesapal", "isPesapalEnabled"],
] as const)("the Supabase repository's %s state read", (plugin, method) => {
  const read = async (reads: Reads) => (await supabaseState(stateClient(reads)))[method](ORG);

  it("answers whether the plugin is on", async () => {
    await expect(read({})).resolves.toBe(true);
    await expect(read({ [plugin]: "off" })).resolves.toBe(false);
  });

  // requirePlugins turns the rejection into its 503. Read as `false`, a
  // failure would answer 409 and tell the manager to enable the plugin.
  it.each(FAILURE_CASES)("rejects when it meets $failure", async ({ read: failing }) => {
    await expect(read({ [plugin]: failing })).rejects.toThrow();
  });
});

describe.each(Object.keys(REFUSING_CALLS) as Refusing[])("%s refuses while disabled", (method) => {
  it("completes when both plugins are on", async () => {
    const { repo, writes } = recordingRepo(await supabaseState(stateClient({})));
    const provider = verifiedProvider();
    const result = await REFUSING_CALLS[method](capability(repo, provider.factory));
    expect(result.ok).toBe(true);
    expect(provider.forAccount.mock.calls.length > 0 || writes().length > 0).toBe(true);
  });

  it.each(REFUSALS)(
    "answers $status $code when $when, as the plugin gate does, before obtaining a provider or writing",
    async (refusal) => {
      const { repo, writes } = recordingRepo(
        await supabaseState(stateClient({ [refusal.plugin]: refusal.read }))
      );
      const provider = verifiedProvider();
      const result = await REFUSING_CALLS[method](capability(repo, provider.factory));
      expect(result).toMatchObject({ ok: false, status: refusal.status, code: refusal.code });
      expect(result, "Word the refusal as the plugin gate does").toEqual(await gateDecision(refusal));
      expect(provider.forAccount).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    }
  );
});

describe.each(Object.keys(AVAILABLE_CALLS) as Available[])("%s stays available while disabled", (method) => {
  const scenario = AVAILABLE_CALLS[method];
  const gating = GATING[method];

  it("does what its classification says", () => {
    // A read neither contacts the provider nor writes; verification only asks
    // the provider about an attempt already submitted; reconciliation only writes.
    if (gating.kind === "read") expect(scenario.does).toEqual({ provider: [], writes: [] });
    if (gating.kind === "verification") expect(scenario.does.provider).toEqual(["getTransaction"]);
    if (gating.kind === "reconciliation") expect(scenario.does.provider).toEqual([]);
    if (gating.kind !== "read") expect(scenario.does).not.toEqual({ provider: [], writes: [] });
  });

  it.each(DISABLED)("completes when $when", async ({ reads }) => {
    const { repo, writes } = recordingRepo({ ...scenario.repo, ...(await supabaseState(stateClient(reads))) });
    const provider = recordingProviders(verifiedProvider().factory);
    const result = await scenario.call(capability(repo, provider.factory));
    expect(result).toMatchObject({ ok: true, ...scenario.result });
    expect(provider.forAccount.mock.calls.length > 0).toBe(scenario.does.provider.length > 0);
    expect(provider.operations()).toEqual([...scenario.does.provider].sort());
    expect(writes()).toEqual([...scenario.does.writes].sort());
  });

  // Failing to read plugin state cannot stop these either; readiness
  // reports it as disabled, so no payment link is offered.
  it.each(FAILURE_CASES)("completes when reading plugin state meets $failure", async ({ read }) => {
    const { repo, writes } = recordingRepo({
      ...scenario.repo,
      ...(await supabaseState(stateClient({ payments: read, pesapal: read }))),
    });
    const provider = recordingProviders(verifiedProvider().factory);
    const result = await scenario.call(capability(repo, provider.factory));
    expect(result).toMatchObject({ ok: true, ...scenario.result });
    expect(provider.operations()).toEqual([...scenario.does.provider].sort());
    expect(writes()).toEqual([...scenario.does.writes].sort());
  });
});

/**
 * The same refusal through the real composers on the shared runtime.
 * `composePayments` opens its scope before any plugin check, because reads
 * stay available while Payments is off; what must not happen is a provider
 * call or a write, and the scope must hand back everything it registered.
 */
describe.each([
  ["composePayments", composePayments],
  ["composePaymentsPublic", composePaymentsPublic],
] as const)("%s on the shared runtime", (_name, compose) => {
  afterEach(async () => {
    composed.repository = null;
    await resetMgmRuntimeForTests();
  });

  /**
   * Composes for a signed-in request whose plugin-state reads answer as
   * `reads` says, and starts a checkout. The repository reads plugin state
   * over the request's own client.
   */
  async function checkout(reads: Reads, overrides: Partial<PaymentsRepository> = {}) {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    const forAccount = vi.spyOn(runtime.paymentProviders, "forAccount");
    const state = stateClient(reads);
    const supabase = {
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      rpc: state.rpc.bind(state),
    } as unknown as SupabaseClient;
    const { repo, writes } = recordingRepo({ ...overrides, ...(await supabaseState(supabase)) });
    composed.repository = repo;
    const opened = await compose({ supabase, organizationId: ORG });
    if (!opened.ok) throw new Error(opened.message);
    try {
      return {
        result: await opened.data.payments.ensureCheckout(LINE_ITEM),
        forAccount,
        writes,
        registrySizeBefore: before,
        runtime,
      };
    } finally {
      await opened.data.dispose();
    }
  }

  it("reaches the root provider registry when both plugins are on", async () => {
    // An account without a registered notification URL stops at the
    // provider factory, so nothing leaves the process.
    const { result, forAccount } = await checkout(
      {},
      {
        resolveMerchantAccount: async (input) => {
          const resolved = await baseRepo().resolveMerchantAccount(input);
          return resolved.ok ? { ...resolved, account: { ...resolved.account, ipn_id: null } } : resolved;
        },
      }
    );
    expect(forAccount).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: "payments_ipn_not_registered" });
  });

  it.each(FAILURE_CASES)(
    "answers 503 when reading plugin state meets $failure, without a provider or a write",
    async ({ read }) => {
      const { result, forAccount, writes, registrySizeBefore, runtime } = await checkout({ payments: read });
      expect(result).toMatchObject({ ok: false, status: 503, code: "payments_gate_unavailable" });
      expect(forAccount).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
      expect(runtime.root.registry.size).toBe(registrySizeBefore);
    }
  );
});

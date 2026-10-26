/**
 * Which Payments capability methods refuse while a plugin is off.
 *
 * `composePayments` and `composePaymentsPublic` open their scope whatever
 * the plugin state, because history and verification stay available while
 * Payments is off. Each payment write route is therefore a
 * `PaymentExemption` in the route-surface test, naming the one method it
 * calls, and that method must be classified available-while-disabled here
 * (route-surface reads the `gate` field of `GATING` below). That is sound
 * only while each capability method makes the decision itself, so every
 * method is classified here and the classification is tested, not only
 * declared:
 *
 * - refuses-when-disabled: 409 `payments_disabled` / `pesapal_disabled`, or
 *   503 `payments_gate_unavailable` when plugin state cannot be read, before
 *   a provider is obtained or anything is written;
 * - available-while-disabled: does its work with the plugins off, for the
 *   reason written beside it, and takes only the repository writes and
 *   provider steps listed beside it (`reaches`), never a step of a new
 *   checkout. The runs below cover one path per method; the lists are also
 *   checked against what each method can reach on any path, read off
 *   capability.ts. That reach does not follow a call into a refusing
 *   method, so each refusing method is also read off the source to run its
 *   plugin check ahead of any write, provider step or `ok: true` answer,
 *   whatever it is passed.
 *
 * A method added to `PaymentsCapabilityContract` fails the type check until
 * it is classified; a public method outside the contract fails the type
 * check and the prototype test. `payments-route-boundary.test.ts` covers the
 * other half: nothing a request runs reaches a provider, or writes payment
 * records, except through the capability, and a route Payments or Pesapal
 * owns that composes the capability has no other side effects, apart from
 * the exceptions that test lists with their reasons (`ALLOWED_IMPORTS`,
 * `ALLOWED_DIRECT_ACCESS`, `ROUTE_PACKAGES`, among them the webhook's and
 * worker's notification queue).
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
import ts from "typescript";
import { MGM_BUNDLED_PLUGINS, getBundledPlugin } from "@/lib/plugins/bundled";
import { MgmGate } from "@/lib/runtime/gate";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import type { MgmCatalog } from "@/lib/runtime/services";
import { PaymentsCapability } from "../capability";
import { composePayments, composePaymentsPublic } from "../compose";
import type { PaymentProviderClient } from "../providers/types";
import type {
  MerchantAccountPublic,
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
const CAPABILITY_FILE = path.resolve(__dirname, "..", "capability.ts");

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
      /** Every repository write and provider step it may take, on any path. */
      reaches: Reach;
    };

const GATING = {
  ensureCheckout: { gate: "refuses-when-disabled" },
  getReadiness: {
    gate: "available-while-disabled",
    kind: "read",
    reason:
      "Reports the plugins as disabled, which is how invoices and the billing page stop offering a payment link.",
    invalidatedBy: "readiness creating a checkout or contacting the provider",
    reaches: { writes: [], provider: [] },
  },
  stablePaymentLink: {
    gate: "available-while-disabled",
    kind: "read",
    reason:
      "Returns the stable MGM link without contacting the provider; following it reaches ensureCheckout, which refuses.",
    invalidatedBy: "the link starting a checkout other than through ensureCheckout",
    reaches: { writes: [], provider: [] },
  },
  listHistory: {
    gate: "available-while-disabled",
    kind: "read",
    reason:
      "The rollout rule keeps history available, and the payments_disabled message tells the manager it is preserved.",
    invalidatedBy: "the rollout rule or the payments_disabled message no longer promising history",
    reaches: { writes: [], provider: [] },
  },
  refreshPaymentStatus: {
    gate: "available-while-disabled",
    kind: "verification",
    reason:
      "The rollout rule keeps verification available: it asks the provider about an attempt already submitted, with the account version that submitted it, so a payment collected before the plugin was switched off is still recorded.",
    invalidatedBy:
      "the rollout rule no longer keeping verification available, or refresh submitting anything new to the provider",
    // The verification it applies, or "confirmation pending" while the
    // provider has no outcome yet.
    reaches: {
      writes: ["commitVerification", "markAttemptStatus"],
      provider: ["forAccount", "getTransaction"],
    },
  },
  handleNotification: {
    gate: "available-while-disabled",
    kind: "verification",
    reason:
      "The rollout rule keeps verification available: it stores and verifies the provider's notice about an attempt already submitted; refusing would drop evidence of a payment the customer has made.",
    invalidatedBy:
      "the rollout rule no longer keeping verification available, or notification handling submitting anything new to the provider",
    // The notification inbox, binding a tracking id the provider has just
    // confirmed to its attempt, and the verification it applies.
    reaches: {
      writes: [
        "commitVerification",
        "markAttemptStatus",
        "markNotification",
        "updateAttemptTracking",
        "upsertNotification",
      ],
      provider: ["forAccount", "getTransaction"],
    },
  },
  reconcile: {
    gate: "available-while-disabled",
    kind: "reconciliation",
    reason:
      "The payments_disabled message promises reconciliation is preserved; it records a manager's resolution of a mismatched payment and never contacts the provider.",
    invalidatedBy:
      "the payments_disabled message no longer promising reconciliation, or reconcile contacting the provider",
    reaches: { writes: ["reconcileAttempt"], provider: [] },
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

/** A step toward a provider: obtaining a client for an account, or an operation on it. */
type ProviderStep = keyof ProviderFactory | ProviderOperation;

const PROVIDER_STEPS = {
  forAccount: true,
  ...PROVIDER_OPERATIONS,
} as const satisfies Record<ProviderStep, true>;

/** Repository writes and provider steps, by name. */
type Reach = { writes: readonly RepositoryMethod[]; provider: readonly ProviderStep[] };

/**
 * What a new checkout takes: recording an attempt, then asking the provider
 * for a checkout page. A method that stays available while disabled may
 * list neither in `reaches`.
 */
const NEW_CHECKOUT: Reach = { writes: ["createAttempt"], provider: ["createCheckout"] };

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

/**
 * A repository state from which a refusing method, with both plugins on,
 * completes without obtaining a provider or writing. Only the plugin check
 * can refuse there, so refusing from it pins that check above the branch.
 */
type Shortcut = { state: string; repo: Partial<PaymentsRepository> };

/**
 * ensureCheckout hands back a pending checkout for an unchanged bill. With
 * the plugin check below this branch, a disabled organization's customer
 * would still be sent to a live checkout.
 */
const REUSE: Shortcut = {
  state: "a checkout it could reuse exists",
  repo: {
    listAttemptsForLineItem: async () => [attempt()],
    findActiveAttempt: async () => attempt(),
  },
};

type Refusal = {
  when: string;
  plugin: "payments" | "pesapal";
  read: Exclude<Read, "on">;
  status: 409 | 503;
  code: string;
  from?: Shortcut;
};

const REFUSALS: Refusal[] = [
  { when: "Payments is off", plugin: "payments", read: "off", status: 409, code: "payments_disabled" },
  {
    when: `Payments is off and ${REUSE.state}`,
    plugin: "payments",
    read: "off",
    status: 409,
    code: "payments_disabled",
    from: REUSE,
  },
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

/** A sandbox merchant account that has passed its connection test. */
const READY_ACCOUNT: MerchantAccountPublic = {
  id: "acc-1",
  org_id: ORG,
  provider: "pesapal",
  display_name: "Default Pesapal account",
  sandbox: true,
  consumer_key: "key",
  base_url: "https://cybqa.pesapal.com/pesapalv3",
  ipn_id: "ipn-1",
  ipn_url: null,
  version: 1,
  disabled: false,
  last_tested_at: null,
  last_test_status: "success",
  last_test_message: null,
  origin: "org_default",
  community_id: null,
};

/**
 * A call each available method completes, and the work it does: `result`
 * while disabled or unreadable, `resultWhenOn` with both plugins on when
 * that differs.
 */
const AVAILABLE_CALLS: Record<
  Available,
  {
    repo?: Partial<PaymentsRepository>;
    call: Call;
    does: Work;
    result?: object;
    resultWhenOn?: object;
  }
> = {
  getReadiness: {
    // An account is loaded on every run, so a provider step readiness takes
    // for it, before or after the plugin check, shows up in these runs.
    repo: {
      loadMerchantAccountPublic: async () => ({ ok: true, account: READY_ACCOUNT, hasOverride: false }),
    },
    call: (cap) => cap.getReadiness(COMMUNITY),
    does: { provider: [], writes: [] },
    result: { data: { state: "disabled" } },
    resultWhenOn: { data: { state: "sandbox" } },
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

/** What a method can reach on any path, as read off the source. */
type Reached = {
  writes: Set<string>;
  provider: Set<string>;
  /** Where it hands on `this`, `this.repo` or `this.providers` as a value. */
  escapes: Set<string>;
  /** Where it builds an `ok: true` result. */
  succeeds: Set<string>;
};

const has = (record: object, name: string) => Object.prototype.hasOwnProperty.call(record, name);
const isWrite = (name: string) =>
  has(REPOSITORY_ACCESS, name) && REPOSITORY_ACCESS[name as RepositoryMethod] === "write";
const sorted = (values: Iterable<string>) => [...values].sort();

/**
 * What each PaymentsCapability method can reach on any path, read off its
 * source: every repository write and provider step it names (called,
 * aliased, destructured or spelled as a string key), plus those of the class
 * methods it names through `this.<method>`, transitively. Matching names
 * rather than calls over-approximates, the safe direction for an allow-list.
 *
 * The walk does not enter a method named in `refusing`. Those check plugin
 * state themselves, and handing on to one (a retry through ensureCheckout,
 * say) is safe only while that check runs ahead of any write, provider step
 * or `ok: true` answer (a checkout handed back for reuse, say), whatever the
 * method is passed. `beforeCheck` gives what each method reaches ahead of
 * the statements `const gated = await this.requirePlugins(); if (gated)
 * return gated;` at the top level of its body, or null when its body has no
 * such pair, and the test below holds every refusing method to reaching
 * nothing there. Whether requirePlugins refuses at all is for the refusal
 * runs below. A refusing method's own reach still covers its whole body.
 *
 * Names cannot follow `this`, `this.repo` or `this.providers` handed on as a
 * value, so each such place is reported as an escape. Code outside the
 * class's methods (module helpers, property initializers, accessors) is
 * reported in `outside` when it names a repository write or a provider step,
 * since no method's reach would include it. Imported modules are not read;
 * the runs below still record a provider step they take on the path
 * exercised.
 */
function staticReach(
  source: string,
  refusing: ReadonlySet<string>
): { reach: Map<string, Reached>; beforeCheck: Map<string, Reached | null>; outside: string[] } {
  const file = ts.createSourceFile("capability.ts", source, ts.ScriptTarget.Latest, true);
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const owner = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === "PaymentsCapability"
  );
  if (!owner) throw new Error("PaymentsCapability is not declared in capability.ts");

  const methods = new Map<string, ts.MethodDeclaration>();
  for (const member of owner.members) {
    if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
      methods.set(member.name.text, member);
    }
  }

  type Facts = { names: Set<string>; helpers: Set<string>; escapes: Set<string>; succeeds: Set<string> };
  const collect = (nodes: readonly ts.Node[]): Facts => {
    const facts: Facts = { names: new Set(), helpers: new Set(), escapes: new Set(), succeeds: new Set() };
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
        facts.names.add(node.text);
      }
      const ok = ts.isPropertyAssignment(node) && node.name.getText(file) === "ok" ? node.initializer : undefined;
      if (ok && /^true\b/.test(ok.getText(file))) facts.succeeds.add(`ok: true at line ${line(node)}`);
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          const member = parent.name.text;
          if (methods.has(member)) facts.helpers.add(member);
          if (member === "repo" || member === "providers") {
            const use = parent.parent;
            if (!(ts.isPropertyAccessExpression(use) && use.expression === parent)) {
              facts.escapes.add(`this.${member} handed on at line ${line(parent)}`);
            }
          }
        } else {
          facts.escapes.add(`this handed on at line ${line(node)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    nodes.forEach(visit);
    return facts;
  };
  const direct = new Map([...methods].map(([name, method]) => [name, collect([method.body as ts.Block])]));

  /** What `facts`, found in `start`, reach, with the class methods they name, short of those in `stop`. */
  const close = (start: string, facts: Facts, stop: ReadonlySet<string>): Reached => {
    const found: Reached = { writes: new Set(), provider: new Set(), escapes: new Set(), succeeds: new Set() };
    const seen = new Set([start]);
    const queue: [string, Facts][] = [[start, facts]];
    while (queue.length) {
      const [at, next] = queue.shift() as [string, Facts];
      for (const named of next.names) {
        if (isWrite(named)) found.writes.add(named);
        if (has(PROVIDER_STEPS, named)) found.provider.add(named);
      }
      for (const escape of next.escapes) found.escapes.add(`${at}: ${escape}`);
      for (const success of next.succeeds) found.succeeds.add(`${at}: ${success}`);
      for (const helper of next.helpers) {
        if (stop.has(helper) || seen.has(helper)) continue;
        seen.add(helper);
        queue.push([helper, direct.get(helper) as Facts]);
      }
    }
    return found;
  };

  const reach = new Map<string, Reached>();
  const beforeCheck = new Map<string, Reached | null>();
  const text = (node: ts.Node) => node.getText(file).replace(/\s+/g, " ");
  for (const [name, method] of methods) {
    reach.set(name, close(name, direct.get(name) as Facts, refusing));
    const statements = (method.body as ts.Block).statements;
    const check = statements.findIndex((statement, i) => {
      const gated = /^const (\w+) = await this\.requirePlugins\(\);$/.exec(text(statement))?.[1];
      const then = statements[i + 1];
      return gated !== undefined && then !== undefined && text(then) === `if (${gated}) return ${gated};`;
    });
    // Nothing is excused ahead of the check, not even another refusing method.
    beforeCheck.set(name, check < 0 ? null : close(name, collect(statements.slice(0, check)), new Set()));
  }

  const outside = new Set<string>();
  const visitOutside = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.parent === owner && methods.get(node.name.getText(file)) === node) {
      return;
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
      if (isWrite(node.text) || has(PROVIDER_STEPS, node.text)) outside.add(`${node.text} at line ${line(node)}`);
    }
    ts.forEachChild(node, visitOutside);
  };
  visitOutside(file);

  return { reach, beforeCheck, outside: [...outside] };
}

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

  it("lets no method that stays available while disabled start a new checkout", () => {
    for (const [method, gating] of Object.entries(GATING) as [Method, Gating][]) {
      if (gating.gate !== "available-while-disabled") continue;
      expect(
        [
          ...gating.reaches.writes.filter((write) => NEW_CHECKOUT.writes.includes(write)),
          ...gating.reaches.provider.filter((step) => NEW_CHECKOUT.provider.includes(step)),
        ],
        `${method} stays available while Payments is off, so it may not record an attempt or open a provider checkout`
      ).toEqual([]);
    }
  });

  // NEW_CHECKOUT is what the check above and the any-path reach below look
  // for, so it must name every step a new checkout takes beyond those the
  // available methods list for their own work.
  it("names every step of a new checkout that no available method lists", async () => {
    const { repo, writes } = recordingRepo(await supabaseState(stateClient({})));
    const provider = recordingProviders(verifiedProvider().factory);
    const result = await REFUSING_CALLS.ensureCheckout(capability(repo, provider.factory));
    expect(result).toMatchObject({ ok: true, data: { reused: false } });
    const listed = new Set<string>(
      (Object.values(GATING) as Gating[]).flatMap((gating) =>
        gating.gate === "available-while-disabled" ? [...gating.reaches.writes, ...gating.reaches.provider] : []
      )
    );
    const obtained = provider.forAccount.mock.calls.length > 0 ? ["forAccount"] : [];
    const taken = [...writes(), ...obtained, ...provider.operations()];
    expect(sorted(taken.filter((step) => !listed.has(step))), "Update NEW_CHECKOUT").toEqual(
      sorted([...NEW_CHECKOUT.writes, ...NEW_CHECKOUT.provider])
    );
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

describe("What each method can reach on any path through capability.ts", () => {
  const refusing = new Set<string>(
    (Object.keys(GATING) as Method[]).filter((method) => GATING[method].gate === "refuses-when-disabled")
  );
  const { reach, beforeCheck, outside } = staticReach(readFileSync(CAPABILITY_FILE, "utf8"), refusing);
  const reached = (method: string) => reach.get(method) as Reached;

  it("reads every method of the capability out of the source", () => {
    expect(sorted(reach.keys())).toEqual(sorted([...Object.keys(GATING), ...PRIVATE_HELPERS]));
  });

  // The walk stops at these methods, so none may write or reach a provider
  // ahead of its plugin check, nor run that check only for some arguments.
  it.each([...refusing])(
    "%s checks plugin state before any write, provider step or success, whatever it is passed",
    (method) => {
      const before = beforeCheck.get(method);
      expect(
        before,
        "Run `const gated = await this.requirePlugins(); if (gated) return gated;` at the top level of the body"
      ).not.toBeNull();
      if (!before) return;
      expect(sorted(before.writes), "Move the write below the plugin check").toEqual([]);
      expect(sorted(before.provider), "Move the provider step below the plugin check").toEqual([]);
      expect(sorted(before.escapes), "Hand on this, this.repo or this.providers below the plugin check").toEqual([]);
      expect(sorted(before.succeeds), "Answer ok: true only below the plugin check").toEqual([]);
    }
  );

  it("finds repository writes and provider steps only inside the capability's methods", () => {
    expect(outside, "Move it into a method, where the lists in GATING can see it").toEqual([]);
  });

  it("starts a new checkout only from a method that refuses while disabled", () => {
    const steps: readonly string[] = [...NEW_CHECKOUT.writes, ...NEW_CHECKOUT.provider];
    const takes = (method: string) => [...reached(method).writes, ...reached(method).provider];
    const starters = Object.keys(GATING).filter((method) => takes(method).some((step) => steps.includes(step)));
    expect(starters.filter((method) => !refusing.has(method))).toEqual([]);
    // ...and sees every step of the checkout one starts, so this is not vacuous.
    const seen = new Set(starters.flatMap(takes));
    expect(steps.filter((step) => !seen.has(step))).toEqual([]);
  });

  it.each(Object.keys(AVAILABLE_CALLS) as Available[])(
    "%s reaches exactly the writes and provider steps GATING lists for it",
    (method) => {
      const found = reached(method);
      const { reaches } = GATING[method];
      expect(sorted(found.escapes), "Call this.repo and this.providers where their names can be read").toEqual([]);
      expect(sorted(found.writes), "Update its reaches in GATING, or stop the write").toEqual(sorted(reaches.writes));
      expect(sorted(found.provider), "Update its reaches in GATING, or stop the call").toEqual(
        sorted(reaches.provider)
      );
    }
  );

  it("follows aliases, helpers and handed-on handles, and stops at a method that refuses", () => {
    const source = (body: string) => `
      export class PaymentsCapability {
        async ensureCheckout() { await this.repo.createAttempt({}); }
        async refreshPaymentStatus() { ${body} }
        private helper(client: { createCheckout(): void }) { client.createCheckout(); }
      }
    `;
    const probe = (body: string) =>
      staticReach(source(body), new Set(["ensureCheckout"])).reach.get("refreshPaymentStatus") as Reached;
    expect(sorted(probe("await this.repo.createAttempt({});").writes)).toEqual(["createAttempt"]);
    expect(sorted(probe("const { createAttempt } = this.repo;").writes)).toEqual(["createAttempt"]);
    expect(sorted(probe('await this.repo["createAttempt"]({});').writes)).toEqual(["createAttempt"]);
    expect(sorted(probe("this.helper(client);").provider)).toEqual(["createCheckout"]);
    expect(sorted(probe("if (debug) { const f = () => this.providers.forAccount(a); }").provider)).toEqual([
      "forAccount",
    ]);
    expect(probe("const repo = this.repo;").escapes.size).toBe(1);
    expect(probe("const self = this;").escapes.size).toBe(1);
    expect(probe("await use(this.providers);").escapes.size).toBe(1);
    // Handing on to a refusing method is allowed; a write beside it is not,
    // and the refusing method's own reach still covers its body.
    expect(sorted(probe("await this.ensureCheckout(id);").writes)).toEqual([]);
    expect(sorted(probe("await this.ensureCheckout(id); await this.repo.createAttempt({});").writes)).toEqual([
      "createAttempt",
    ]);
    expect(
      sorted((staticReach(source(""), new Set(["ensureCheckout"])).reach.get("ensureCheckout") as Reached).writes)
    ).toEqual(["createAttempt"]);
    expect(
      staticReach(
        `
        const start = (client: { createCheckout(): void }) => client.createCheckout();
        export class PaymentsCapability { async reconcile() { start(c); } }
      `,
        new Set()
      ).outside
    ).toEqual(["createCheckout at line 2"]);
  });

  it("finds the plugin check only where it refuses whatever the method is passed", () => {
    const before = (body: string) =>
      staticReach(
        `
        export class PaymentsCapability {
          async ensureCheckout(id: string, input?: { force?: boolean }) { ${body} }
          private open() { return this.repo.createAttempt({}); }
        }
      `,
        new Set(["ensureCheckout"])
      ).beforeCheck.get("ensureCheckout");
    const check = "const gated = await this.requirePlugins(); if (gated) return gated;";
    const writes = (body: string) => sorted(before(body)?.writes ?? ["no plugin check"]);
    const succeeds = (body: string) => before(body)?.succeeds.size;
    expect(writes(`await this.repo.getLineItemOrganization(id); ${check} await this.open();`)).toEqual([]);
    expect(writes(`await this.repo.createAttempt({}); ${check}`)).toEqual(["createAttempt"]);
    // Ahead of the check, even a helper's write counts.
    expect(writes(`if (input?.force) await this.open(); ${check}`)).toEqual(["createAttempt"]);
    expect(writes(`if (!input?.force) { ${check} } await this.open();`)).toEqual(["no plugin check"]);
    expect(writes("const gated = input?.force ? null : await this.requirePlugins(); if (gated) return gated;")).toEqual(
      ["no plugin check"]
    );
    expect(writes("const gated = await this.requirePlugins(); if (gated && !input?.force) return gated;")).toEqual([
      "no plugin check",
    ]);
    expect(writes("const gated = await this.requirePlugins(input); if (gated) return gated;")).toEqual([
      "no plugin check",
    ]);
    // A checkout handed back ahead of the check is an answer, not a write.
    expect(succeeds(`if (input?.force) return { ok: true as const, data: {} }; ${check}`)).toBe(1);
    expect(succeeds(`if (!id) return { ok: false as const }; ${check} return { ok: true, data: {} };`)).toBe(0);
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

  it.each(REFUSALS.flatMap(({ from }) => (from ? [from] : [])))(
    "completes without obtaining a provider or writing when both plugins are on and $state",
    async ({ repo: state }) => {
      const { repo, writes } = recordingRepo({ ...state, ...(await supabaseState(stateClient({}))) });
      const provider = verifiedProvider();
      const result = await REFUSING_CALLS[method](capability(repo, provider.factory));
      expect(result.ok).toBe(true);
      expect(provider.forAccount).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    }
  );

  it.each(REFUSALS)(
    "answers $status $code when $when, as the plugin gate does, before obtaining a provider or writing",
    async (refusal) => {
      const { repo, writes } = recordingRepo({
        ...refusal.from?.repo,
        ...(await supabaseState(stateClient({ [refusal.plugin]: refusal.read }))),
      });
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
    const reaches: Reach = gating.reaches;
    if (gating.kind === "read") {
      expect(scenario.does).toEqual({ provider: [], writes: [] });
      expect(reaches).toEqual({ provider: [], writes: [] });
    }
    if (gating.kind === "verification") {
      expect(scenario.does.provider).toEqual(["getTransaction"]);
      expect(sorted(reaches.provider)).toEqual(["forAccount", "getTransaction"]);
    }
    if (gating.kind === "reconciliation") {
      expect(scenario.does.provider).toEqual([]);
      expect(reaches.provider).toEqual([]);
    }
    if (gating.kind !== "read") expect(scenario.does).not.toEqual({ provider: [], writes: [] });
    // The path run below is one of the paths `reaches` covers.
    expect(scenario.does.writes.filter((write) => !reaches.writes.includes(write))).toEqual([]);
    expect(scenario.does.provider.filter((step) => !reaches.provider.includes(step))).toEqual([]);
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
    expect(provider.forAccount.mock.calls.length > 0).toBe(scenario.does.provider.length > 0);
    expect(provider.operations()).toEqual([...scenario.does.provider].sort());
    expect(writes()).toEqual([...scenario.does.writes].sort());
  });

  // Turning the plugins on changes no work; readiness reports the account.
  it("does the same work when both plugins are on", async () => {
    const { repo, writes } = recordingRepo({ ...scenario.repo, ...(await supabaseState(stateClient({}))) });
    const provider = recordingProviders(verifiedProvider().factory);
    const result = await scenario.call(capability(repo, provider.factory));
    expect(result).toMatchObject({ ok: true, ...(scenario.resultWhenOn ?? scenario.result) });
    expect(provider.forAccount.mock.calls.length > 0).toBe(scenario.does.provider.length > 0);
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

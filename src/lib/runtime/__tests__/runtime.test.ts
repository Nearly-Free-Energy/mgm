import { afterEach, describe, expect, it, vi } from "vitest";
import * as cordis from "cordis";
import type { Context, Fiber, Plugin } from "cordis";
import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { FIBER_ACTIVE, getMgmRuntime, resetMgmRuntimeForTests } from "../root";
import { openOrganizationScope, REQUEST_SERVICES } from "../scope";
import { PaymentProviderRegistry, type MgmRequest } from "../services";
import "../services";

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: (supabase: unknown) => ({ kind: "openems", supabase }),
}));

const ORG_A = "550e8400-e29b-41d4-a716-44665544000a";
const ORG_B = "550e8400-e29b-41d4-a716-44665544000b";

declare module "cordis" {
  interface Context {
    probe?: { organizationId: string; active(): boolean };
    decoy?: string;
  }
}

// The runtime object behind Cordis's ambient const enum (see FIBER_ACTIVE).
const FiberState = (cordis as unknown as { FiberState: Record<string, number> }).FiberState;

/** Listeners registered on the root's event bus, for leak checks. */
function rootListenerCount(root: Context): number {
  const hooks = (root.events as unknown as { _hooks: Record<string, unknown[]> })._hooks;
  return Object.values(hooks).reduce((total, list) => total + list.length, 0);
}

const ProbePlugin = {
  name: "probe",
  inject: ["mgmRequest"],
  apply(ctx: Context) {
    let active = true;
    ctx.provide("probe", {
      organizationId: ctx.mgmRequest.organizationId,
      active: () => active,
    });
    ctx.effect(() => () => {
      active = false;
    });
  },
} satisfies Plugin.Object<void>;

function request(organizationId: string) {
  return { organizationId, userId: "user-1", roles: [], supabase: { id: organizationId } as never };
}

afterEach(async () => {
  await resetMgmRuntimeForTests();
});

describe("MGM root runtime", () => {
  it("loads the platform plugins once and reuses the root", async () => {
    const runtime = await getMgmRuntime();
    expect(await getMgmRuntime()).toBe(runtime);
    expect(runtime.fibers.map((fiber) => fiber.name)).toEqual([
      "mgm-catalog",
      "mgm-gate",
      "metering-providers",
      "openems-metering",
      "payment-providers",
      "pesapal",
    ]);
    expect(runtime.catalog.plugins).toBe(MGM_BUNDLED_PLUGINS);
    expect(runtime.meteringProviders.names()).toEqual(["openems"]);
    expect(runtime.paymentProviders.names()).toEqual(["pesapal"]);
  });

  it("binds metering factories to the caller's client", async () => {
    const runtime = await getMgmRuntime();
    const supabase = { caller: "a" } as never;
    expect(runtime.meteringProviders.create("openems", supabase)).toEqual({
      kind: "openems",
      supabase,
    });
  });

  it("unregisters providers when the platform plugin unloads", async () => {
    const runtime = await getMgmRuntime();
    const pesapal = runtime.fibers.find((fiber) => fiber.name === "pesapal");
    await pesapal?.dispose();
    expect(runtime.paymentProviders.names()).toEqual([]);
  });

  it("builds a fresh root after reset", async () => {
    const first = await getMgmRuntime();
    await resetMgmRuntimeForTests();
    const second = await getMgmRuntime();
    expect(second).not.toBe(first);
    expect(second.root).not.toBe(first.root);
  });
});

describe("organization request scopes", () => {
  it("isolates concurrent requests and cascades disposal", async () => {
    const [a, b] = await Promise.all([
      openOrganizationScope(request(ORG_A), { isolate: ["probe"] }),
      openOrganizationScope(request(ORG_B), { isolate: ["probe"] }),
    ]);
    await Promise.all([a.load(ProbePlugin), b.load(ProbePlugin)]);

    const probeA = a.ctx.get("probe");
    const probeB = b.ctx.get("probe");
    expect(probeA?.organizationId).toBe(ORG_A);
    expect(probeB?.organizationId).toBe(ORG_B);
    expect(a.ctx.get("mgmRequest")?.organizationId).toBe(ORG_A);

    await a.dispose();
    expect(probeA?.active()).toBe(false);
    expect(probeB?.active()).toBe(true);
    expect(b.ctx.get("probe")?.organizationId).toBe(ORG_B);

    await b.dispose();
    expect(probeB?.active()).toBe(false);
  });

  it("fails loudly when a request service is not isolated", async () => {
    const a = await openOrganizationScope(request(ORG_A));
    const b = await openOrganizationScope(request(ORG_B));
    await a.load(ProbePlugin);
    await expect(b.load(ProbePlugin)).rejects.toThrow('service "probe" has been registered');
    await b.dispose();
    await a.dispose();
  });

  it("leaves no request fibers registered after dispose", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    for (let i = 0; i < 5; i++) {
      const scope = await openOrganizationScope(request(ORG_A), { isolate: ["probe"] });
      await scope.load(ProbePlugin);
      await scope.dispose();
    }
    expect(runtime.root.registry.size).toBe(before);
  });

  it("rejects a plugin whose injected service is missing", async () => {
    const scope = await openOrganizationScope(request(ORG_A));
    const Needy = { name: "needy", inject: ["notProvided"], apply() {} };
    await expect(scope.load(Needy)).rejects.toThrow('Cordis plugin "needy" did not activate');
    await scope.dispose();
  });

  it("unloads everything when a capability load fails and the scope is disposed", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    const scope = await openOrganizationScope(request(ORG_A), { isolate: ["probe", "broken"] });
    const probeFiber = await scope.load(ProbePlugin);
    const probe = scope.ctx.get("probe");

    // Provides a request service, then fails — the composers' failure path.
    let brokenFiber: Fiber | undefined;
    const Broken = {
      name: "broken",
      inject: ["probe"],
      apply(ctx: Context) {
        brokenFiber = ctx.fiber;
        ctx.provide("broken", {});
        throw new Error("capability failed to start");
      },
    };
    await expect(scope.load(Broken)).rejects.toThrow("capability failed to start");

    // Between the rejected load and dispose: the half-provided service is not
    // served, and the capabilities that did start are untouched.
    expect(brokenFiber).toBeDefined();
    expect(brokenFiber?.state).toBe(FiberState.FAILED);
    expect(scope.ctx.get("broken")).toBeUndefined();
    expect(probe?.active()).toBe(true);
    expect(scope.ctx.get("mgmRequest")?.organizationId).toBe(ORG_A);

    await scope.dispose();

    expect(probe?.active()).toBe(false);
    expect(scope.ctx.get("mgmRequest")).toBeUndefined();
    expect(scope.ctx.get("broken")).toBeUndefined();
    expect(runtime.root.registry.size).toBe(before);
    // cordiverse/cordis#133: a failed fiber settles to DISPOSED too (rc.10 left it FAILED).
    expect(brokenFiber?.state).toBe(FiberState.DISPOSED);
    expect(probeFiber.state).toBe(FiberState.DISPOSED);

    // The next request on the same root starts clean.
    const next = await openOrganizationScope(request(ORG_B), { isolate: ["probe"] });
    await next.load(ProbePlugin);
    expect(next.ctx.get("probe")?.organizationId).toBe(ORG_B);
    await next.dispose();
    expect(runtime.root.registry.size).toBe(before);
  });

  it("keeps mgmRequest private across many concurrent scopes", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    const requests = Array.from({ length: 40 }, (_, i) => ({
      ...request(i % 2 ? ORG_A : ORG_B),
      userId: `user-${i}`,
    }));

    // Reads mgmRequest again after yielding. Fixed delays of 0–6 ms by position
    // make the reads resume in a different order from the loads, every run.
    const mismatches: MgmRequest[] = [];
    const delay = new Map<MgmRequest, number>(requests.map((r, i) => [r, (requests.length - i) % 7]));
    const Reader = {
      name: "reader",
      inject: ["mgmRequest"],
      async apply(ctx: Context, expected: MgmRequest) {
        await new Promise((resolve) => setTimeout(resolve, delay.get(expected)));
        if (ctx.mgmRequest !== expected) mismatches.push(expected);
      },
    } satisfies Plugin.Object<MgmRequest>;

    const scopes = await Promise.all(
      requests.map((r) => openOrganizationScope(r, { isolate: ["probe"] }))
    );
    await Promise.all(
      scopes.map((scope) => Promise.all([scope.load(ProbePlugin), scope.load(Reader, scope.request)]))
    );
    expect(mismatches).toEqual([]);

    const check = (live: typeof scopes) => {
      for (const scope of live) {
        expect(scope.ctx.get("mgmRequest")).toBe(scope.request);
        expect(scope.ctx.get("probe")?.organizationId).toBe(scope.request.organizationId);
      }
    };
    check(scopes);

    // Dispose every third scope concurrently; the rest still see only their own request.
    const [gone, kept] = [scopes.filter((_, i) => i % 3 === 0), scopes.filter((_, i) => i % 3 !== 0)];
    await Promise.all(gone.map((scope) => scope.dispose()));
    for (const scope of gone) expect(scope.ctx.get("mgmRequest")).toBeUndefined();
    check(kept);

    await Promise.all(kept.map((scope) => scope.dispose()));
    expect(runtime.root.registry.size).toBe(before);
  });

  it("refuses loads after dispose", async () => {
    const scope = await openOrganizationScope(request(ORG_A));
    await scope.dispose();
    await expect(scope.load(ProbePlugin)).rejects.toThrow("disposed");
  });

  it("isolates every request-level service name", () => {
    expect(new Set(REQUEST_SERVICES).size).toBe(REQUEST_SERVICES.length);
    expect(REQUEST_SERVICES).toContain("mgmRequest");
  });
});

describe("Cordis guarantees the request scopes rely on", () => {
  it("gates on the ACTIVE state Cordis exports", () => {
    // The state assertions below compare against these; a missing key would pass vacuously.
    for (const state of ["ACTIVE", "FAILED", "DISPOSED"]) {
      expect(FiberState[state]).toEqual(expect.any(Number));
    }
    expect(FIBER_ACTIVE).toBe(FiberState.ACTIVE);
  });

  it("does not serve a root service through a name the scope isolates", async () => {
    const runtime = await getMgmRuntime();
    const decoy = await loadRootDecoy(runtime.root);
    try {
      const scope = await openOrganizationScope(request(ORG_A), { isolate: ["decoy"] });
      try {
        expect(scope.ctx.get("decoy")).toBeUndefined();
        const Wants = { name: "wants-decoy", inject: ["decoy"], apply() {} };
        await expect(scope.load(Wants)).rejects.toThrow('Cordis plugin "wants-decoy" did not activate');
        expect(runtime.root.get("decoy")).toBe("SENTINEL");
      } finally {
        await scope.dispose();
      }
    } finally {
      await decoy.dispose();
    }
  });

  async function loadProviderAndDependent(order: string[]) {
    const scope = await openOrganizationScope(request(ORG_A), { isolate: ["shared"] });
    // Effects unwind in reverse, so this one, registered before provide(),
    // records the provider only once its provision has been released.
    const provider = await scope.load({
      name: "provider",
      apply(ctx: Context) {
        ctx.effect(() => () => void order.push("provider"));
        ctx.provide("shared", {});
      },
    });
    await scope.load({
      name: "dependent",
      inject: ["shared"],
      apply(ctx: Context) {
        ctx.effect(() => () => void order.push("dependent"));
      },
    });
    return { scope, provider };
  }

  it("disposes a dependent before the provider it injects", async () => {
    const order: string[] = [];
    const { scope, provider } = await loadProviderAndDependent(order);
    // cordiverse/cordis#196: rc.10 tore the provider down first.
    await provider.dispose();
    expect(order).toEqual(["dependent", "provider"]);
    await scope.dispose();
  });

  it("disposes a dependent before its provider through scope.dispose()", async () => {
    const order: string[] = [];
    const { scope } = await loadProviderAndDependent(order);
    await scope.dispose();
    expect(order).toEqual(["dependent", "provider"]);
  });

  it("removes a request plugin's listeners when the scope is disposed", async () => {
    const runtime = await getMgmRuntime();
    const before = rootListenerCount(runtime.root);
    const scope = await openOrganizationScope(request(ORG_A));
    const listener = await scope.load({
      name: "listener",
      apply(ctx: Context) {
        ctx.on("internal/update", () => {});
        ctx.on("mgm/test-event" as never, (() => {}) as never);
      },
    });
    expect(rootListenerCount(runtime.root)).toBe(before + 1);
    expect(listener._hooks["internal/update"]).toHaveLength(1);

    await scope.dispose();
    expect(rootListenerCount(runtime.root)).toBe(before);
    // cordiverse/cordis#56: rc.10 kept the internal/update hook after dispose.
    expect(listener._hooks["internal/update"]).toHaveLength(0);
  });

  it("disposes a scope once, however many callers ask", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    const scope = await openOrganizationScope(request(ORG_A), { isolate: ["probe"] });
    const fiber = await scope.load(ProbePlugin);
    const probe = scope.ctx.get("probe");

    await Promise.all([scope.dispose(), scope.dispose()]);
    await scope.dispose();

    expect(probe?.active()).toBe(false);
    expect(fiber.state).toBe(FiberState.DISPOSED);
    expect(runtime.root.registry.size).toBe(before);
  });
});

async function loadRootDecoy(root: Context): Promise<Fiber> {
  const fiber = root.plugin({
    name: "decoy",
    apply(ctx: Context) {
      ctx.provide("decoy", "SENTINEL");
    },
  });
  await fiber;
  return fiber;
}

describe("PaymentProviderRegistry", () => {
  it("returns payments_unknown_provider for an unregistered provider", async () => {
    const registry = new PaymentProviderRegistry();
    await expect(
      registry.forAccount({ provider: "pesapal" } as never)
    ).resolves.toMatchObject({ ok: false, code: "payments_unknown_provider" });
  });

  it("rejects duplicate registration", () => {
    const registry = new PaymentProviderRegistry();
    const factory = { forAccount: vi.fn() };
    registry.register("pesapal", factory);
    expect(() => registry.register("pesapal", factory)).toThrow("already registered");
  });
});

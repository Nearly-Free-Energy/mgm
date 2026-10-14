import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Plugin } from "cordis";
import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { getMgmRuntime, resetMgmRuntimeForTests } from "../root";
import { openOrganizationScope, REQUEST_SERVICES } from "../scope";
import { PaymentProviderRegistry } from "../services";
import "../services";

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: (supabase: unknown) => ({ kind: "openems", supabase }),
}));

const ORG_A = "550e8400-e29b-41d4-a716-44665544000a";
const ORG_B = "550e8400-e29b-41d4-a716-44665544000b";

declare module "cordis" {
  interface Context {
    probe?: { organizationId: string; active(): boolean };
  }
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

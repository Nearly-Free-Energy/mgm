import { expect, it, vi } from "vitest";
import { MeteringError } from "@/lib/metering/errors";
import { MeteringProviderFactories } from "../services";

const request = { microgridId: "grid-a", devices: [], startDate: "2026-09-01", endDate: "2026-09-30", timezone: "Africa/Kampala" };

it("routes configured microgrids to a new provider without consumer changes", async () => {
  const registry = new MeteringProviderFactories();
  const legacy = vi.fn(async () => []);
  const alternate = vi.fn(async () => []);
  const client = { organization: "a" } as never;
  registry.register("openems", () => ({ getReadings: legacy }), { fallback: true });
  const supports = vi.fn(async (_client, id) => id === "grid-a");
  const factory = vi.fn(() => ({ getReadings: alternate }));
  const unregister = registry.register("another-vendor", factory, { supports });
  const provider = registry.forRequest(client);
  await provider.getReadings(request);
  expect(supports).toHaveBeenCalledWith(client, "grid-a");
  expect(factory).toHaveBeenCalledWith(client);
  expect(alternate).toHaveBeenCalledWith(request);
  expect(legacy).not.toHaveBeenCalled();
  await provider.getReadings({ ...request, microgridId: "grid-b" });
  expect(legacy).toHaveBeenCalledTimes(1);
  unregister();
  await provider.getReadings(request);
  expect(legacy).toHaveBeenCalledTimes(2);
});

it("fails closed on ambiguous selection or configuration lookup failure", async () => {
  const registry = new MeteringProviderFactories();
  const read = vi.fn(async () => []);
  registry.register("legacy", () => ({ getReadings: read }), { fallback: true });
  registry.register("one", () => ({ getReadings: read }));
  const unregister = registry.register("two", () => ({ getReadings: read }));
  await expect(registry.forRequest({} as never).getReadings(request)).rejects.toThrow("Ambiguous");
  unregister();
  registry.register("broken", () => ({ getReadings: read }), { supports: async () => { throw new Error("lookup unavailable"); } });
  await expect(registry.forRequest({} as never).getReadings(request)).rejects.toThrow("lookup unavailable");
  expect(read).not.toHaveBeenCalled();
});

it("does not infer a provider when none is registered", async () => {
  await expect(new MeteringProviderFactories().forRequest({} as never).getReadings(request)).rejects.toThrow("No metering provider");
});

it("select() names the provider forRequest reads from", async () => {
  const registry = new MeteringProviderFactories();
  registry.register("openems", () => ({ getReadings: vi.fn(async () => []) }), { fallback: true });
  const read = vi.fn(async () => []);
  const factory = vi.fn(() => ({ getReadings: read }));
  registry.register("synthetic", factory, { supports: async (_client, id) => id === "grid-a" });
  const client = { organization: "a" } as never;
  expect(await registry.select(client, "grid-a")).toBe("synthetic");
  expect(await registry.select(client, "grid-b")).toBe("openems");
  await registry.forRequest(client).getReadings(request);
  expect(factory).toHaveBeenCalledWith(client);
  expect(read).toHaveBeenCalledWith(request);
});

it("select() fails closed with 503 when no provider or several match", async () => {
  const empty = new MeteringProviderFactories();
  await expect(empty.select({} as never, "grid-a")).rejects.toMatchObject({
    message: "No metering provider configured", code: "METERING_CONFIGURATION", statusCode: 503,
  });
  const registry = new MeteringProviderFactories();
  registry.register("one", () => ({ getReadings: vi.fn() }));
  registry.register("two", () => ({ getReadings: vi.fn() }));
  await expect(registry.select({} as never, "grid-a")).rejects.toMatchObject({
    message: "Ambiguous metering provider configuration", statusCode: 503,
  });
});

it("select() passes a selector's MeteringError through instead of falling back", async () => {
  const registry = new MeteringProviderFactories();
  const fallback = vi.fn(async () => []);
  registry.register("openems", () => ({ getReadings: fallback }), { fallback: true });
  const refusal = new MeteringError("mixed edges", "METERING_CONFIGURATION", 409);
  registry.register("synthetic", () => ({ getReadings: vi.fn() }), {
    supports: async () => { throw refusal; },
  });
  await expect(registry.select({} as never, "grid-a")).rejects.toBe(refusal);
  await expect(registry.forRequest({} as never).getReadings(request)).rejects.toBe(refusal);
  expect(fallback).not.toHaveBeenCalled();
});

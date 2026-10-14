import { expect, it, vi } from "vitest";
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

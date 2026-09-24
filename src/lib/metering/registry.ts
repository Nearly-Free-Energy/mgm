import type { MeteringProvider } from "./types";

export type MeteringProviderName = "openems" | "fixture";

/**
 * Small request-scoped registry. It deliberately has no fallback: production
 * code must select `openems`, while fixture selection stays at the caller.
 */
export class MeteringRegistry {
  private readonly providers = new Map<MeteringProviderName, MeteringProvider>();

  register(name: MeteringProviderName, provider: MeteringProvider): () => void {
    if (this.providers.has(name)) {
      throw new Error(`Metering provider "${name}" is already registered`);
    }
    this.providers.set(name, provider);
    return () => this.providers.delete(name);
  }

  resolve(name: MeteringProviderName): MeteringProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Metering provider "${name}" is not registered`);
    }
    return provider;
  }

  clear(): void {
    this.providers.clear();
  }
}

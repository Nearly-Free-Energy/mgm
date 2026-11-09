import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuiMeta } from "@/lib/gui/contract";

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: (supabase: unknown) => ({ kind: "openems", supabase }),
}));

const META: GuiMeta = {
  name: "probe",
  title: "Probe",
  version: "0.1.0",
  contract: "^0.1",
  styles: "./styles.css",
  dependencies: [],
};

/** A fresh root module that sees `guis` as the compiled-in GUIs. */
async function rootWith(guis: Record<string, GuiMeta>) {
  vi.resetModules();
  vi.doMock("@/gui/meta", () => ({ GUI_META: guis }));
  return import("../root");
}

let reset: (() => Promise<void>) | null = null;

afterEach(async () => {
  await reset?.();
  reset = null;
  vi.doUnmock("@/gui/meta");
});

describe("GUI_META on the runtime root", () => {
  it("installs each compiled-in GUI under its own name", async () => {
    const root = await rootWith({ probe: META });
    reset = root.resetMgmRuntimeForTests;
    const runtime = await root.getMgmRuntime();
    expect(runtime.mgmSurface.gui("probe")).toEqual(META);
    expect(runtime.fibers.map((fiber) => fiber.name)).toContain("probe");
  });

  it("stops the runtime when a key differs from its GUI's name", async () => {
    const root = await rootWith({ other: META });
    reset = root.resetMgmRuntimeForTests;
    await expect(root.getMgmRuntime()).rejects.toThrow('GUI "other" names itself "probe" in its metadata');
  });
});

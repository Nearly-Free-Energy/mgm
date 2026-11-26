/**
 * assistantGate once an assistant plugin is bundled (ADR-007 decision 5):
 * it asks that plugin's gate for the organization as a write, and refuses
 * with the gate's own answer while the plugin is off. No assistant plugin
 * is bundled yet (agent.test.ts), so the catalog here gains one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({ checkGate: (...args: unknown[]) => checkGate(...args) }));
vi.mock("@/lib/plugins/bundled", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/plugins/bundled")>();
  return { ...original, MGM_BUNDLED_PLUGINS: [...original.MGM_BUNDLED_PLUGINS, { ...original.MGM_BUNDLED_PLUGINS[1], name: "assistant" }] };
});

import { assistantGate } from "../agent";
import { AGENT_CALLER, ORG_A, ORG_B, contextFor, managerOf } from "./host-fakes";

const OFF = { ok: false, status: 409, code: "assistant_disabled", message: "The assistant is disabled for this organization." };

beforeEach(() => checkGate.mockReset());

describe("assistantGate with an assistant plugin bundled", () => {
  it("asks the assistant plugin's gate for the organization, as a write", async () => {
    checkGate.mockResolvedValue({ ok: true, organizationId: ORG_A });
    expect(await assistantGate(contextFor([managerOf(ORG_A)], undefined, AGENT_CALLER), ORG_A)).toBeNull();
    expect(checkGate).toHaveBeenCalledWith(expect.anything(), {
      plugin: "assistant",
      target: { kind: "organization", id: ORG_A },
      method: "GET",
      access: "write",
    });
  });

  it("refuses with the gate's answer while the plugin is off", async () => {
    checkGate.mockResolvedValue(OFF);
    expect(await assistantGate(contextFor([managerOf(ORG_A)], undefined, AGENT_CALLER), ORG_A)).toEqual(OFF);
  });

  it("throws for an organization the caller cannot reach, as pluginGate does", async () => {
    await expect(assistantGate(contextFor([managerOf(ORG_A)], undefined, AGENT_CALLER), ORG_B)).rejects.toThrow();
    expect(checkGate).not.toHaveBeenCalled();
  });
});

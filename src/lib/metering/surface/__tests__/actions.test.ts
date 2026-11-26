/**
 * The prepare steps of metering's guarded actions (../actions.ts): the
 * connection save's ceremony, which follows its route's billing-period
 * rule, and the edge delete's typed step. gui-surface.test.ts holds each
 * action to its route, schema, gate and release; the credential canary
 * (credential-canary.db.test.ts) prepares both against microgrids that hold
 * stored credentials and finds none in their output.
 */
import type { SurfaceRequest } from "@/lib/gui/surface";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";

const counts = vi.fn();
vi.mock("@/lib/entity-descendants", () => ({ countEntityDescendants: (...args: unknown[]) => counts(...args) }));

import { METERING_SURFACE } from "../../surface";
import {
  DELETE_EDGE_REFUSALS,
  SAVE_CONNECTION_REFUSALS,
  SAVE_CONNECTION_STATEMENT,
  prepareDeleteEdge,
  prepareSaveConnection,
} from "../actions";

const MG = "e2790000-0000-4000-8102-000000000001";
const EDGE = "e2790000-0000-4000-8103-000000000001";
type Results = Parameters<typeof tableClient>[0];

const request = (results: Results) =>
  ({ supabase: tableClient(results).client, fmt: createFmt({ locale: "en-GB" }) }) as unknown as SurfaceRequest;
const text = (t: string) => createFmt({ locale: "en-GB" }).text(t);
const number = (n: number) => createFmt({ locale: "en-GB" }).number(n);

describe("metering.save-connection's ceremony", () => {
  const microgrid = { data: { id: MG, name: " Kiwumu ", ems_backend_url: "https://openems.example.com" } };
  const prepare = (results: Results) => prepareSaveConnection(request(results), { params: { id: MG } });

  it("asks for nothing typed on a microgrid with no closed period", async () => {
    expect(await prepare({ microgrids: microgrid, billing_periods: { data: [] } })).toEqual({
      ok: true,
      model: {
        type: "ceremony",
        statement: SAVE_CONNECTION_STATEMENT,
        facts: [
          { label: "Microgrid", value: text("Kiwumu") },
          { label: "Backend saved now", value: text("https://openems.example.com") },
        ],
        warnings: [],
        acknowledgements: [],
      },
    });
  });

  it("asks for the microgrid's name, trimmed as the route compares it, with the route's warning, once a period is closed", async () => {
    const answer = await prepare({ microgrids: microgrid, billing_periods: { data: [{ status: "closed" }, { status: "closed" }] } });
    expect(answer).toMatchObject({
      ok: true,
      model: {
        typed: "Kiwumu",
        warnings: [
          "This microgrid has 2 closed billing periods. Changing the OpenEMS backend may affect historical invoice verification if edge IDs differ after rediscovery. Type the microgrid name to confirm.",
        ],
      },
    });
  });

  it("names no backend when none is saved", async () => {
    const answer = await prepare({ microgrids: { data: { ...microgrid.data, ems_backend_url: null } }, billing_periods: { data: [] } });
    expect(answer.ok && answer.model.facts[1]).toEqual({ label: "Backend saved now", value: text("None") });
  });

  it("refuses as the route does while a period is a draft, and when the microgrid or its periods cannot be read", async () => {
    expect(await prepare({ microgrids: microgrid, billing_periods: { data: [{ status: "closed" }, { status: "draft" }] } })).toEqual(
      SAVE_CONNECTION_REFUSALS.draft,
    );
    expect(await prepare({ microgrids: { data: null }, billing_periods: { data: [] } })).toEqual(SAVE_CONNECTION_REFUSALS.notFound);
    expect(await prepare({ microgrids: { data: null, error: { message: "boom" } } })).toEqual(SAVE_CONNECTION_REFUSALS.unavailable);
    expect(await prepare({ microgrids: microgrid, billing_periods: { data: null, error: { message: "boom" } } })).toEqual(
      SAVE_CONNECTION_REFUSALS.unavailable,
    );
  });
});

describe("metering.delete-edge's typed step", () => {
  beforeEach(() => {
    counts.mockReset();
    counts.mockResolvedValue({ kind: "edge", devices: 3, tenant_devices: 2, billing_line_items_nulled: 1, readings_in_closed_periods: 0 });
  });
  const prepare = (results: Results) => prepareDeleteEdge(request(results), { params: { id: EDGE } });

  it("asks for the edge's name typed, with what goes with it", async () => {
    expect(await prepare({ edges: { data: { id: EDGE, name: " Gateway 1 " } } })).toEqual({
      ok: true,
      model: {
        type: "ceremony",
        statement: "Deleting an edge deletes its devices, their meter readings and their tenant assignments. Bills keep their figures.",
        facts: [
          { label: "Edge", value: text("Gateway 1") },
          { label: "Devices", value: number(3) },
          { label: "Tenant assignments", value: number(2) },
          { label: "Bills that lose their meter link", value: number(1) },
        ],
        warnings: [],
        acknowledgements: [],
        typed: "Gateway 1",
      },
    });
    expect(counts).toHaveBeenCalledWith(expect.anything(), "edge", EDGE);
  });

  it("warns of readings taken in closed periods", async () => {
    counts.mockResolvedValue({ kind: "edge", devices: 1, tenant_devices: 0, billing_line_items_nulled: 0, readings_in_closed_periods: 31 });
    const answer = await prepare({ edges: { data: { id: EDGE, name: "Gateway 1" } } });
    expect(answer.ok && answer.model.warnings).toEqual(["31 meter readings taken during closed billing periods are deleted with it."]);
  });

  it("refuses an edge it cannot find, read or name, as the route would", async () => {
    expect(await prepare({ edges: { data: null } })).toEqual(DELETE_EDGE_REFUSALS.notFound);
    expect(await prepare({ edges: { data: null, error: { message: "boom" } } })).toEqual(DELETE_EDGE_REFUSALS.unavailable);
    expect(await prepare({ edges: { data: { id: EDGE, name: "  " } } })).toEqual(DELETE_EDGE_REFUSALS.unnamed);
    expect(counts).not.toHaveBeenCalled();
  });
});

describe("metering's actions", () => {
  it("are all human-only, offered only where a view links them, and say what a repeat does", () => {
    const actions = METERING_SURFACE.actions ?? [];
    expect(actions.map((a) => [a.id, a.method, a.path, a.confirm, a.repeat])).toEqual([
      ["metering.save-connection", "PUT", "/api/microgrids/[id]/openems-backend", "ceremony", "unsafe"],
      ["metering.check-connection", "POST", "/api/microgrids/[id]/openems-backend/discover", "none", "unsafe"],
      ["metering.register-edges", "POST", "/api/microgrids/[id]/edges/register", "none", "safe"],
      ["metering.edit-edge", "PATCH", "/api/edges/[id]", "none", "safe"],
      ["metering.delete-edge", "DELETE", "/api/edges/[id]", "typed", "safe"],
      ["metering.save-devices", "POST", "/api/devices", "none", "safe"],
      ["metering.edit-device", "PATCH", "/api/devices/[id]", "none", "safe"],
      ["metering.record-opening-register", "POST", "/api/meter-readings/opening", "confirm", "safe"],
    ]);
    for (const a of actions) {
      expect(a.humanOnly, a.id).toBe(true);
      expect(a.targeted, a.id).toBe(false);
    }
  });
});

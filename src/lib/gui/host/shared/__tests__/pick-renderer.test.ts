import { describe, expect, it } from "vitest";
import type { SyncComponent, ViewModel, ViewProps } from "../../../contract";
import { extVersion, knowsKind, pickRenderer } from "../pick-renderer";

const View: SyncComponent<ViewProps> = () => null;
const Bespoke: SyncComponent<ViewProps> = () => null;
const gui = { contract: "^0.1", View, renderers: { "metering.operations": { reads: [1, 2], Component: Bespoke } } } as const;

const metrics = (ext?: string, view = "metering.operations") =>
  ({ type: "view", view, kind: "metrics", ...(ext ? { ext: { schema: ext, data: null } } : {}) }) as unknown as ViewModel;

describe("pickRenderer", () => {
  it("picks the bespoke renderer when it reads the model's ext version", () => {
    expect(pickRenderer(gui, metrics("metering.site-day@2"))).toEqual({
      source: "renderer",
      id: "metering.operations",
      Component: Bespoke,
    });
  });

  it("falls back to the GUI's View without ext, for an unread version, or for another view", () => {
    for (const model of [metrics(), metrics("metering.site-day@3"), metrics("metering.site-day@1", "billing.periods")]) {
      expect(pickRenderer(gui, model)).toEqual({ source: "view", Component: View });
    }
  });

  it("uses RawView for a kind that arrived after the lowest version the GUI's range admits", () => {
    expect(pickRenderer(gui, metrics(), { metrics: "0.2.0" })).toEqual({ source: "raw" });
    expect(pickRenderer(gui, metrics(), { metrics: "0.1.3" })).toEqual({ source: "raw" });
    expect(pickRenderer({ ...gui, contract: "^0.1.3" }, metrics(), { metrics: "0.1.3" }).source).toBe("view");
    expect(pickRenderer({ ...gui, contract: "^0.2" }, metrics(), { metrics: "0.1.0" }).source).toBe("view");
  });

  it("still lets a bespoke renderer draw the exact ext version it reads", () => {
    expect(pickRenderer(gui, metrics("metering.site-day@1"), { metrics: "0.2.0" }).source).toBe("renderer");
  });
});

describe("knowsKind", () => {
  it("refuses an unlisted kind, an inherited key and a malformed range", () => {
    expect(knowsKind("^0.1", "chart")).toBe(false);
    expect(knowsKind("^0.1", "constructor")).toBe(false);
    expect(knowsKind(">=0.1", "metrics")).toBe(false);
    expect(knowsKind("^0.1", "metrics")).toBe(true);
  });
});

describe("extVersion", () => {
  it("reads the number after the last @", () => {
    expect(extVersion("metering.site-day@12")).toBe(12);
    expect(extVersion("metering.site-day")).toBeNull();
    expect(extVersion("metering.site-day@x")).toBeNull();
    expect(extVersion("metering.site-day@1.5")).toBeNull();
  });
});

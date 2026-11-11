import { act as flush, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { DialogFooter } from "@/components/ui/dialog";
import type { OverlayProps } from "../../contract";
import { KitProvider } from "../../host/client/kit-provider";
import { act, hostAct, KitRuntimeProvider } from "../../host/client/kit-runtime";
import type { PreparedAction } from "../../host/server/prepare";
import { initial, manifest, MG, recordingRuntime } from "../../host/client/__tests__/kit-test-utils";
import { Overlay } from "../overlay";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null }));
vi.mock("../../host/client/trusted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../host/client/trusted")>()),
  isTrusted: () => true,
  hasUserActivation: () => true,
}));
// Records what the host hands the kit's Overlay, and renders the real one.
const seen = vi.hoisted(() => [] as OverlayProps[]);
vi.mock("../overlay", async (importOriginal) => {
  const real = await importOriginal<typeof import("../overlay")>();
  return { Overlay: (props: OverlayProps) => (seen.push(props), real.Overlay(props)) };
});

function frame(over: Partial<OverlayProps> = {}) {
  const onDismiss = vi.fn();
  render(
    <Overlay title="Rename site" tone="neutral" role="form" onDismiss={onDismiss} {...over}>
      <div>
        <input aria-label="Name" />
        <DialogFooter data-testid="footer">
          <button type="button">Cancel</button>
        </DialogFooter>
      </div>
    </Overlay>,
  );
  return { onDismiss };
}

describe("the kit's Overlay", () => {
  it("is a dialog for a form and an alert dialog for a confirmation, titled", () => {
    frame();
    expect(screen.getByRole("dialog", { name: "Rename site" })).toBeTruthy();
  });

  it("frames a confirmation as an alert dialog with the danger tone", () => {
    frame({ role: "confirm", tone: "danger" });
    const panel = screen.getByRole("alertdialog", { name: "Rename site" });
    expect(panel.querySelector(".bg-destructive")).toBeTruthy();
  });

  it("is a bottom sheet under 600 px, capped at the visible height, with its footer pinned inside", () => {
    frame();
    const panel = screen.getByRole("dialog");
    // jsdom applies no media queries: these are the frame's classes, which dialog-frame.test.ts guards.
    for (const name of ["max-[600px]:bottom-0", "max-[600px]:w-full", "max-[600px]:max-h-[92vh]", "max-h-[90vh]", "overflow-y-auto"]) {
      expect(panel.classList.contains(name)).toBe(true);
    }
    const footer = screen.getByTestId("footer");
    expect(panel.contains(footer)).toBe(true);
    expect(footer.classList.contains("sticky")).toBe(true);
    expect(footer.classList.contains("bottom-0")).toBe(true);
    expect(footer.className).toContain("env(safe-area-inset-bottom)");
  });

  it("keeps focus inside and dismisses on Escape", async () => {
    const { onDismiss } = frame();
    const panel = screen.getByRole("dialog");
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("the kit's Overlay as the host's default frame", () => {
  it("receives only the host's slot and onDismiss, with the step portalled into it", async () => {
    seen.length = 0;
    const fetch = vi.fn(async (url: string) =>
      url === "/api/gui/prepare"
        ? Response.json({
            type: "prepared",
            spec: { type: "spec", id: "metering.rename", title: "Rename site", confirm: "confirm", inputVersion: 1, input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
            confirm: "confirm",
            method: "PATCH",
            path: `/api/microgrids/${MG}/name`,
            bound: { microgrid_id: MG },
            ceremony: null,
          } satisfies PreparedAction)
        : Response.json({}),
    );
    render(
      <KitRuntimeProvider runtime={recordingRuntime({ fetch, act: hostAct })}>
        <KitProvider manifest={manifest()} initial={initial}>
          {null}
        </KitProvider>
      </KitRuntimeProvider>,
    );
    const done = act({ action: "metering.rename", params: { microgrid_id: MG }, label: "Rename", enabled: true });
    const name = await screen.findByRole("textbox", { name: "Name" });
    const confirm = await screen.findByRole("button", { name: "Rename site" });
    expect(screen.getByRole("dialog").contains(confirm)).toBe(true);

    const props = seen.at(-1)!;
    expect(Object.keys(props).sort()).toEqual(["children", "onDismiss", "role", "title", "tone"]);
    expect(Object.entries(props).filter(([, v]) => typeof v === "function").map(([k]) => k)).toEqual(["onDismiss"]);
    // The one child is an element with no props: the slot, not the step.
    expect(isValidElement(props.children) && Object.keys(props.children.props as object)).toEqual([]);

    fireEvent.change(name, { target: { value: "Kasenge" } });
    fireEvent.click(confirm);
    await expect(done).resolves.toMatchObject({ ok: true });
    await flush(async () => {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// Dialog frame: the panel scrolls inside a height cap, becomes a bottom sheet
// under 600px, and keeps its decision row pinned. jsdom does not evaluate
// media queries or layout, so these tests pin the classes that produce that
// behaviour; the rendered result is checked by hand at 360px.

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DialogFooter, DialogOverlay, DialogPanel } from "../dialog";
import { ConfirmDialog } from "../confirm-dialog";
import { ClosePeriodDialog } from "../close-period-dialog";
import { LocaleProvider } from "../../format/locale-context";

function classesOf(el: Element | null): string[] {
  expect(el).not.toBeNull();
  return (el!.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function stickyAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    if (classesOf(node).includes("sticky")) return node;
    node = node.parentElement;
  }
  return null;
}

function renderFrame() {
  render(
    <Dialog.Root open>
      <Dialog.Portal>
        <DialogOverlay data-testid="overlay" />
        <DialogPanel role="alertdialog" className="w-[480px]">
          <Dialog.Title>Delete meter?</Dialog.Title>
          <Dialog.Description>It cannot be undone.</Dialog.Description>
          <DialogFooter data-testid="footer" className="mt-4">
            <Dialog.Close>Cancel</Dialog.Close>
          </DialogFooter>
        </DialogPanel>
      </Dialog.Portal>
    </Dialog.Root>,
  );
}

describe("DialogPanel", () => {
  it("keeps the caller's role and is modal", () => {
    renderFrame();
    const panel = screen.getByRole("alertdialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
  });

  it("caps its height to the visible screen and scrolls inside", () => {
    renderFrame();
    const classes = classesOf(screen.getByRole("alertdialog"));
    expect(classes).toEqual(
      expect.arrayContaining(["max-h-[90dvh]", "overflow-y-auto", "overscroll-contain"]),
    );
    expect(classes).not.toContain("overflow-hidden");
  });

  it("scrolls a focused field clear of the pinned footer", () => {
    renderFrame();
    expect(classesOf(screen.getByRole("alertdialog"))).toContain("scroll-pb-24");
  });

  it("opens from the bottom at full width under 600px", () => {
    renderFrame();
    const classes = classesOf(screen.getByRole("alertdialog"));
    expect(classes).toEqual(
      expect.arrayContaining([
        "max-[600px]:bottom-0",
        "max-[600px]:top-auto",
        "max-[600px]:left-0",
        "max-[600px]:w-full",
        "max-[600px]:max-w-none",
        "max-[600px]:max-h-[92dvh]",
        "max-[600px]:translate-x-0",
        "max-[600px]:translate-y-0",
        "max-[600px]:rounded-b-none",
      ]),
    );
  });

  it("keeps the caller's desktop width", () => {
    renderFrame();
    expect(classesOf(screen.getByRole("alertdialog"))).toEqual(
      expect.arrayContaining(["w-[480px]", "max-w-[94%]"]),
    );
  });

  it("uses colour tokens for the panel and the overlay", () => {
    renderFrame();
    expect(classesOf(screen.getByRole("alertdialog"))).toEqual(
      expect.arrayContaining(["bg-card", "border-border"]),
    );
    expect(classesOf(screen.getByTestId("overlay"))).toEqual(
      expect.arrayContaining(["fixed", "inset-0", "bg-foreground/55"]),
    );
  });
});

describe("DialogFooter", () => {
  it("is pinned to the bottom of the panel, above the safe area on phones", () => {
    renderFrame();
    const classes = classesOf(screen.getByTestId("footer"));
    expect(classes).toEqual(
      expect.arrayContaining([
        "sticky",
        "bottom-0",
        "bg-muted",
        "flex-wrap",
        "justify-end",
        "max-[600px]:pb-[max(18px,env(safe-area-inset-bottom))]",
        "mt-4",
      ]),
    );
  });
});

describe("dialogs built on the frame", () => {
  it("ConfirmDialog scrolls inside the panel and keeps Cancel in the pinned row", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete meter?"
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const panel = screen.getByRole("alertdialog");
    expect(classesOf(panel)).toContain("overflow-y-auto");
    expect(classesOf(panel)).not.toContain("overflow-hidden");
    expect(stickyAncestor(screen.getByRole("button", { name: "Cancel" }))).not.toBeNull();
    expect(stickyAncestor(screen.getByRole("button", { name: "Delete" }))).not.toBeNull();
  });

  it("ClosePeriodDialog keeps Cancel and Close anyway in the pinned row", () => {
    render(
      <LocaleProvider locale="en-UG" currency="UGX">
        <ClosePeriodDialog
          open
          onOpenChange={vi.fn()}
          periodLabel="April 2026"
          summaryRows={[{ label: "Households", value: "12" }]}
          grandTotal={4_216_800}
          onConfirm={vi.fn().mockResolvedValue(undefined)}
          unfilledHouseholdNames={["House 1"]}
        />
      </LocaleProvider>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(classesOf(panel)).toContain("overflow-y-auto");
    expect(stickyAncestor(screen.getByRole("button", { name: "Cancel" }))).not.toBeNull();
    expect(stickyAncestor(screen.getByRole("button", { name: "Close anyway" }))).not.toBeNull();
    // The status line takes its own row on a phone, above the two buttons.
    expect(classesOf(screen.getByText("You can still generate again before closing."))).toContain(
      "max-[600px]:basis-full",
    );
  });
});

// SelectionDialog primitive tests (#103).
//
// Coverage:
//   (a) Renders title + body + footer when open=true.
//   (b) Does NOT render when open=false.
//   (c) role="dialog" (NOT alertdialog — selection is a task).
//   (d) aria-labelledby wired to title; aria-describedby includes body id.
//   (e) Unlocked: Esc fires onOpenChange(false).
//   (f) locked=true: Esc does NOT fire onOpenChange.
//   (g) Body region carries aria-live="polite".
//   (h) onOpenAutoFocus override honored.
//   (i) Under 600px the list caps lower and the footer stays pinned.
//   (j) On a short window the list shrinks inside the panel's height cap.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SelectionDialog } from "../selection-dialog";

afterEach(() => {
  cleanup();
});

describe("SelectionDialog", () => {
  it("(a) renders title, body, and footer when open", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        footer={<button>Cancel</button>}
      >
        <div>Body content</div>
      </SelectionDialog>,
    );

    expect(screen.getByText("Add edges from OpenEMS")).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("(b) renders nothing when open=false", () => {
    render(
      <SelectionDialog
        open={false}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        footer={<button>Cancel</button>}
      >
        <div data-testid="body">Body content</div>
      </SelectionDialog>,
    );
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("(c) uses role='dialog' (not 'alertdialog')", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("(d) aria-labelledby wired to title; aria-describedby includes body id", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        description="Choose one or more edges to register."
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    const dialog = screen.getByRole("dialog");
    const labelledById = dialog.getAttribute("aria-labelledby");
    const describedByIds = dialog.getAttribute("aria-describedby") ?? "";

    expect(labelledById).toBeTruthy();
    expect(document.getElementById(labelledById!)?.textContent).toBe(
      "Add edges from OpenEMS",
    );
    expect(describedByIds).toContain("selection-dialog-body");
    expect(describedByIds).toContain("selection-dialog-desc");
  });

  it("(e) unlocked: Escape fires onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(
      <SelectionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Add edges"
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("(f) locked=true: Escape does NOT fire onOpenChange", () => {
    const onOpenChange = vi.fn();
    render(
      <SelectionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Add edges"
        locked={true}
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("(g) body region carries aria-live='polite'", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges"
        footer={<button>Cancel</button>}
      >
        <div data-testid="inner">Body</div>
      </SelectionDialog>,
    );

    const inner = screen.getByTestId("inner");
    // The body wrapper owns the live region; walk up to find it.
    const liveRegion = inner.closest("[aria-live]");
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
  });

  it("(h) onOpenAutoFocus override is invoked on open", async () => {
    const handler = vi.fn((e: Event) => e.preventDefault());
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges"
        onOpenAutoFocus={handler}
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
  });

  it("(i) the list is shorter on a phone, so the title and the buttons fit the sheet", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges"
        footer={<button>Cancel</button>}
      >
        <div data-testid="inner">Body</div>
      </SelectionDialog>,
    );

    const body = screen.getByTestId("inner").closest("[aria-live]");
    const classes = (body?.getAttribute("class") ?? "").split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "overflow-y-auto",
        "max-h-[70vh]",
        // vh for browsers without dvh; dvh only where it is supported.
        "max-[600px]:max-h-[55vh]",
        "max-[600px]:supports-[height:100dvh]:max-h-[55dvh]",
      ]),
    );
    expect(classes).not.toContain("max-[600px]:max-h-[55dvh]");
    // The Cancel button sits in the frame's pinned footer row.
    expect(screen.getByRole("button", { name: "Cancel" }).closest(".sticky")).not.toBeNull();
  });

  it("(j) on a short window only the list gives up height, so it is the one thing that scrolls", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges"
        footer={<button>Cancel</button>}
      >
        <div data-testid="inner">Body</div>
      </SelectionDialog>,
    );

    const classesOf = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);
    const panel = screen.getByRole("dialog");
    const body = screen.getByTestId("inner").closest("[aria-live]");
    const header = screen.getByText("Add edges").parentElement;
    const footer = screen.getByRole("button", { name: "Cancel" }).closest(".sticky");

    // A flex column inside the frame's height cap: the list shrinks to the
    // room the title and the buttons leave, down to its 280px floor.
    expect(classesOf(panel)).toEqual(expect.arrayContaining(["flex", "flex-col"]));
    expect(classesOf(body)).toContain("min-h-[280px]");
    expect(classesOf(body)).not.toContain("shrink-0");
    expect(classesOf(header)).toContain("shrink-0");
    expect(classesOf(footer)).toContain("shrink-0");
  });
});

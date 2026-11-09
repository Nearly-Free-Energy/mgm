// The row checkbox of the billing table's select column (jsdom).
//
// jsdom does not evaluate media queries, so the size checks read classes:
// size-4 is the box with a mouse; on a touch screen the label around it is
// a 44px square (pointer-coarse:size-11), so all of it is the target. The
// box's own touch size comes from globals.css (touch-targets.test.ts).

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { buildMultiSelectColumn } from "../multi-select-column";

type Row = { id: string; name: string };
const alice: Row = { id: "a", name: "Alice" };

function renderRowCheckbox(onToggleRow = vi.fn()) {
  const column = buildMultiSelectColumn<Row>({
    getRowId: (r) => r.id,
    getRowName: (r) => r.name,
    selectedIds: new Set<string>(),
    visibleIds: ["a"],
    onToggleRow,
    onSetAll: vi.fn(),
  });
  if (!column || column.kind !== "action") throw new Error("expected the select column");
  render(<>{column.render(alice)}</>);
  return onToggleRow;
}

describe("buildMultiSelectColumn row checkbox", () => {
  it("wraps the checkbox in a label that is 44px square on a touch screen", () => {
    renderRowCheckbox();
    const checkbox = screen.getByRole("checkbox", { name: "Select Alice" });
    const label = checkbox.parentElement;
    expect(label?.tagName).toBe("LABEL");
    expect(label?.className).toContain("pointer-coarse:size-11");
    expect(label?.className).toContain("inline-flex");
    expect(label?.textContent).toBe("");
  });

  it("keeps the 16px box with a mouse", () => {
    renderRowCheckbox();
    expect(screen.getByRole("checkbox", { name: "Select Alice" }).className).toContain("size-4");
  });

  it("toggles the row when the label around the box is tapped", () => {
    const onToggleRow = renderRowCheckbox();
    const label = screen.getByRole("checkbox", { name: "Select Alice" }).parentElement!;
    fireEvent.click(label);
    expect(onToggleRow).toHaveBeenCalledWith("a");
  });
});

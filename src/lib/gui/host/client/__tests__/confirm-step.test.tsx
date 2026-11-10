import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ceremony, Confirmation } from "../../../contract";
import { ConfirmStep, type ConfirmStepProps } from "../confirm-step";

// jsdom creates only untrusted events, so the positive paths stand in for
// real input here. Each test that leaves this false shows script input refused.
const input = vi.hoisted(() => ({ trusted: false }));
vi.mock("../trusted", () => ({ isTrusted: () => input.trusted, hasUserActivation: () => true }));

beforeEach(() => {
  input.trusted = false;
});
afterEach(() => vi.restoreAllMocks());

const ceremony: Ceremony = {
  type: "ceremony",
  statement: "Delete <b>Kasenge</b> and its 40 households?",
  facts: [{ label: "Households", value: { t: "number", v: 40, text: "40" } }],
  warnings: ["Bills already sent stay as they are."],
  acknowledgements: [
    { id: "bills", label: "I understand the bills <i>stay</i>." },
    { id: "devices", label: "Devices are unlinked." },
  ],
  typed: "Kasenge",
  digest: "d1",
};

function mount(props: Partial<ConfirmStepProps> = {}) {
  const onConfirm = vi.fn<(c: Confirmation) => void>();
  const onCancel = vi.fn();
  render(
    <ConfirmStep
      level="ceremony"
      title="Delete site"
      tone="danger"
      ceremony={ceremony}
      busy={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel, confirm: screen.getByRole("button", { name: "Delete site" }) };
}

const typedBox = () => screen.getByRole("textbox");

describe("ConfirmStep", () => {
  it("renders the ceremony verbatim as text, with every acknowledgement unticked", () => {
    mount();
    expect(screen.getByText("Delete <b>Kasenge</b> and its 40 households?")).toBeTruthy();
    expect(screen.getByText("I understand the bills <i>stay</i>.")).toBeTruthy();
    expect(screen.getByText("Bills already sent stay as they are.")).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
    expect(document.querySelector("b, i")).toBeNull();
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("ignores a script's click on Confirm", () => {
    const { onConfirm, confirm } = mount({ level: "confirm", ceremony: null });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    confirm.click();
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores a script's ticks and typing", () => {
    const typed = mount();
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.change(typedBox(), { target: { value: "Kasenge" } });
    expect(screen.getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    expect((typedBox() as HTMLInputElement).value).toBe("");
    expect((typed.confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Confirm only after every tick and an exact, trimmed, case-sensitive name", () => {
    input.trusted = true;
    const { onConfirm, confirm } = mount();
    const [bills, devices] = screen.getAllByRole("checkbox");
    fireEvent.click(bills);
    fireEvent.change(typedBox(), { target: { value: "  Kasenge " } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(devices);
    fireEvent.change(typedBox(), { target: { value: "kasenge" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(typedBox(), { target: { value: "  Kasenge " } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ digest: "d1", acknowledged: ["bills", "devices"], typed: "Kasenge" });
  });

  it("disables Confirm again when an acknowledgement is unticked", () => {
    input.trusted = true;
    const { onConfirm, confirm } = mount();
    const [bills, devices] = screen.getAllByRole("checkbox");
    fireEvent.click(bills);
    fireEvent.click(devices);
    fireEvent.change(typedBox(), { target: { value: "Kasenge" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(devices);
    expect((devices as HTMLInputElement).checked).toBe(false);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("sends no typed name or acknowledgements at the confirm level", () => {
    input.trusted = true;
    const { onConfirm, confirm } = mount({ level: "confirm", ceremony: null });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Delete site", { selector: "p" })).toBeTruthy();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ acknowledged: [] });
  });

  it("does nothing on Enter in the typed name, even when it matches", () => {
    input.trusted = true;
    const { onConfirm } = mount({ ceremony: { ...ceremony, acknowledgements: [] } });
    fireEvent.change(typedBox(), { target: { value: "Kasenge" } });
    fireEvent.keyDown(typedBox(), { key: "Enter" });
    fireEvent.submit(typedBox());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("submits nothing on mount, starts focus on Cancel and cancels on Escape", () => {
    input.trusted = true;
    const fetch = vi.spyOn(globalThis, "fetch");
    const { onConfirm, onCancel } = mount({ level: "confirm", ceremony: null });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("confirms once on a double click, because it is disabled while busy", () => {
    input.trusted = true;
    const onConfirm = vi.fn();
    function Host() {
      const [busy, setBusy] = useState(false);
      return (
        <ConfirmStep
          level="confirm"
          title="Save"
          tone="neutral"
          ceremony={null}
          busy={busy}
          error={busy ? null : "Try again"}
          onConfirm={(c) => {
            setBusy(true);
            onConfirm(c);
          }}
          onCancel={() => {}}
        />
      );
    }
    render(<Host />);
    expect(screen.getByRole("alert").textContent).toBe("Try again");
    const confirm = screen.getByRole("button", { name: "Save" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });
});

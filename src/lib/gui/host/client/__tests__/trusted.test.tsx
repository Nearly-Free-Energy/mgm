/** The real trust checks, unmocked: jsdom's events are all untrusted, as a script's are. */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ceremony } from "../../../contract";
import { ConfirmStep } from "../confirm-step";
import { hasUserActivation, isTrusted } from "../trusted";

function setActivation(value: { isActive: boolean } | undefined) {
  Object.defineProperty(navigator, "userActivation", { configurable: true, value });
}
afterEach(() => {
  delete (navigator as { userActivation?: unknown }).userActivation;
});

describe("isTrusted", () => {
  it("is false for an event a script made or dispatched", () => {
    expect(isTrusted(new Event("click"))).toBe(false);
    const button = document.createElement("button");
    const seen: boolean[] = [];
    button.addEventListener("click", (event) => seen.push(isTrusted(event)));
    fireEvent.click(button);
    button.click();
    expect(seen).toEqual([false, false]);
  });

  it("reads the native event's flag", () => {
    expect(isTrusted({ nativeEvent: { isTrusted: true } } as never)).toBe(true);
    expect(isTrusted({ nativeEvent: { isTrusted: false } } as never)).toBe(false);
  });
});

describe("hasUserActivation", () => {
  it("is true where the browser has no userActivation", () => {
    expect("userActivation" in navigator).toBe(false);
    expect(hasUserActivation()).toBe(true);
  });

  it("follows navigator.userActivation.isActive", () => {
    setActivation({ isActive: false });
    expect(hasUserActivation()).toBe(false);
    setActivation({ isActive: true });
    expect(hasUserActivation()).toBe(true);
  });
});

describe("ConfirmStep with the real check", () => {
  const ceremony: Ceremony = {
    type: "ceremony",
    statement: "Delete Kasenge?",
    facts: [],
    warnings: [],
    acknowledgements: [{ id: "a", label: "I understand." }],
    typed: "Kasenge",
  };

  it("ignores a script's ticks, typing and clicks", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmStep level="ceremony" title="Delete" tone="danger" ceremony={ceremony} busy={false} error={null} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Kasenge" } });
    const confirm = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores a script's click on an enabled Confirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmStep level="confirm" title="Save" tone="neutral" ceremony={null} busy={false} error={null} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const confirm = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    confirm.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

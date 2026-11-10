/** The real trust checks, unmocked: jsdom's events are all untrusted, as a script's are. */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ceremony } from "../../../contract";
import { ConfirmStep } from "../confirm-step";
import { hasUserActivation, isClickOn, isLiveEventOn, isTrusted, readInput } from "../trusted";

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

  it("is false for an object made to look like a trusted event", () => {
    expect(isTrusted({ nativeEvent: { isTrusted: true } } as never)).toBe(false);
    expect(isTrusted({ isTrusted: true } as never)).toBe(false);
    const copy = Object.create(MouseEvent.prototype) as MouseEvent;
    Object.defineProperty(copy, "isTrusted", { value: true });
    expect(copy instanceof Event).toBe(true);
    expect(isTrusted(copy)).toBe(false);
    expect(isTrusted({ nativeEvent: copy } as never)).toBe(false);
  });
});

describe("isClickOn", () => {
  it("is true only for a click on the element, or inside it, while it is dispatched", () => {
    const button = document.createElement("button");
    const label = button.appendChild(document.createElement("span"));
    const other = document.createElement("button");
    document.body.append(button, other);
    const kept: Event[] = [];
    const seen: boolean[] = [];
    const listen = (event: Event) => {
      kept.push(event);
      seen.push(isClickOn(event, button), isClickOn({ nativeEvent: event } as never, button));
    };
    document.body.addEventListener("click", listen);
    fireEvent.click(button);
    fireEvent.click(label);
    fireEvent.click(other);
    expect(seen).toEqual([true, true, true, true, false, false]);
    // Another type of event at the button, while it is dispatched.
    const pressed: boolean[] = [];
    button.addEventListener("mousedown", (event) => pressed.push(isClickOn(event, button)));
    fireEvent.mouseDown(button);
    expect(pressed).toEqual([false]);
    // An event kept from an earlier dispatch.
    expect(isClickOn(kept[0], button)).toBe(false);
    document.body.removeEventListener("click", listen);
    button.remove();
    other.remove();
  });

  it("reads the event's own attributes, not properties set on it", () => {
    const button = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(button, other);
    const seen: boolean[] = [];
    other.addEventListener("click", (event) => {
      Object.defineProperty(event, "target", { value: button });
      seen.push(isClickOn(event, button));
    });
    fireEvent.click(other);
    expect(seen).toEqual([false]);
    const shaped = { type: "click", target: button, eventPhase: 2 };
    expect(isClickOn(shaped as never, button)).toBe(false);
    expect(isClickOn({ nativeEvent: shaped } as never, button)).toBe(false);
    expect(isClickOn(new MouseEvent("click"), null)).toBe(false);
    button.remove();
    other.remove();
  });
});

describe("isLiveEventOn", () => {
  it("is true only for one of the given types, dispatched at the element now", () => {
    const box = document.body.appendChild(document.createElement("input"));
    box.type = "checkbox";
    const other = document.body.appendChild(document.createElement("input"));
    const seen: [string, boolean][] = [];
    const kept: Event[] = [];
    const listen = (event: Event) => {
      kept.push(event);
      seen.push([event.type, isLiveEventOn(event, box, ["click", "change"])]);
    };
    for (const type of ["click", "change", "keydown"]) document.body.addEventListener(type, listen);
    fireEvent.click(box);
    fireEvent.change(box);
    fireEvent.keyDown(box);
    fireEvent.click(other);
    expect(seen).toEqual([
      ["click", true],
      // A click on a checkbox fires its change too.
      ["change", true],
      ["change", true],
      ["keydown", false],
      ["click", false],
    ]);
    expect(kept.some((event) => isLiveEventOn(event, box, ["click", "change"]))).toBe(false);
    for (const type of ["click", "change", "keydown"]) document.body.removeEventListener(type, listen);
    box.remove();
    other.remove();
  });
});

describe("readInput", () => {
  it("reads the input's own state, not properties set on the element", () => {
    const box = document.body.appendChild(document.createElement("input"));
    box.type = "checkbox";
    Object.defineProperty(box, "checked", { value: true });
    Object.defineProperty(box, "value", { value: "Kasenge" });
    expect(readInput(box)).toEqual({ checked: false, value: "on" });
    const text = document.body.appendChild(document.createElement("input"));
    text.value = "Kas";
    expect(readInput(text)).toEqual({ checked: false, value: "Kas" });
    box.remove();
    text.remove();
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
      <ConfirmStep level="ceremony" title="Delete" tone="danger" ceremony={ceremony} busy={false} error={null} onConfirm={onConfirm} onTick={() => {}} onType={() => {}} onCancel={() => {}} />,
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
      <ConfirmStep level="confirm" title="Save" tone="neutral" ceremony={null} busy={false} error={null} onConfirm={onConfirm} onTick={() => {}} onType={() => {}} onCancel={() => {}} />,
    );
    const confirm = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    confirm.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

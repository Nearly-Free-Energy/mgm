import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_FIXTURES, renderShell, settle, type Rendered } from "@/lib/gui/conformance";
import type { GuiPlugin } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "..";
import { Sheet } from "../ui/sheet";

// A Shell that is only a sheet, rendered inside the real kit.
const gui: GuiPlugin = {
  ...GridtopGui,
  Shell: () => (
    <main>
      <button type="button" className="gt:h-11">
        Before
      </button>
      <Sheet
        title="Pick one"
        trigger={
          <button type="button" className="gt:h-11">
            Open
          </button>
        }
      >
        <kit.Link href="/microgrids" className="gt:flex gt:min-h-11">
          Microgrids
        </kit.Link>
      </Sheet>
    </main>
  ),
};

let rendered: Rendered | null = null;
async function sheet() {
  rendered = await renderShell(gui, MANIFEST_FIXTURES[0]);
  return { trigger: screen.getByRole("button", { name: "Open" }), goTo: rendered.goTo, firstPage: rendered.pathname };
}
async function open(trigger: HTMLElement) {
  await act(async () => fireEvent.click(trigger));
  return screen.getByRole("dialog", { name: "Pick one" });
}
afterEach(() => rendered?.unmount());

const tokens = (el: Element) => [...el.classList];

describe("Gridtop's sheet", () => {
  it("opens from its trigger as a named modal dialog and moves focus into it", async () => {
    const { trigger } = await sheet();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const dialog = await open(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole("link", { name: "Microgrids" }).getAttribute("href")).toBe("/microgrids");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { trigger } = await sheet();
    await open(trigger);
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from its Close button", async () => {
    const { trigger } = await sheet();
    const dialog = await open(trigger);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Close" })));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when the page changes, and stays closed on the new page", async () => {
    const { trigger, goTo } = await sheet();
    await open(trigger);
    await goTo("/microgrids");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays closed when the person comes back to the page it was opened on", async () => {
    const { trigger, goTo, firstPage } = await sheet();
    await open(trigger);
    await goTo("/microgrids");
    await goTo(firstPage);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a press outside it", async () => {
    const { trigger } = await sheet();
    await open(trigger);
    await act(async () => fireEvent.pointerDown(document.body));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open when a link inside it is opened in a new tab or window", async () => {
    const { trigger } = await sheet();
    const dialog = await open(trigger);
    const link = within(dialog).getByRole("link", { name: "Microgrids" });
    link.addEventListener("click", (event) => event.preventDefault());
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      await act(async () => fireEvent.click(link, { [key]: true }));
      expect(screen.getByRole("dialog", { name: "Pick one" })).toBe(dialog);
    }
    await act(async () => fireEvent.click(link, { button: 1 }));
    expect(screen.getByRole("dialog", { name: "Pick one" })).toBe(dialog);
  });

  it("closes when a link inside it is followed, even to the page already shown", async () => {
    const { trigger } = await sheet();
    const dialog = await open(trigger);
    const link = within(dialog).getByRole("link", { name: "Microgrids" });
    // Links stay put in jsdom.
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () => fireEvent.click(link));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides the rest of the page from assistive technology while open", async () => {
    const { trigger } = await sheet();
    await open(trigger);
    expect(screen.queryByRole("button", { name: "Before" })).toBeNull();
  });

  it("rises from the bottom below 600 px and is a centred panel from 600 px, its height capped by the screen", async () => {
    const { trigger } = await sheet();
    const dialog = await open(trigger);
    const classes = tokens(dialog);
    expect(classes).toEqual(
      expect.arrayContaining([
        "gt:fixed",
        "gt:inset-x-0",
        "gt:bottom-0",
        "gt:overflow-y-auto",
        // Each cap in vh, and in dvh where the browser has it.
        "gt:max-h-[92vh]",
        "gt:supports-[height:100dvh]:max-h-[92dvh]",
        "gt:medium:max-h-[80vh]",
        "gt:medium:supports-[height:100dvh]:max-h-[80dvh]",
        // Clear of a phone's home indicator.
        "gt:pb-[env(safe-area-inset-bottom)]",
        "gt:medium:top-1/2",
        "gt:medium:left-1/2",
        "gt:medium:-translate-x-1/2",
        "gt:medium:-translate-y-1/2",
      ]),
    );
    // The title row with Close stays in view while the list scrolls.
    const title = within(dialog).getByRole("heading", { name: "Pick one" });
    expect(tokens(title.parentElement!)).toEqual(expect.arrayContaining(["gt:sticky", "gt:top-0"]));
    // 44 px on touch screens.
    expect(tokens(within(dialog).getByRole("button", { name: "Close" }))).toContain("gt:pointer-coarse:size-11");
  });
});

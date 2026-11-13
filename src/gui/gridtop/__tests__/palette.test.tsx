import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_MODEL, renderShell, settle, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import type { ActionRef, EntityHit, EntityRef, NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "..";
import { isPaletteShortcut } from "../palette/launcher";

const nav = (id: NavEntry["id"], title: string, group: NavEntry["group"], order: number, href: string): NavEntry => ({
  id,
  title,
  icon: "sites",
  group,
  order,
  href: href as NavEntry["href"],
  needs: [...href.matchAll(/\[(\w+)\]/g)].map((m) => m[1] as NavEntry["needs"][number]),
  legacy: true,
});

const ORG: EntityRef = { kind: "organization", id: "o1", label: "Org One", href: "/organizations/o1" };
const COMMUNITY = { kind: "community" as const, id: "c1", label: "Kasana", href: "/communities/c1" as const };
const site = (id: string, label: string) => ({ kind: "microgrid" as const, id, label, href: `/microgrids/${id}` as const, parent: "c1" });

const FIXTURE: ManifestFixture = {
  name: "palette",
  pathname: "/",
  manifest: {
    type: "manifest",
    contract: "0.1.0",
    release: null,
    locale: "en",
    now: "2026-11-10T12:00:00.000Z",
    gui: "gridtop",
    user: { name: "Ann", email: "ann@example.test" },
    org: {
      id: "o1",
      name: "Org One",
      href: "/organizations/o1",
      timezone: null,
      nav: [
        nav("org.today", "Dashboard", "operate", 10, "/"),
        nav("billing.periods", "Billing", "money", 10, "/microgrids/[microgrid]/billing"),
        nav("org.profile", "Profile", "system", 30, "/settings/profile"),
      ],
      status: [],
      places: [COMMUNITY, site("m1", "East"), site("m2", "West")],
    },
    orgs: [{ id: "o1", name: "Org One", href: "/organizations/o1" }],
  },
  initial: { view: null, title: "Dashboard", trail: [], tabs: [], scope: { organization: ORG } },
};

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.restoreAllMocks();
});

async function shell() {
  rendered = await renderShell(GridtopGui, FIXTURE, <p>The page</p>);
  return rendered.log;
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Dispatches a real keydown on document and says whether its default was prevented. */
async function prevented(init: KeyboardEventInit): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  await act(async () => {
    document.dispatchEvent(event);
  });
  await settle();
  return event.defaultPrevented;
}

const status = () => within(screen.getByRole("dialog", { name: "Go to or find" })).getByRole("status");

const press = async (init: KeyboardEventInit) => {
  await act(async () => {
    fireEvent.keyDown(document, init);
  });
  await settle();
};

const input = () => screen.findByRole("combobox", { name: "Go to or find" });

async function type(text: string) {
  const field = await input();
  await act(async () => {
    fireEvent.change(field, { target: { value: text } });
  });
}

async function choose(name: string) {
  const option = await screen.findByRole("option", { name: new RegExp(`^${name}`) });
  // A press on a row moves focus to the dialog, as a browser does; jsdom's click moves none.
  option.closest<HTMLElement>("[role=dialog]")?.focus();
  await act(async () => {
    fireEvent.click(option);
  });
}

describe("command palette", () => {
  it("opens with Ctrl+K or ⌘K, and with no single key", async () => {
    const log = await shell();
    await press({ key: "k" });
    expect(screen.queryByRole("combobox")).toBeNull();
    await press({ key: "k", ctrlKey: true });
    expect(await input()).toBeTruthy();
    await press({ key: "k", ctrlKey: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    await press({ key: "K", metaKey: true });
    expect(await input()).toBeTruthy();
    // Opening lists the choices and runs none of them.
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    expect(log.act).toEqual([]);
    expect(log.navigate).toEqual([]);
  });

  it("takes ⌘K and Ctrl+K from the browser, and leaves other keys alone", async () => {
    await shell();
    expect(await prevented({ key: "k" })).toBe(false);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(await prevented({ key: "K", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(await prevented({ key: "k", ctrlKey: true, altKey: true })).toBe(false);
    expect(await prevented({ key: "k", metaKey: true, altKey: true })).toBe(false);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(await prevented({ key: "k", ctrlKey: true, isComposing: true })).toBe(false);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(await prevented({ key: "k", ctrlKey: true })).toBe(true);
    expect(await input()).toBeTruthy();
  });

  it("ignores the shortcut while an input method is composing", async () => {
    await shell();
    await press({ key: "k", ctrlKey: true, isComposing: true });
    await press({ key: "k", ctrlKey: true, keyCode: 229 });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("ignores a keydown with no key, as an autofilled field sends", () => {
    expect(isPaletteShortcut({ ctrlKey: true, metaKey: true } as KeyboardEvent)).toBe(false);
  });

  it("opens from the title bar's button, which has a name and a 44 px touch target", async () => {
    const log = await shell();
    const button = screen.getByRole("button", { name: "Go to or find" });
    expect(button.className).toContain("gt:pointer-coarse:h-11");
    expect(button.className).toContain("gt:pointer-coarse:min-w-11");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await input()).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Go to or find" })).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(log.act).toEqual([]);
    expect(log.navigate).toEqual([]);
  });

  it("gives its field and its rows a 44 px touch target", async () => {
    await shell();
    await press({ key: "k", ctrlKey: true });
    expect((await input()).className).toContain("gt:pointer-coarse:h-11");
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option.className).toContain("gt:pointer-coarse:min-h-11");
  });

  it("puts focus in its field, and back where it was once closed", async () => {
    await shell();
    const button = screen.getByRole("button", { name: "Go to or find" });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    await settle();
    expect(document.activeElement).toBe(await input());
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    await settle();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(button);

    const account = screen.getByRole("button", { name: "Account: Ann" });
    account.focus();
    await press({ key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(await input());
    await press({ key: "k", ctrlKey: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(account);
  });

  it("is open for one page only", async () => {
    await shell();
    await press({ key: "k", ctrlKey: true });
    expect(await input()).toBeTruthy();
    await rendered!.goTo("/settings/profile");
    await settle();
    expect(screen.queryByRole("combobox")).toBeNull();
    await rendered!.goTo("/");
    await settle();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("calls kit.act with the view's own ActionRef, so the host's form runs", async () => {
    const real = kit.useView;
    vi.spyOn(kit, "useView").mockImplementation(() => ({ ...real(), model: PAGE_MODEL }));
    const log = await shell();
    await press({ key: "k", ctrlKey: true });
    await type("/");
    await choose("Rename");
    expect(log.act).toHaveLength(1);
    expect(log.act[0]).toBe(PAGE_MODEL.actions[0]);
    expect(log.navigate).toEqual([]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("cannot choose a disabled action", async () => {
    const remove: ActionRef = { action: "community.delete", params: { id: "c1" }, label: "Delete", enabled: false, reason: "It still has microgrids", tone: "danger" };
    const real = kit.useView;
    vi.spyOn(kit, "useView").mockImplementation(() => ({ ...real(), model: { ...PAGE_MODEL, actions: [remove] } }));
    const log = await shell();
    await press({ key: "k", ctrlKey: true });
    await type("/");
    const option = await screen.findByRole("option", { name: /^Delete/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    await choose("Delete");
    expect(log.act).toEqual([]);
    expect(log.navigate).toEqual([]);
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("asks for a microgrid before opening an app that needs one", async () => {
    const log = await shell();
    await press({ key: "k", ctrlKey: true });
    await choose("Billing");
    expect(log.navigate).toEqual([]);
    expect(screen.getByText("Billing: choose a microgrid")).toBeTruthy();
    await choose("West");
    expect(log.navigate).toEqual(["/microgrids/m2/billing"]);
    expect(log.act).toEqual([]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("leaves a place pick with Back, or Backspace in an empty field", async () => {
    await shell();
    await press({ key: "k", ctrlKey: true });
    await choose("Billing");
    expect(document.activeElement).toBe(await input());
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    await act(async () => {
      fireEvent.click(back);
    });
    expect(screen.queryByText("Billing: choose a microgrid")).toBeNull();
    expect(screen.getByRole("option", { name: /^Dashboard/ })).toBeTruthy();
    expect(document.activeElement).toBe(await input());

    await choose("Billing");
    await type("We");
    await act(async () => {
      fireEvent.keyDown(await input(), { key: "Backspace" });
    });
    expect(screen.getByText("Billing: choose a microgrid")).toBeTruthy();
    await type("");
    await act(async () => {
      fireEvent.keyDown(await input(), { key: "Backspace" });
    });
    expect(screen.queryByText("Billing: choose a microgrid")).toBeNull();
    expect(screen.getByRole("option", { name: /^Dashboard/ })).toBeTruthy();
  });

  it("closes when the choice is the page already shown", async () => {
    const log = await shell();
    await press({ key: "k", ctrlKey: true });
    await choose("Dashboard");
    expect(log.navigate).toEqual(["/"]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("merges places with the host's hits after @, asking once typing pauses", async () => {
    const hit: EntityHit = { kind: "household", id: "h1", label: "East shop", href: "/microgrids/m1/households/h1" };
    const search = vi.spyOn(kit, "search").mockResolvedValue([hit]);
    const log = await shell();
    await press({ key: "k", ctrlKey: true });
    await type("@e");
    await type("@ea");
    await type("@eas");
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByRole("option", { name: /^East,\s*Microgrid in Kasana$/ })).toBeTruthy();
    await screen.findByRole("option", { name: "East shop" });
    // The earlier inputs were abandoned before they reached the host.
    expect(search.mock.calls).toEqual([["eas", "@"]]);
    await choose("East shop");
    expect(log.navigate).toEqual([hit.href]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("drops a late answer to an earlier search", async () => {
    const answers = new Map<string, (hits: EntityHit[]) => void>();
    vi.spyOn(kit, "search").mockImplementation((query) => new Promise((resolve) => answers.set(query, resolve)));
    const first: EntityHit = { kind: "household", id: "h1", label: "First answer", href: "/microgrids/m1/households/h1" };
    const second: EntityHit = { kind: "household", id: "h2", label: "Second answer", href: "/microgrids/m1/households/h2" };
    await shell();
    await press({ key: "k", ctrlKey: true });
    await type("@zz");
    await wait(300);
    await type("@zzz");
    await wait(300);
    expect([...answers.keys()]).toEqual(["zz", "zzz"]);
    await act(async () => {
      answers.get("zzz")!([second]);
    });
    await act(async () => {
      answers.get("zz")!([first]);
    });
    expect(screen.getByRole("option", { name: "Second answer" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "First answer" })).toBeNull();
    expect(status().textContent).toBe("");
  });

  it("says there is nothing to find with # yet, in a status line kept in place", async () => {
    let answer: (hits: EntityHit[]) => void = () => {};
    vi.spyOn(kit, "search").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await shell();
    await press({ key: "k", ctrlKey: true });
    // Present while the list has choices, so its later text is announced.
    expect(status().textContent).toBe("");
    expect(status().className).not.toMatch(/(^|\s)gt:(empty:)?hidden(\s|$)/);
    await type("#bill");
    expect(status().textContent).toBe("Searching…");
    await wait(300);
    await act(async () => {
      answer([]);
    });
    expect(status().textContent).toBe("Nothing to find with # yet");
    expect(screen.queryAllByRole("option")).toEqual([]);
  });
});

describe("open in new window", () => {
  it("opens this page with its ui.* parameters in a new window, without a link back", async () => {
    window.history.replaceState(null, "", "/?ui.sheet=more");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await shell();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Account: Ann" }));
    });
    const button = await screen.findByRole("button", { name: "Open in new window" });
    // Hidden below 600 px.
    expect(button.parentElement?.className).toBe("gt:hidden gt:medium:block");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/?ui.sheet=more`, "_blank", "noopener,noreferrer");
    window.history.replaceState(null, "", "/");
  });
});

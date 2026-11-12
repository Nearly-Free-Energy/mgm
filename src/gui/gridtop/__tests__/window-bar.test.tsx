import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderShell, settle, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import type { ActionRef, LinkRef, ViewModel, ViewState } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "..";
import { GRIDTOP_META } from "../meta";
import { clockText } from "../shell/status-bar";
import { tabsOf } from "../shell/window-bar";
import { openable } from "../ui/href";
import { EAST, EAST_TRAIL, KASANA, ORG, displayConflicts, placesFixture } from "./places-fixture";

const REFRESH: ActionRef = { action: "metering.refresh", params: { microgrid: "m1" }, label: "Refresh", enabled: true };
const CLOSE: ActionRef = { action: "billing.close", params: {}, label: "Close period", enabled: false, reason: "Billing is off" };
const EXPORT: LinkRef = { id: "metering.export", label: "Export CSV", href: "/microgrids/m1/operations?format=csv", download: { mime: "text/csv", filename: "day.csv" } };

const MODEL: ViewModel = {
  type: "view",
  view: "metering.site-day",
  kind: "record",
  title: "Operations",
  subtitle: "Tuesday 10 November",
  org: "o1",
  trail: [],
  body: { sections: [] },
  actions: [REFRESH, CLOSE],
  links: [EXPORT],
  attached: [
    { view: "billing.savings", title: "Savings", href: "/microgrids/m1/operations/savings", hint: "tab" },
    { view: "acme.notes", title: "Notes", href: "/microgrids/m1/notes", hint: "section" },
  ],
};

const DAY = { title: "Day", href: "/microgrids/m1/operations" as const, current: true };

const atEast = (): ManifestFixture =>
  placesFixture({
    pathname: "/microgrids/m1/operations",
    initial: { view: "metering.site-day", title: "Operations", trail: EAST_TRAIL, tabs: [DAY], scope: { organization: ORG, community: KASANA, microgrid: EAST } },
  });

/** useView() as the kit gives it, with a contributed view's model, as a ViewBoundary would publish it. */
function withModel(model: ViewModel | null) {
  const real = kit.useView;
  vi.spyOn(kit, "useView").mockImplementation((): ViewState => ({ ...real(), model }));
}

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function shell(f: ManifestFixture = atEast()) {
  rendered = await renderShell(GridtopGui, f, <p>The page</p>);
  return rendered;
}
const bar = () => document.querySelector<HTMLElement>("[data-window-bar]");
const classes = (el: Element) => [...el.classList];
async function openSheet(button: HTMLElement, name: string | RegExp) {
  await act(async () => fireEvent.click(button));
  return screen.getByRole("dialog", { name });
}

describe("Gridtop's window bar", () => {
  it("is absent on a page outside the contract", async () => {
    await shell();
    expect(bar()).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull();
  });

  it("shows the view's title, subtitle, tabs, actions and links, at the top of main", async () => {
    withModel(MODEL);
    await shell();
    const el = bar()!;
    expect(screen.getByRole("main").firstElementChild).toBe(el);
    expect(el.textContent).toContain("Operations");
    expect(el.textContent).toContain("Tuesday 10 November");
    const tabs = screen.getByRole("navigation", { name: "Tabs" });
    // The page's own tabs, then the views attached as tabs; a section is not a tab.
    expect(within(tabs).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")])).toEqual([
      ["Day", "/microgrids/m1/operations", "page"],
      ["Savings", "/microgrids/m1/operations/savings", null],
    ]);
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect(within(el).getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(within(el).getByRole("link", { name: "Export CSV" }).getAttribute("href")).toBe(EXPORT.href);
  });

  it("acts through kit.act with the exact ref, and opens links through kit.open", async () => {
    withModel(MODEL);
    const { log } = await shell();
    expect(log.act).toEqual([]);
    await act(async () => fireEvent.click(within(bar()!).getByRole("button", { name: "Refresh" })));
    expect(log.act).toHaveLength(1);
    expect(log.act[0]).toBe(REFRESH);
    // The anchor is not followed as well: kit.open alone opens it.
    let followed = true;
    await act(async () => {
      followed = fireEvent.click(within(bar()!).getByRole("link", { name: "Export CSV" }));
    });
    expect(followed).toBe(false);
    expect(log.open).toEqual([EXPORT]);
  });

  it("draws a link as an anchor only for an href kit.open would open", async () => {
    const opened = ["/microgrids/m1/x", "/microgrids/m1/x?format=csv#top", "tel:+256700000000", "sms:+256700000000?body=Hi%20there", "https://wa.me/256700000000"];
    const refused = [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example/x",
      "/a%2fb",
      "/a/../b",
      "javascript:alert(1)",
      "https://evil.example",
      "tel:abc",
      "tel:javascript",
      "https://wa.me/../x",
      "microgrids/m1",
    ];
    const links: LinkRef[] = [...opened, ...refused].map((href, i) => ({ id: `acme.l${i}` as const, label: `Link ${i}`, href: href as LinkRef["href"] }));
    withModel({ ...MODEL, actions: [], links });
    await shell();
    const anchors = within(bar()!).queryAllByRole("link").filter((a) => a.textContent?.startsWith("Link "));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(opened);
    for (const [i] of refused.entries()) expect(within(bar()!).getByText(`Link ${opened.length + i}`).tagName).toBe("SPAN");
  });

  it("checks hrefs as the kit does", () => {
    for (const href of ["/", "/microgrids/m1/operations", "tel:+256700000000", "https://wa.me/256700000000?text=Hello"]) expect(openable(href), href).toBe(true);
    for (const href of ["", "/a b", "/é", "/a/./b", "/a%5cb", "/\u007f", `/${"a".repeat(2048)}`, "sms:+1", "https://wa.me/256700000000?text=<x>", 7]) {
      expect(openable(href), String(href)).toBe(false);
    }
  });

  it("shows why a disabled action is disabled, with no live control", async () => {
    withModel(MODEL);
    const { log } = await shell();
    const button = within(bar()!).getByRole("button", { name: "Close period" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Billing is off");
    await act(async () => fireEvent.click(button));
    expect(log.act).toEqual([]);
  });

  it("marks a proposed action and a dangerous one", async () => {
    const proposed: ActionRef = { ...REFRESH, label: "Reset", tone: "danger", provenance: { by: "assistant", at: "2026-11-10T12:00:00.000Z" } };
    withModel({ ...MODEL, actions: [proposed], links: [] });
    await shell();
    const button = within(bar()!).getAllByRole("button").find((b) => b.textContent?.endsWith("Reset"))!;
    expect(button.textContent).toBe("ProposedReset");
    expect(classes(button)).toEqual(expect.arrayContaining(["gt:border-dashed", "gt:text-destructive-fg"]));
  });

  it("lists an attached tab once, and marks it current on its own page", () => {
    const model: ViewModel = { ...MODEL, attached: [{ view: "metering.site-day", title: "Day again", href: DAY.href, hint: "tab" }, ...MODEL.attached] };
    expect(tabsOf({ tabs: [{ ...DAY, current: false }] }, model, "/microgrids/m1/operations/savings")).toEqual([
      { ...DAY, current: false },
      { title: "Savings", href: "/microgrids/m1/operations/savings", current: true },
    ]);
  });

  it("presses an action once while it runs, and shows no message for one that worked", async () => {
    withModel(MODEL);
    let finish: (v: Awaited<ReturnType<typeof kit.act>>) => void = () => {};
    const spy = vi.spyOn(kit, "act").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await shell();
    const button = within(bar()!).getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    await act(async () => fireEvent.click(button));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => fireEvent.click(button));
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => finish({ type: "result", ok: true, message: "Done." }));
    expect(button.disabled).toBe(false);
    expect(within(bar()!).queryByRole("status")).toBeNull();
  });

  it("drops a refused action's message on another page", async () => {
    withModel(MODEL);
    vi.spyOn(kit, "act").mockResolvedValue({ type: "result", ok: false, status: 409, code: "conflict", message: "Already refreshing." });
    const r = await shell();
    await act(async () => fireEvent.click(within(bar()!).getByRole("button", { name: "Refresh" })));
    expect(within(bar()!).getByRole("status").textContent).toBe("Already refreshing.");
    await r.goTo("/microgrids/m1/operations/savings");
    expect(within(bar()!).queryByRole("status")).toBeNull();
  });

  it("shows a refused action's message, and nothing for a cancelled one", async () => {
    withModel(MODEL);
    const spy = vi.spyOn(kit, "act").mockResolvedValue({ type: "result", ok: false, status: 409, code: "conflict", message: "Already refreshing." });
    await shell();
    await act(async () => fireEvent.click(within(bar()!).getByRole("button", { name: "Refresh" })));
    expect(within(bar()!).getByRole("status").textContent).toBe("Already refreshing.");
    spy.mockResolvedValue({ type: "result", ok: false, status: 0, code: "cancelled", message: "Cancelled." });
    await act(async () => fireEvent.click(within(bar()!).getByRole("button", { name: "Refresh" })));
    expect(within(bar()!).queryByRole("status")).toBeNull();
  });

  it("is one bar below 600 px: the title opens the tabs and ⋯ the actions and links", async () => {
    withModel(MODEL);
    const { log } = await shell();
    expect(displayConflicts(document.body)).toEqual([]);
    const [compact, wide] = [...bar()!.children] as HTMLElement[];
    expect(classes(compact)).toEqual(expect.arrayContaining(["gt:h-11", "gt:medium:hidden"]));
    expect(classes(wide)).toEqual(expect.arrayContaining(["gt:hidden", "gt:medium:flex"]));
    expect(classes(screen.getByRole("navigation", { name: "Tabs" }))).toEqual(expect.arrayContaining(["gt:hidden", "gt:medium:block"]));

    const tabs = await openSheet(within(compact).getByRole("button", { name: "Operations, tabs" }), "Operations");
    expect(within(tabs).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("aria-current")])).toEqual([
      ["Day", "page"],
      ["Savings", null],
    ]);
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    await settle();

    const actions = await openSheet(within(compact).getByRole("button", { name: "Actions" }), "Operations: actions");
    expect(within(actions).getByText("Billing is off")).toBeTruthy();
    await act(async () => fireEvent.click(within(actions).getByRole("button", { name: "Refresh" })));
    // The sheet makes way for the action host's own dialog.
    expect(screen.queryByRole("dialog", { name: "Operations: actions" })).toBeNull();
    expect(log.act).toEqual([REFRESH]);
  });

  it("shows the title alone and no ⋯ for a view with no tabs, actions or links", async () => {
    withModel({ ...MODEL, actions: [], links: [], attached: [] });
    await shell(placesFixture({ pathname: "/microgrids/m1/operations", initial: { trail: EAST_TRAIL, scope: { organization: ORG, microgrid: EAST } } }));
    const [compact] = [...bar()!.children] as HTMLElement[];
    expect(within(compact).queryAllByRole("button")).toEqual([]);
    expect(compact.textContent).toBe("Operations");
    expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull();
  });

  it("slides away while main scrolls down below 600 px, and comes back on scrolling up", async () => {
    withModel(MODEL);
    await shell();
    const main = screen.getByRole("main");
    const scrollTo = async (y: number) => {
      main.scrollTop = y;
      await act(async () => fireEvent.scroll(main));
    };
    await scrollTo(20);
    expect(classes(bar()!)).not.toContain("gt:max-medium:-translate-y-full");
    await scrollTo(200);
    expect(classes(bar()!)).toContain("gt:max-medium:-translate-y-full");
    await scrollTo(150);
    expect(classes(bar()!)).not.toContain("gt:max-medium:-translate-y-full");
  });

  it("comes back when focus moves into it after sliding away", async () => {
    withModel(MODEL);
    await shell();
    const main = screen.getByRole("main");
    for (const y of [20, 200]) {
      main.scrollTop = y;
      await act(async () => fireEvent.scroll(main));
    }
    expect(classes(bar()!)).toContain("gt:max-medium:-translate-y-full");
    await act(async () => within(bar()!).getByRole("button", { name: "Actions" }).focus());
    expect(classes(bar()!)).not.toContain("gt:max-medium:-translate-y-full");
  });
});

describe("Gridtop's status bar", () => {
  const statusBar = () => screen.getByRole("contentinfo", { name: "Status bar" });

  it("shows only in an expanded, tall window", async () => {
    await shell();
    expect(classes(statusBar())).toEqual(expect.arrayContaining(["gt:hidden", "gt:expanded:tall:flex"]));
  });

  it("shows the organization, its time zone and the time there, Gridtop's version and the release", async () => {
    const f = atEast();
    f.manifest.release = "v0.0.9";
    f.manifest.locale = "en-GB";
    await shell(f);
    const text = statusBar().textContent;
    expect(text).toContain("Org One");
    // The manifest's 12:00 UTC, in Kampala.
    expect(text).toContain("Africa/Kampala 15:00");
    expect(statusBar().querySelector("time")?.getAttribute("datetime")).toBe("2026-11-10T12:00:00.000Z");
    expect(text).toContain(`${GRIDTOP_META.title} ${GRIDTOP_META.version}`);
    expect(text).toContain("MGM v0.0.9");
  });

  it("leaves the release out until a build is stamped, and shows UTC without a time zone", async () => {
    await shell(placesFixture({ timezone: null }));
    const text = statusBar().textContent;
    expect(text).not.toContain("MGM");
    expect(text).toContain("UTC");
  });

  it("moves the clock on from the server's time, whatever the device's clock says", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(Date.parse("2020-01-01T00:00:00.000Z"));
    await shell(placesFixture({ timezone: "UTC", manifest: { locale: "en-GB" } }));
    expect(statusBar().querySelector("time")?.textContent).toBe("12:00");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(statusBar().querySelector("time")?.textContent).toBe("12:01");
    expect(statusBar().querySelector("time")?.getAttribute("datetime")).toBe("2026-11-10T12:01:00.000Z");
  });

  it("falls back to UTC for a time zone the browser does not know", () => {
    expect(clockText(Date.parse("2026-11-10T12:34:00.000Z"), "en", "Not/AZone")).toEqual({ text: "12:34", zone: "UTC" });
    expect(clockText(Number.NaN, "en", "UTC")).toEqual({ text: "", zone: "UTC" });
  });
});

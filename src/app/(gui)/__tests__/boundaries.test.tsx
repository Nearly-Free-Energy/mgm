// @vitest-environment jsdom
/**
 * What the shell draws over the (gui) group's not-found.tsx and error.tsx.
 *
 * On a page a contributed view serves, the (gui) layout names the view for
 * the first paint before the page has loaded it (resolveInitialView), and
 * Gridtop's window bar waits, busy, for the model. A page that is not found
 * (another organization's microgrid, an id that names nothing) or throws
 * publishes no model, so these two files must settle the bar themselves.
 * Gridtop is the installed GUI that draws a window bar.
 */
import "@/test/gui-setup";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GridtopGui } from "@/gui/gridtop";
import { MANIFEST_FIXTURES, renderShell, type ManifestFixture, type Rendered } from "@/lib/gui/conformance";
import GuiError from "../error";
import GuiNotFound from "../not-found";

/** The first paint of an Operations page: the view named, its model not yet published. */
const base = MANIFEST_FIXTURES[0];
const OPERATIONS: ManifestFixture = { ...base, initial: { ...base.initial, view: "metering.site-day", title: "Operations" } };

const bar = () => document.querySelector<HTMLElement>("[data-window-bar]");

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

describe("the (gui) boundaries inside the shell, on a page a view serves", () => {
  it("leave the bar waiting while the page is still to come", async () => {
    rendered = await renderShell(GridtopGui, OPERATIONS, <p>Loading</p>);
    expect(bar()?.getAttribute("aria-busy")).toBe("true");
  });

  it("not-found.tsx ends the wait: no window bar and nothing busy", async () => {
    rendered = await renderShell(GridtopGui, OPERATIONS, <GuiNotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Apps" }).length).toBeGreaterThan(0);
    expect(bar()).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("error.tsx ends the wait, shows no error text, and its Try again asks the server again", async () => {
    const retry = vi.fn();
    const reset = vi.fn();
    const error = Object.assign(new Error("secret detail"), { digest: "1234" });
    rendered = await renderShell(GridtopGui, OPERATIONS, <GuiError error={error} reset={reset} retry={retry} />);
    expect(screen.getByRole("heading", { name: "This page could not be shown" })).toBeTruthy();
    expect(screen.getByText("Reference: 1234")).toBeTruthy();
    expect(screen.queryByText(/secret detail/)).toBeNull();
    expect(bar()).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("error.tsx falls back to reset where Next.js passes no retry", async () => {
    const reset = vi.fn();
    rendered = await renderShell(GridtopGui, OPERATIONS, <GuiError error={new Error("boom")} reset={reset} />);
    expect(screen.queryByText(/Reference/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

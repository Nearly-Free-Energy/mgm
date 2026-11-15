/**
 * The day switcher in Gridtop. The server decides the hrefs, and the date
 * box navigates through kit.navigate.
 */
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderInKit, type Recorded } from "@/lib/gui/conformance";
import type { LinkRef } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { DayPicker } from "../day-picker";
import { readSiteDayExt } from "../ext";
import { DATE, DAY_HREF, TODAY, dayLinks, dayModel } from "./site-day-fixture";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

const extOf = (date: string, today: string) => readSiteDayExt(dayModel({ date, today }).ext)!;

async function picker(date = DATE, today = TODAY, links: LinkRef[] = dayLinks(date, today)): Promise<Recorded> {
  const rendered = await renderInKit(<DayPicker ext={extOf(date, today)} links={links} heading="Thu, 05 Nov 2026" kit={kit} />);
  unmount = rendered.unmount;
  return rendered.log;
}

const dayInput = () => screen.getByLabelText("Day") as HTMLInputElement;
const link = (name: string) => screen.queryByRole("link", { name });
/** Submits the date box; true when the browser's own submission was cancelled. */
async function submit(): Promise<boolean> {
  let cancelled = false;
  await act(async () => {
    cancelled = !fireEvent.submit(dayInput().form!);
  });
  return cancelled;
}

describe("the site-day picker", () => {
  it("links to the previous and next day the model gives", async () => {
    await picker();
    expect(link("Previous day")?.getAttribute("href")).toBe(`${DAY_HREF}?date=2026-11-04`);
    expect(link("Next day")?.getAttribute("href")).toBe(`${DAY_HREF}?date=2026-11-06`);
  });

  it("uses the model's hrefs as given, across a year boundary", async () => {
    await picker("2026-01-01", "2026-01-07");
    expect(link("Previous day")?.getAttribute("href")).toBe(`${DAY_HREF}?date=2025-12-31`);
    expect(link("Next day")?.getAttribute("href")).toBe(`${DAY_HREF}?date=2026-01-02`);
  });

  it("offers a Today link on a past day", async () => {
    await picker();
    expect(link("Today")?.getAttribute("href")).toBe(`${DAY_HREF}?date=${TODAY}`);
  });

  it("offers the next day when it is today", async () => {
    await picker("2026-11-06", TODAY);
    expect(link("Next day")?.getAttribute("href")).toBe(`${DAY_HREF}?date=${TODAY}`);
  });

  it("has no next-day link on today, only a placeholder for the eye", async () => {
    await picker(TODAY, TODAY);
    expect(link("Next day")).toBeNull();
    const placeholder = [...document.querySelectorAll('[aria-hidden="true"]')].find((el) => el.textContent === "→");
    expect(placeholder?.tagName).toBe("SPAN");
    expect(placeholder?.className).toContain("gt:pointer-events-none");
  });

  it("has no Today link on today", async () => {
    await picker(TODAY, TODAY);
    expect(link("Today")).toBeNull();
  });

  it("shows the day as a heading", async () => {
    await picker();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Thu, 05 Nov 2026");
  });

  it("names the date box, requires it, caps it at today and shows the day", async () => {
    await picker();
    const input = dayInput();
    expect(input.name).toBe("date");
    expect(input.type).toBe("date");
    expect(input.required).toBe(true);
    expect(input.max).toBe(TODAY);
    expect(input.value).toBe(DATE);
  });

  it("is a form with no action, submitted with a Show button inside it", async () => {
    await picker();
    const form = dayInput().form!;
    expect(form.hasAttribute("action")).toBe(false);
    const show = screen.getByRole("button", { name: "Show" });
    expect(show.getAttribute("type")).toBe("submit");
    expect(form.contains(show)).toBe(true);
  });

  it("navigates once to the chosen day as ?date= on submit", async () => {
    const log = await picker();
    fireEvent.change(dayInput(), { target: { value: "2026-11-03" } });
    expect(await submit()).toBe(true);
    expect(log.navigate).toEqual([`${DAY_HREF}?date=2026-11-03`]);
    expect(log.refresh).toBe(0);
  });

  it("does not navigate when a day is typed", async () => {
    const log = await picker();
    fireEvent.change(dayInput(), { target: { value: "2026-11-03" } });
    fireEvent.input(dayInput(), { target: { value: "2026-11-02" } });
    expect(log.navigate).toEqual([]);
  });

  it("refuses a date after today or a malformed one, and says why", async () => {
    const log = await picker();
    for (const value of ["2026-11-08", "2026-1-3", ""]) {
      fireEvent.change(dayInput(), { target: { value } });
      expect(await submit()).toBe(true);
    }
    expect(log.navigate).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("Choose a day up to today.");
    expect(dayInput().getAttribute("aria-invalid")).toBe("true");
  });

  it("reads the day shown again when it is submitted", async () => {
    const log = await picker(TODAY, TODAY);
    expect(await submit()).toBe(true);
    expect(log.navigate).toEqual([]);
    expect(log.refresh).toBe(1);
  });

  it("draws a step whose link is not a page as a placeholder", async () => {
    await picker(DATE, TODAY, [{ id: "metering.day-previous", label: "Previous day", href: "sms:+10000000000" }]);
    expect(link("Previous day")).toBeNull();
    expect(document.body.textContent).not.toContain("Previous day");
  });

  it("resets the date box to the new day when the day changes", async () => {
    function Switching() {
      const [ext, setExt] = useState(extOf(DATE, TODAY));
      return (
        <>
          <DayPicker ext={ext} links={dayLinks(ext.date, TODAY)} heading={ext.date} kit={kit} />
          <button type="button" onClick={() => setExt(extOf("2026-11-06", TODAY))}>
            Switch day
          </button>
        </>
      );
    }
    unmount = (await renderInKit(<Switching />)).unmount;
    fireEvent.change(dayInput(), { target: { value: "2026-11-01" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch day" })));
    expect(dayInput().value).toBe("2026-11-06");
  });
});

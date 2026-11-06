// day-picker.test.tsx — the day switcher on the Operations tab.
//
// Covers:
//   - previous / next day links, and the Today shortcut
//   - no next day and no Today link when the day shown is today
//   - the date box is a plain GET form to the base path: a required
//     `date` input capped at today, submitted with a Show button. Typing a
//     date navigates nothing until the form is submitted, and the router is
//     never used.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => React.createElement("a", { href, className, ...rest }, children),
}));

vi.mock("@/components/format/locale-context", () => ({
  useLocale: () => ({ locale: "en-UG", currency: "UGX" }),
  LocaleProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { DayPicker } from "../day-picker";

const BASE = "/microgrids/mg-1/operations";
const TODAY = "2026-11-07";

function dayInput(): HTMLInputElement {
  return screen.getByLabelText("Day") as HTMLInputElement;
}

beforeEach(() => {
  pushMock.mockClear();
});

describe("DayPicker", () => {
  it("links to the previous and next day", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    expect(screen.getByRole("link", { name: "Previous day" }).getAttribute("href")).toBe(
      `${BASE}?date=2026-11-04`,
    );
    expect(screen.getByRole("link", { name: "Next day" }).getAttribute("href")).toBe(
      `${BASE}?date=2026-11-06`,
    );
  });

  it("crosses month and year boundaries", () => {
    render(<DayPicker basePath={BASE} date="2026-01-01" today={TODAY} />);
    expect(screen.getByRole("link", { name: "Previous day" }).getAttribute("href")).toBe(
      `${BASE}?date=2025-12-31`,
    );
    expect(screen.getByRole("link", { name: "Next day" }).getAttribute("href")).toBe(
      `${BASE}?date=2026-01-02`,
    );
  });

  it("offers a Today link on a past day", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    expect(screen.getByRole("link", { name: "Today" }).getAttribute("href")).toBe(
      `${BASE}?date=${TODAY}`,
    );
  });

  it("offers the next day when it is today", () => {
    render(<DayPicker basePath={BASE} date="2026-11-06" today={TODAY} />);
    expect(screen.getByRole("link", { name: "Next day" }).getAttribute("href")).toBe(
      `${BASE}?date=${TODAY}`,
    );
  });

  it("has no next-day link on today, only a disabled placeholder", () => {
    const { container } = render(<DayPicker basePath={BASE} date={TODAY} today={TODAY} />);
    expect(screen.queryByRole("link", { name: "Next day" })).toBeNull();
    // No link leads past today.
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toBe(`${BASE}?date=2026-11-08`);
    }
    const placeholder = container.querySelector('span[aria-hidden="true"]');
    expect(placeholder?.textContent).toBe("→");
    expect(placeholder?.className).toContain("pointer-events-none");
  });

  it("has no Today link on today", () => {
    render(<DayPicker basePath={BASE} date={TODAY} today={TODAY} />);
    expect(screen.queryByRole("link", { name: "Today" })).toBeNull();
    // The previous day is still offered.
    expect(screen.getByRole("link", { name: "Previous day" }).getAttribute("href")).toBe(
      `${BASE}?date=2026-11-06`,
    );
  });

  it("shows the day as a heading", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    const heading = screen.getByRole("heading", { level: 2 }).textContent ?? "";
    expect(heading).toContain("2026");
    expect(heading).toContain("05");
    expect(heading).toMatch(/Nov/);
    expect(heading).toMatch(/Thu/);
  });

  it("caps the date input at today and shows the day", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    expect(dayInput().getAttribute("type")).toBe("date");
    expect(dayInput().getAttribute("max")).toBe(TODAY);
    expect(dayInput().value).toBe("2026-11-05");
  });

  it("is a GET form to the base path", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    const form = dayInput().form;
    expect(form).not.toBeNull();
    expect(form!.getAttribute("action")).toBe(BASE);
    expect(form!.getAttribute("method")).toBe("get");
  });

  it("names the input date, requires it and defaults it to the day shown", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    const input = dayInput();
    expect(input.getAttribute("name")).toBe("date");
    expect(input.required).toBe(true);
    expect(input.defaultValue).toBe("2026-11-05");
    expect(input.getAttribute("max")).toBe(TODAY);
  });

  it("submits with a Show button inside the form", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    const button = screen.getByRole("button", { name: "Show" }) as HTMLButtonElement;
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.form).toBe(dayInput().form);
  });

  it("serialises the chosen day as ?date= on submit", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    fireEvent.change(dayInput(), { target: { value: "2026-10-20" } });
    const data = new FormData(dayInput().form!);
    expect(Array.from(data.entries())).toEqual([["date", "2026-10-20"]]);
  });

  it("does not navigate when a day is typed", () => {
    render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    fireEvent.change(dayInput(), { target: { value: "2026-10-20" } });
    fireEvent.change(dayInput(), { target: { value: "" } });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("resets the input to the new day when the day changes", () => {
    const { rerender } = render(<DayPicker basePath={BASE} date="2026-11-05" today={TODAY} />);
    fireEvent.change(dayInput(), { target: { value: "2026-10-20" } });
    rerender(<DayPicker basePath={BASE} date="2026-11-04" today={TODAY} />);
    expect(dayInput().value).toBe("2026-11-04");
  });
});

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Chip } from "../chip";

describe("Chip", () => {
  it("renders bg-success-muted and text-success-fg for tone='success'", () => {
    const { container } = render(<Chip tone="success" dot>Test</Chip>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("bg-success-muted");
    expect(span?.className).toContain("text-success-fg");
  });

  // cn() keeps both a type-scale size and a text colour only because
  // TYPE_SCALE in src/lib/utils.ts lists the size. Without it tailwind-merge
  // reads text-caption as a colour and keeps whichever comes last: md chips
  // lose their size and sm chips lose their colour.
  const TONE_FG = {
    neutral: "text-muted-foreground",
    success: "text-success-fg",
    warn: "text-warning-fg",
    alert: "text-destructive-fg",
    brand: "text-accent-foreground",
  } as const;

  it.each(Object.keys(TONE_FG) as (keyof typeof TONE_FG)[])(
    "keeps the caption size and the %s tone's text colour together",
    (tone) => {
      for (const size of ["sm", "md"] as const) {
        const { container } = render(<Chip tone={tone} size={size}>Test</Chip>);
        expect(container.querySelector("span")?.className.split(/\s+/)).toEqual(
          expect.arrayContaining(["text-caption", TONE_FG[tone]]),
        );
      }
    },
  );

  it("dot span has aria-hidden='true'", () => {
    const { container } = render(<Chip tone="success" dot>Test</Chip>);
    const dotSpan = container.querySelector("span > span[aria-hidden='true']");
    expect(dotSpan).not.toBeNull();
    expect(dotSpan?.getAttribute("aria-hidden")).toBe("true");
  });

  it("forwards aria-label prop", () => {
    const { container } = render(
      <Chip tone="neutral" aria-label="Custom label">Test</Chip>
    );
    const span = container.querySelector("span");
    expect(span?.getAttribute("aria-label")).toBe("Custom label");
  });
});

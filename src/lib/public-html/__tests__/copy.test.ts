import { describe, expect, it } from "vitest";
import { PUBLIC_COPY, PUBLIC_LANGUAGES, pickPublicLanguage } from "../copy";

/** Every string in a copy entry, with its path. */
function strings(value: unknown, at: string): [string, string][] {
  if (typeof value === "string") return [[at, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => strings(child, `${at}.${key}`));
}

describe("public page copy", () => {
  it("has copy for exactly the languages it lists, English first", () => {
    expect(PUBLIC_LANGUAGES[0]).toBe("en");
    expect(Object.keys(PUBLIC_COPY).sort()).toEqual([...PUBLIC_LANGUAGES].sort());
  });

  it("has no empty or padded string in any language", () => {
    for (const lang of PUBLIC_LANGUAGES) {
      for (const [at, text] of strings(PUBLIC_COPY[lang], lang)) {
        expect(text.trim(), at).toBe(text);
        expect(text, at).not.toBe("");
      }
    }
  });

  it("names the product Microgrid Manager", () => {
    expect(PUBLIC_COPY.en.productName).toBe("Microgrid Manager");
  });

  it("has one {seconds} in every form of the wait sentence, and an `other` form", () => {
    for (const lang of PUBLIC_LANGUAGES) {
      const forms: Record<string, string> = PUBLIC_COPY[lang].paymentLink.tooManyTries.body;
      expect(Object.keys(forms), lang).toContain("other");
      for (const [form, text] of Object.entries(forms)) {
        expect(text.split("{seconds}").length - 1, `${lang}.${form}`).toBe(1);
      }
    }
  });

  it("has no {placeholder} outside the wait sentence", () => {
    for (const lang of PUBLIC_LANGUAGES) {
      for (const [at, text] of strings(PUBLIC_COPY[lang], lang)) {
        if (at.startsWith(`${lang}.paymentLink.tooManyTries.body.`)) continue;
        expect(text, at).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("pickPublicLanguage", () => {
  it.each([
    [null, "en"],
    ["", "en"],
    ["en-UG,en;q=0.9", "en"],
    ["lg-UG,sw;q=0.8", "en"],
    ["EN-us", "en"],
    ["*", "en"],
  ])("answers %j in %s", (header, lang) => {
    expect(pickPublicLanguage(header)).toBe(lang);
  });
});

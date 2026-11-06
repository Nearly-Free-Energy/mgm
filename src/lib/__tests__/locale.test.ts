import { describe, it, expect } from "vitest";
import { detectLocale, pickLanguage } from "../locale";

describe("detectLocale", () => {
  it("returns 'en' for null", () => {
    expect(detectLocale(null)).toBe("en");
  });

  it("returns 'en' for empty string", () => {
    expect(detectLocale("")).toBe("en");
  });

  it("returns 'en' for 'en'", () => {
    expect(detectLocale("en")).toBe("en");
  });

  it("returns 'en-US' for 'en-US'", () => {
    expect(detectLocale("en-US")).toBe("en-US");
  });

  it("returns 'en-US' for 'en-US,en;q=0.9'", () => {
    expect(detectLocale("en-US,en;q=0.9")).toBe("en-US");
  });

  it("returns 'en-US' for 'en-US;q=0.9,en;q=0.8'", () => {
    expect(detectLocale("en-US;q=0.9,en;q=0.8")).toBe("en-US");
  });

  it("returns 'fr-FR' for 'fr-FR,fr;q=0.9,en;q=0.8'", () => {
    expect(detectLocale("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr-FR");
  });
});

describe("pickLanguage", () => {
  const EN = ["en"] as const;
  const EN_LG = ["en", "lg"] as const;

  it.each([null, "", "   ", ","])("answers in the first supported language for %j", (header) => {
    expect(pickLanguage(header, EN_LG)).toBe("en");
  });

  it("takes the highest q first, matching a regional tag on its primary subtag", () => {
    expect(pickLanguage("lg-UG,lg;q=0.9,en;q=0.8", EN_LG)).toBe("lg");
    expect(pickLanguage("en;q=0.4,lg-UG;q=0.6", EN_LG)).toBe("lg");
  });

  it("keeps the header's order between equal weights", () => {
    expect(pickLanguage("lg,en", EN_LG)).toBe("lg");
    expect(pickLanguage("en,lg", EN_LG)).toBe("en");
    expect(pickLanguage("lg;q=0.5,en;q=0.5", EN_LG)).toBe("lg");
  });

  it("skips languages it has no copy for", () => {
    expect(pickLanguage("fr;q=1,en;q=0.5", EN)).toBe("en");
    expect(pickLanguage("fr-FR,de", EN_LG)).toBe("en");
  });

  it("drops an entry the header refuses with q=0", () => {
    expect(pickLanguage("en;q=0,lg", EN_LG)).toBe("lg");
    expect(pickLanguage("lg;q=0.000", EN_LG)).toBe("en");
  });

  it("ignores the wildcard", () => {
    expect(pickLanguage("*", EN_LG)).toBe("en");
    expect(pickLanguage("*,lg;q=0.5", EN_LG)).toBe("lg");
  });

  it("matches without regard to case and returns the supported spelling", () => {
    expect(pickLanguage("LG-ug", EN_LG)).toBe("lg");
    expect(pickLanguage("EN", ["en-GB", "en"] as const)).toBe("en");
    expect(pickLanguage("en-gb", ["en", "en-GB"] as const)).toBe("en-GB");
  });

  it("prefers a whole-tag match to a primary-subtag match in the same entry", () => {
    expect(pickLanguage("en-GB", ["en", "en-GB"] as const)).toBe("en-GB");
  });

  it.each(["lg;q=2", "lg;q=abc", "lg;q=0.5555", "lg;q = 0.5", "lg;q=", "lg;q=-1"])(
    "drops an entry with an unreadable weight: %s",
    (header) => {
      expect(pickLanguage(header, EN_LG)).toBe("en");
    },
  );

  // Each tag starts with "lg-", so read as a tag it would match lg on its
  // primary subtag and win over the lower-weighted en.
  it.each(["lg-", "lg--UG", "lg-<UG>", "lg-U G", "lg-UG_x", "lg-ÜG", "lg-toolongsubtag"])(
    "drops a malformed tag: %j",
    (tag) => {
      expect(pickLanguage(`${tag},en;q=0.1`, ["lg", "en"] as const)).toBe("en");
    },
  );

  it("ignores parameters other than q and spaces around entries", () => {
    expect(pickLanguage(" en ; foo=bar ; q=0.2 ,  lg ; q=0.9 ", EN_LG)).toBe("lg");
  });
});

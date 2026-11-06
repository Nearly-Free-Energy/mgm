// locale.ts — server-side Accept-Language header parsers.
//
// detectLocale's contract (pickLanguage, below, has its own):
//   - Split on ',' to get preference entries; take the first.
//   - Split that on ';' to strip q= weight parameters.
//   - Trim whitespace.
//   - Fall back to 'en' if input is null, empty, or parsing yields empty string.

export function detectLocale(acceptLanguage: string | null): string {
  if (!acceptLanguage) return "en";
  const first = acceptLanguage.split(",")[0];
  if (!first) return "en";
  const tag = first.split(";")[0]?.trim();
  return tag || "en";
}

const LANGUAGE_TAG = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i;
const QUALITY = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i;

/**
 * The language to answer in, from the ones `supported` lists.
 *
 * Reads the header's entries in q order (q defaults to 1; ties keep the
 * header's order) and returns the first supported language an entry names,
 * matching the whole tag or else its primary subtag (`lg-UG` matches `lg`),
 * ignoring case. The supported spelling is returned. Entries with `q=0`, an
 * unreadable q or a malformed tag are ignored, and so is `*`. When no entry
 * matches, or there is no header, the answer is `supported[0]`.
 *
 * Unlike detectLocale, which keeps the first tag whatever it is, this only
 * ever returns one of `supported`.
 */
export function pickLanguage<T extends string>(
  acceptLanguage: string | null,
  supported: readonly [T, ...T[]],
): T {
  const fallback = supported[0];
  if (!acceptLanguage) return fallback;

  const entries: { tag: string; q: number }[] = [];
  for (const part of acceptLanguage.split(",")) {
    const [rawTag, ...params] = part.split(";").map((p) => p.trim());
    if (!rawTag || rawTag === "*" || !LANGUAGE_TAG.test(rawTag)) continue;
    let q = 1;
    const qParam = params.find((p) => /^q\s*=/i.test(p));
    if (qParam !== undefined) {
      const m = QUALITY.exec(qParam);
      if (!m) continue;
      q = Number(m[1]);
    }
    if (q <= 0) continue;
    entries.push({ tag: rawTag.toLowerCase(), q });
  }
  // Array.prototype.sort is stable, so equal weights keep the header's order.
  entries.sort((a, b) => b.q - a.q);

  for (const { tag } of entries) {
    const primary = tag.split("-")[0];
    const match =
      supported.find((lang) => lang.toLowerCase() === tag) ??
      supported.find((lang) => lang.toLowerCase() === primary);
    if (match !== undefined) return match;
  }
  return fallback;
}

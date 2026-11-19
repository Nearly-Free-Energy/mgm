/**
 * Class helpers for these tests: an element's class tokens, and the text
 * colour classes among them. A text colour is a gt:text- class that is not
 * a size from the type scale or an alignment, with no variant before it.
 */
export const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const NOT_COLOUR = new Set([
  "caption", "dense", "body", "title", "headline", "kpi",
  "xs", "sm", "base", "lg", "xl", "2xl",
  "start", "end", "left", "right", "center", "justify",
  "wrap", "nowrap", "balance", "pretty", "ellipsis", "clip",
]);

export const colourClasses = (el: Element) =>
  tokens(el).filter((t) => {
    const m = /^gt:text-([\w-]+(?:\/\d+)?)$/.exec(t);
    return m !== null && !NOT_COLOUR.has(m[1]);
  });

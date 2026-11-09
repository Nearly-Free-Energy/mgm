/**
 * Whether a GUI contract version falls in a GUI's declared range.
 *
 * Only caret ranges are accepted, "^MAJOR.MINOR" or "^MAJOR.MINOR.PATCH",
 * with npm's caret semantics: the leftmost non-zero part may not change.
 * "^1.2" is >=1.2.0 <2.0.0, "^0.1" is >=0.1.0 <0.2.0, "^0.0.3" is exactly
 * 0.0.3 and "^0.0" is >=0.0.0 <0.1.0. Any other syntax throws.
 */

/** A caret range. GuiMeta.contract is checked against this same expression. */
export const CARET_RANGE_RE = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type Triple = readonly [number, number, number];

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The inclusive lower and exclusive upper bound of a caret range. */
export function parseCaretRange(range: string): { min: Triple; below: Triple } {
  const m = CARET_RANGE_RE.exec(range);
  if (!m) throw new Error(`Unsupported contract range "${range}": use a caret range such as "^0.1"`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const patch = m[3] === undefined ? undefined : Number(m[3]);
  const min: Triple = [major, minor, patch ?? 0];
  if (major > 0) return { min, below: [major + 1, 0, 0] };
  if (minor > 0 || patch === undefined) return { min, below: [0, minor + 1, 0] };
  return { min, below: [0, 0, patch + 1] };
}

export function satisfiesContract(version: string, range: string): boolean {
  const v = VERSION_RE.exec(version);
  if (!v) throw new Error(`Not a contract version: "${version}"`);
  const triple: Triple = [Number(v[1]), Number(v[2]), Number(v[3])];
  const { min, below } = parseCaretRange(range);
  return compare(triple, min) >= 0 && compare(triple, below) < 0;
}

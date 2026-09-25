/**
 * Pure assignment-gap computation shared by the metering capability and
 * server-rendered history surfaces (issue #4).
 *
 * Entries must carry effectiveFrom/effectiveTo date strings (YYYY-MM-DD).
 * A gap is reported when consecutive links leave days uncovered, or when an
 * open-ended link is followed by a newer one (missing replacement-boundary
 * evidence). Sorted output; the input order does not matter.
 */
export type DatedLink = {
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type AssignmentGap = {
  from: string;
  to: string | null;
};

export function computeAssignmentGaps<T extends DatedLink>(links: T[]): {
  sorted: T[];
  gaps: AssignmentGap[];
} {
  const sorted = [...links].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom
      ? -1
      : a.effectiveFrom > b.effectiveFrom
        ? 1
        : 0
  );
  const gaps: AssignmentGap[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current.effectiveTo === null) {
      gaps.push({ from: current.effectiveFrom, to: next.effectiveFrom });
    } else if (current.effectiveTo < next.effectiveFrom) {
      gaps.push({ from: current.effectiveTo, to: next.effectiveFrom });
    }
  }
  return { sorted, gaps };
}

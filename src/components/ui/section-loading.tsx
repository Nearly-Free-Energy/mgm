// SectionLoading — generic route-level loading frame for loading.tsx files.
//
// A deliberately unspecific frame (optional breadcrumb row + two content
// cards): a loading.tsx wraps every child route of its folder, so a
// page-shaped skeleton would flash the wrong frame on its siblings (pr-375
// review). Routes that need a precise frame keep their own loading.tsx
// (e.g. the billing period detail).
//
// Accessibility: single role="status" announcer; all blocks decorative
// (LoadingSkeleton is aria-hidden).

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";

export function SectionLoading({
  label,
  breadcrumb = true,
}: {
  /** What is loading, as read out: "Loading <label>…". */
  label: string;
  /** Show the breadcrumb row; off where the pages below have none. */
  breadcrumb?: boolean;
}) {
  return (
    <div role="status" aria-label={`Loading ${label}`} aria-busy="true" className="space-y-4">
      <span className="sr-only">{`Loading ${label}…`}</span>

      {/* Breadcrumb row */}
      {breadcrumb && (
        <div className="flex gap-1">
          <LoadingSkeleton className="h-9 w-36" />
          <LoadingSkeleton className="h-9 w-28" />
        </div>
      )}

      {/* Generic content cards */}
      <div aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
        <LoadingSkeleton className="mb-2 h-3 w-24" />
        <LoadingSkeleton className="h-8 w-full" />
      </div>
      <div aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
        <LoadingSkeleton className="mb-2 h-3 w-32" />
        <div className="space-y-2">
          <LoadingSkeleton className="h-5 w-full" />
          <LoadingSkeleton className="h-5 w-11/12" />
          <LoadingSkeleton className="h-5 w-4/5" />
        </div>
      </div>
    </div>
  );
}

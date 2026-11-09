// StatusChip — thin semantic wrapper over <Chip>.
//
// Why: callers don't need to remember which tone maps to "draft" vs
// "closed". The domain status enums (billing period status, edge status,
// household status, meter type) live in ONE PLACE,
// src/lib/gui/status-maps.ts; add new ones there.
//
// Pattern: <StatusChip kind="billingPeriod" status="draft" /> —
// renders the right tone + label + dot + aria-label.

import * as React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Chip, type ChipProps } from "./chip";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/gui/contract";
import { statusEntry, type StatusKind } from "@/lib/gui/status-maps";

// The labels and tones live in src/lib/gui/status-maps.ts, which the server
// also serves to GUIs. Chip names its tones differently; CHIP_TONE maps them.
const CHIP_TONE: Record<Tone, NonNullable<ChipProps["tone"]>> = {
  neutral: "neutral",
  info: "neutral", // Chip has no info tone; if it gains one, map info to it
  success: "success",
  warning: "warn",
  danger: "alert",
  accent: "brand",
};

export interface StatusChipProps extends Omit<ChipProps, "tone" | "children" | "dot"> {
  kind: StatusKind;
  status: string;
  /**
   * Optional tooltip content. When supplied, the chip is wrapped in a
   * Radix Tooltip (hover + keyboard focus). Added in #102 for the OpenEMS
   * Backend health chip (tab-label chip) where the long explanation
   * wouldn't fit inline. The summary-card health chip reads the info from
   * its surrounding text so callers don't need to duplicate the copy.
   */
  tooltip?: React.ReactNode;
}

export function StatusChip({ kind, status, tooltip, ...props }: StatusChipProps) {
  const entry = statusEntry(kind, status);

  const chip = !entry ? (
    // Unknown status — fail loudly in dev, fall back to neutral chip.
    (() => {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`StatusChip: unknown status "${status}" for kind "${kind}".`);
      }
      return (
        <Chip tone="neutral" aria-label={`${kind}: ${status}`} {...props}>
          {status}
        </Chip>
      );
    })()
  ) : (
    <Chip
      tone={CHIP_TONE[entry.tone]}
      dot={entry.dot}
      aria-label={`${kind} status: ${entry.label.toLowerCase()}`}
      {...props}
    >
      {entry.label}
    </Chip>
  );

  if (!tooltip) return chip;

  // Wrap in Radix Tooltip. Caller is responsible for providing a
  // TooltipProvider at or near the app root; we inline one here as a
  // defensive default so single-use sites (the tab chip) don't need to
  // refactor the layout tree. Radix Providers nest safely.
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {/* Wrap in a focusable span so keyboard users get the tooltip.
              tabIndex=0 makes the chip focusable without turning it into
              a button (preserves non-interactive semantics). */}
          <span tabIndex={0} className="inline-flex cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {chip}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className={cn(
              "z-50 max-w-xs rounded-md bg-foreground px-3 py-2 text-caption leading-snug text-background shadow-elev-2",
              "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out"
            )}
          >
            {tooltip}
            <Tooltip.Arrow className="fill-foreground" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

"use client";

// SelectionDialog — multi-row selection dialog primitive.
//
// Added in #103 for the Add Edge (Discover → multi-select) flow. Sibling to
// <ConfirmDialog> (decision-shaped). Contract differences from ConfirmDialog:
//   • role="dialog" (not alertdialog) — selection is a task, not an alert.
//   • NO tone rail at the top.
//   • NO cancel-first focus priority — callers own focus via onOpenAutoFocus
//     or by focusing within `body` once mounted.
//   • NO typed-confirmation input, NO single onConfirm promise — the caller
//     owns the state machine (discovering / list / empty / error / adding)
//     and composes body + footer slots.
//   • Fixed body dimensions (min-h-[280px] max-h-[70vh] + 560px width) so
//     the dialog does NOT resize across states. List content scrolls inside.
//     Under 600px wide the body caps at 55% of the visible height instead,
//     so the title, the list and the footer all fit on a phone's sheet.
//   • The panel is a flex column, and only the body may shrink: on a short
//     window, such as 1280 x 700, the body gives up the height the panel's
//     cap leaves no room for, down to its 280px floor. The list is then the
//     only thing that scrolls, instead of the list inside a panel that
//     scrolls as well.
//   • `locked` prop disables Esc + backdrop-click dismissal (used during
//     the in-flight "adding" window to prevent mid-submit dismiss).
//   • aria-describedby points at a body region with aria-live="polite" so
//     state transitions are announced to screen readers.

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { DialogFooter, DialogOverlay, DialogPanel } from "@/components/ui/dialog";

export interface SelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Short plain-string title announced to screen readers. */
  title: string;
  /** Optional short description; rendered under the title as muted text. */
  description?: string;
  /**
   * When true, Esc and backdrop-click no longer dismiss the dialog. Used
   * by AddEdgeDialog during the "adding" in-flight state so the user can't
   * mid-submit dismiss.
   */
  locked?: boolean;
  /** Body content — owns its own scrolling via min-h / max-h clamp. */
  children: React.ReactNode;
  /** Right-aligned footer. Caller supplies Cancel + primary action buttons. */
  footer: React.ReactNode;
  /**
   * Optional override for the initial-focus target. When supplied, the
   * supplied function runs inside Radix Dialog's onOpenAutoFocus; the
   * caller is expected to call event.preventDefault() and focus whatever
   * they want imperatively. (Default: Radix default focus behavior.)
   */
  onOpenAutoFocus?: (event: Event) => void;
}

// Stable ids for a11y wiring (aria-labelledby / aria-describedby).
const TITLE_ID = "selection-dialog-title";
const DESC_ID = "selection-dialog-desc";
const BODY_ID = "selection-dialog-body";

export function SelectionDialog({
  open,
  onOpenChange,
  title,
  description,
  locked = false,
  children,
  footer,
  onOpenAutoFocus,
}: SelectionDialogProps) {
  const describedByIds = [description ? DESC_ID : null, BODY_ID]
    .filter(Boolean)
    .join(" ");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay />
        <DialogPanel
          role="dialog"
          aria-labelledby={TITLE_ID}
          aria-describedby={describedByIds || undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onEscapeKeyDown={(e) => {
            if (locked) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (locked) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (locked) e.preventDefault();
          }}
          className="flex w-[560px] flex-col"
        >
          <div className="shrink-0 px-6 pb-2 pt-5">
            <Dialog.Title
              id={TITLE_ID}
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description
                id={DESC_ID}
                className="mt-1 text-[13px] leading-relaxed text-muted-foreground"
              >
                {description}
              </Dialog.Description>
            )}
          </div>

          {/* Body — fixed dimensions, scrolls internally. aria-live="polite"
              announces state transitions to screen readers (list → empty,
              list → error, etc.). */}
          <div
            id={BODY_ID}
            aria-live="polite"
            className="min-h-[280px] max-h-[70vh] overflow-y-auto px-6 pb-2 text-[13px] leading-relaxed text-foreground max-[600px]:max-h-[55vh] max-[600px]:supports-[height:100dvh]:max-h-[55dvh]"
          >
            {children}
          </div>

          <DialogFooter className="mt-2 shrink-0">{footer}</DialogFooter>
        </DialogPanel>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

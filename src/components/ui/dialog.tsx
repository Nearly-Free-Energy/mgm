"use client";

// Dialog frame — the overlay, panel and decision row every modal in the app
// is built from. Callers keep `Dialog.Root`, `Dialog.Portal`, `Dialog.Title`,
// `Dialog.Description` and `Dialog.Close` from Radix and swap only the
// overlay, the content element and the footer row:
//
//   <Dialog.Root open={open} onOpenChange={onOpenChange}>
//     <Dialog.Portal>
//       <DialogOverlay />
//       <DialogPanel className="w-[480px]">
//         …title, body…
//         <DialogFooter className="mt-4">…Cancel, Confirm…</DialogFooter>
//       </DialogPanel>
//     </Dialog.Portal>
//   </Dialog.Root>
//
// What the frame does:
//   • From 600px wide: a centred card, at most 90% of the visible height
//     (`dvh`, so a phone's browser toolbar does not hide its bottom edge).
//     Taller content scrolls inside the card.
//   • Under 600px: a full-width sheet anchored to the bottom of the screen,
//     at most 92% of the visible height, content scrolling inside it.
//   • The footer is `sticky bottom-0` inside the scrolling panel, so the
//     Cancel and Confirm buttons stay on screen however long the body is.
//     It works whether the footer is a direct child of the panel or the
//     last child of a <form> that spans the panel.
//
// Callers set only the desktop width (`w-[NNNpx]`) and their own padding.
// They must not pass `overflow-*`, `max-h-*` or `shadow-*` to the panel:
// `cn()` (tailwind-merge) keeps the caller's class and drops the frame's,
// so `overflow-hidden` would silently turn the scrolling off again. That
// holds while `cn()` merges conflicting utilities; if it stops doing so,
// the guard in src/lib/__tests__/dialog-frame.test.ts can be relaxed.

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

const OVERLAY_CLASSES =
  "fixed inset-0 z-50 bg-foreground/55 data-[state=open]:animate-in data-[state=closed]:animate-out";

const PANEL_CLASSES = [
  // Centred card from 600px up.
  "fixed left-1/2 top-1/2 z-50 max-w-[94%] -translate-x-1/2 -translate-y-1/2",
  "max-h-[90dvh] overflow-y-auto overscroll-contain",
  // A field reached with Tab, or focused on open, scrolls clear of the
  // pinned footer instead of stopping underneath it. 6rem (96px) covers the
  // footer's 64px row of 32px buttons, or Close period's two rows on a
  // phone; if the footer's buttons grow taller, raise it to match.
  "scroll-pb-24",
  "rounded-md border border-border bg-card shadow-elev-3 outline-none",
  // Bottom sheet under 600px.
  "max-[600px]:left-0 max-[600px]:right-0 max-[600px]:top-auto max-[600px]:bottom-0",
  "max-[600px]:w-full max-[600px]:max-w-none max-[600px]:max-h-[92dvh]",
  "max-[600px]:translate-x-0 max-[600px]:translate-y-0",
  "max-[600px]:rounded-b-none max-[600px]:border-x-0 max-[600px]:border-b-0",
].join(" ");

// The bottom padding grows to the device's safe area under 600px, so the
// buttons sit above a phone's home indicator. env(safe-area-inset-bottom)
// is 0 until the root layout's viewport sets viewport-fit=cover, which
// src/app/layout.tsx does not do today; max() then keeps the usual 18px.
const FOOTER_CLASSES = [
  "sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]",
  "max-[600px]:pb-[max(18px,env(safe-area-inset-bottom))]",
].join(" ");

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(OVERLAY_CLASSES, className)}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

/**
 * The dialog's content element (Radix `Dialog.Content`). `aria-modal` is on
 * by default; callers pass `role`, focus and dismiss handlers, test ids and
 * their desktop width as they would to `Dialog.Content`.
 */
const DialogPanel = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Content
    ref={ref}
    aria-modal
    className={cn(PANEL_CLASSES, className)}
    {...props}
  />
));
DialogPanel.displayName = "DialogPanel";

/** The decision row: Cancel and the primary action, pinned to the bottom. */
const DialogFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(FOOTER_CLASSES, className)} {...props} />
));
DialogFooter.displayName = "DialogFooter";

export { DialogOverlay, DialogPanel, DialogFooter };

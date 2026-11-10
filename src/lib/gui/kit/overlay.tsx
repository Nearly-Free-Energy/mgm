"use client";

/**
 * The kit's frame for the action host's steps, on the app's dialog frame
 * (src/components/ui/dialog.tsx): a centred card from 600 px, a bottom sheet
 * under it, capped at the visible height, with Esc and the focus trap from
 * Radix. It has no footer of its own: the steps (ConfirmStep, ActionForm) end
 * in DialogFooter, which is pinned and carries the safe-area padding
 * (dialog.tsx); if a step stops using it, that step's buttons are no longer
 * pinned. The host uses it when the GUI brings no Overlay, and a GUI may use
 * it as its own.
 *
 * Like any Overlay it frames only what it is given: the host's empty slot,
 * into which the host portals the step (OverlayProps in ../contract.ts).
 */
import * as Dialog from "@radix-ui/react-dialog";
import { DialogOverlay, DialogPanel } from "@/components/ui/dialog";
import type { OverlayProps } from "../contract";

export function Overlay({ title, tone, role, onDismiss, children }: OverlayProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onDismiss()}>
      <Dialog.Portal>
        <DialogOverlay />
        <DialogPanel role={role === "confirm" ? "alertdialog" : "dialog"} aria-describedby={undefined} className="w-[480px]">
          <div aria-hidden="true" className={tone === "danger" ? "h-[6px] bg-destructive" : "h-[6px] bg-primary"} />
          <Dialog.Title className="px-6 pt-5 text-xl font-semibold tracking-tight">{title}</Dialog.Title>
          {children}
        </DialogPanel>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

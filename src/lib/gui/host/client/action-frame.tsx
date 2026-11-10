"use client";

/**
 * What the action host shows when the GUI brings no frame or form of its own:
 * a dialog on the app's dialog frame, and a form that offers Cancel only.
 * Loaded on first use, so pages that never write do not carry them.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { DialogOverlay, DialogPanel } from "@/components/ui/dialog";
import type { FormProps, OverlayProps } from "../../contract";

export function HostOverlay({ title, tone, role, onDismiss, children }: OverlayProps) {
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

/** Until the interface or the kit offers a form for this action's fields. */
export function NoForm({ cancel }: FormProps) {
  return (
    <div className="flex flex-col gap-3 px-6 py-4 text-dense text-foreground">
      <p>This action needs a form this interface does not offer.</p>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={cancel}
          className="inline-flex min-h-8 items-center rounded-md px-3.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

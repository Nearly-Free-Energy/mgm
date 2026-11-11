/**
 * Gridtop's sheet: a Radix dialog that rises from the bottom edge below
 * 600 px and is a centred panel from 600 px. It copies the approach of the
 * app's dialog frame (src/components/ui/dialog.tsx), which an interface
 * package may not import (gui-boundary.test.ts, rule 6; if that rule admits
 * the frame, use it here instead): each height cap written in vh and again in dvh
 * where supported, the content scrolling inside, the title row pinned to
 * the top, and room for a phone's home indicator at the bottom.
 *
 * Radix traps focus inside, closes on Escape or a press outside, and puts
 * focus back on the trigger. The sheet is open for one pathname only, and
 * following a link inside it in the same tab closes it.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { kit } from "@/lib/gui/kit";
import { cx } from "./cx";

const OVERLAY = "gt:fixed gt:inset-0 gt:z-50 gt:bg-foreground/55";

const PANEL = cx(
  "gt:fixed gt:inset-x-0 gt:bottom-0 gt:z-50 gt:flex gt:flex-col gt:overflow-y-auto gt:overscroll-contain",
  "gt:max-h-[92vh] gt:supports-[height:100dvh]:max-h-[92dvh]",
  "gt:rounded-t-lg gt:border-t gt:border-border gt:bg-card gt:text-foreground gt:shadow-elev-3 gt:outline-none",
  "gt:pb-[env(safe-area-inset-bottom)]",
  // A centred panel from 600 px.
  "gt:medium:inset-x-auto gt:medium:bottom-auto gt:medium:top-1/2 gt:medium:left-1/2 gt:medium:w-md gt:medium:max-w-[94%]",
  "gt:medium:-translate-x-1/2 gt:medium:-translate-y-1/2 gt:medium:rounded-lg gt:medium:border gt:medium:pb-0",
  "gt:medium:max-h-[80vh] gt:medium:supports-[height:100dvh]:max-h-[80dvh]",
);

export const SHEET_ROW =
  "gt:flex gt:min-h-11 gt:w-full gt:items-center gt:gap-3 gt:rounded-md gt:px-3 gt:text-left gt:text-body gt:text-foreground " +
  "gt:hover:bg-muted gt:aria-[current=page]:bg-accent gt:aria-[current=page]:text-accent-foreground gt:data-pending:opacity-70 " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-offset-2 gt:focus-visible:outline-ring";

/** A plain left click, which follows a link in this tab; a modified one opens a new tab or window. */
const sameTab = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export function Sheet({ title, trigger, children }: { title: string; trigger: ReactElement; children: ReactNode }) {
  const pathname = kit.usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  // Forgotten once the page changes, so coming back does not reopen it.
  if (openOn !== null && openOn !== pathname) setOpenOn(null);
  return (
    <Dialog.Root open={openOn === pathname} onOpenChange={(open) => setOpenOn(open ? pathname : null)}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content aria-modal aria-describedby={undefined} className={PANEL}>
          <div className="gt:sticky gt:top-0 gt:z-10 gt:flex gt:items-center gt:gap-2 gt:border-b gt:border-border gt:bg-card gt:py-1 gt:pr-1 gt:pl-4">
            <Dialog.Title className="gt:min-w-0 gt:flex-1 gt:truncate gt:text-title gt:font-medium">{title}</Dialog.Title>
            <Dialog.Close className="gt:inline-flex gt:size-9 gt:shrink-0 gt:items-center gt:justify-center gt:rounded-md gt:text-muted-foreground gt:hover:bg-muted gt:hover:text-foreground gt:pointer-coarse:size-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring">
              <X aria-hidden="true" focusable="false" className="gt:size-5" />
              <span className="gt:sr-only">Close</span>
            </Dialog.Close>
          </div>
          {/* A link to the page already shown changes no pathname, so following any link closes the sheet too. */}
          <div className="gt:p-3" onClick={(event) => sameTab(event) && (event.target as Element).closest("a[href]") && setOpenOn(null)}>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

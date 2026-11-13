/**
 * The command palette: cmdk inside Gridtop's sheet, which rises from the
 * bottom below 600 px and is a centred dialog from 600 px. ./launcher.tsx
 * loads this module on first open, so cmdk is not in the first load.
 *
 * Nothing runs on its own. Choosing navigates through the kit, asks for a
 * place, or calls kit.act with the view's own ActionRef, so the host's form
 * and confirmation step run (decision 5 on #115).
 */
import { Command } from "cmdk";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { EntityHit, NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import type { Picked } from "../shell/pick-step";
import { TRAY_BUTTON } from "../shell/tray-parts";
import { cx } from "../ui/cx";
import { Sheet } from "../ui/sheet";
import { listing, pickListing, SEARCH_DELAY_MS, searchFor, type Choice } from "./grammar";

export const PALETTE_TITLE = "Go to or find";

const INPUT =
  "gt:h-10 gt:w-full gt:rounded-md gt:border gt:border-border gt:bg-background gt:px-3 gt:text-body gt:text-foreground " +
  "gt:placeholder:text-muted-foreground gt:pointer-coarse:h-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

const ROW =
  "gt:flex gt:min-h-9 gt:cursor-pointer gt:items-center gt:gap-3 gt:rounded-md gt:px-3 gt:text-body gt:text-foreground gt:pointer-coarse:min-h-11 " +
  "gt:data-[selected=true]:bg-muted gt:data-[disabled=true]:cursor-default gt:data-[disabled=true]:text-muted-foreground";

/**
 * The host's answer for `search`, asked once typing pauses. A newer input
 * abandons the request before it: its timer is cleared, or its late answer
 * is dropped.
 */
function useHits(search: { query: string; prefix: "@" | "#" } | null): { hits: EntityHit[]; pending: boolean } {
  const key = search ? `${search.prefix}${search.query}` : null;
  const [answer, setAnswer] = useState<{ key: string; hits: EntityHit[] } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const timer = setTimeout(() => {
      void kit.search(key.slice(1), key.charAt(0) as "@" | "#").then((hits) => current && setAnswer({ key, hits }));
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key]);
  const fresh = answer !== null && answer.key === key;
  return { hits: fresh ? answer.hits : [], pending: key !== null && !fresh };
}

function Body({ close }: { close(): void }) {
  const view = kit.useView();
  const { org, orgs } = kit.useManifest();
  const [input, setInput] = useState("");
  const [picking, setPicking] = useState<{ entry: NavEntry; picked: Picked } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // Choosing a row or pressing Back moves focus off the field; typing goes on there.
  const pick = (next: { entry: NavEntry; picked: Picked } | null) => {
    setPicking(next);
    setInput("");
    field.current?.focus();
  };
  const found = useHits(picking ? null : searchFor(input));
  const list = picking
    ? pickListing(view, picking.entry, picking.picked, input)
    : listing(input, { view, orgs, org: org.id }, found.hits);

  const choose = (choice: Choice) => {
    if (choice.type === "pick") {
      pick({ entry: choice.entry, picked: choice.picked });
    } else if (choice.type === "act") {
      if (!choice.ref.enabled) return;
      close();
      void kit.act(choice.ref);
    } else {
      close();
      kit.navigate(choice.href);
    }
  };
  // Backspace in an empty field goes back from a place pick to the whole list.
  const back = (event: KeyboardEvent) => {
    if (picking && event.key === "Backspace" && input === "") {
      event.preventDefault();
      pick(null);
    }
  };

  return (
    <Command shouldFilter={false} loop label={PALETTE_TITLE} className="gt:flex gt:flex-col gt:gap-2">
      <div className="gt:flex gt:items-center gt:gap-2">
        {picking && (
          <button type="button" className={TRAY_BUTTON} onClick={() => pick(null)}>
            Back
          </button>
        )}
        {/* Focused on open; Radix would otherwise focus the sheet's Close button. */}
        <Command.Input
          ref={field}
          autoFocus
          value={input}
          onValueChange={setInput}
          onKeyDown={back}
          placeholder={picking ? "Type to narrow the list" : "Type / for actions, @ for places, # to find"}
          className={INPUT}
        />
      </div>
      <Command.List className="gt:flex gt:flex-col gt:gap-2">
        {list.sections.map((section) => (
          <Command.Group
            key={section.heading}
            heading={<span className="gt:block gt:px-3 gt:pt-1 gt:text-caption gt:font-medium gt:text-muted-foreground">{section.heading}</span>}
          >
            {section.choices.map((choice) => (
              <Command.Item
                key={choice.key}
                value={choice.key}
                disabled={choice.type === "act" && !choice.ref.enabled}
                onSelect={() => choose(choice)}
                className={ROW}
              >
                <span className="gt:min-w-0 gt:flex-1 gt:truncate">{choice.label}</span>
                {choice.detail && (
                  <span className={cx("gt:shrink-0 gt:text-caption", choice.type === "act" && !choice.ref.enabled ? "gt:text-foreground" : "gt:text-muted-foreground")}>
                    <span className="gt:sr-only">, </span>
                    {choice.detail}
                  </span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
      {/* Kept in the accessibility tree while empty, so a screen reader hears it when the list empties. */}
      <p role="status" className="gt:px-3 gt:text-body gt:text-muted-foreground gt:empty:sr-only">
        {list.sections.length === 0 ? (found.pending ? "Searching…" : list.empty) : ""}
      </p>
    </Command>
  );
}

export function Palette({
  open,
  onOpenChange,
  returnFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  return (
    <Sheet title={PALETTE_TITLE} open={open} onOpenChange={onOpenChange} returnFocus={returnFocus}>
      <Body close={() => onOpenChange(false)} />
    </Sheet>
  );
}

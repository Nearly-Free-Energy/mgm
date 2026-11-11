/**
 * The tray, at the right of the title bar: what needs the person, the
 * status items, and the account menu. Status items show here from 600 px
 * and in the account menu below it.
 */
import { Bell } from "lucide-react";
import type { Signals } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { SHEET_ROW, Sheet } from "../ui/sheet";
import { StatusLinks, TRAY_BUTTON } from "./tray-parts";
import { UserMenu } from "./user-menu";

/** Hidden until the host serves signals. The count shows as a badge. */
function NeedsYou({ signals }: { signals: Signals | null }) {
  if (!signals) return null;
  const { count, top, unchecked } = signals;
  return (
    <Sheet
      title="Needs you"
      trigger={
        <button type="button" aria-label={count > 0 ? `Needs you: ${count}` : "Needs you"} className={TRAY_BUTTON}>
          <Bell aria-hidden="true" focusable="false" className="gt:size-5" />
          {count > 0 && (
            <span className="gt:rounded-pill gt:bg-primary gt:px-1.5 gt:text-caption gt:font-medium gt:text-primary-foreground">
              {count}
            </span>
          )}
        </button>
      }
    >
      {top.length > 0 ? (
        <ul className="gt:flex gt:flex-col gt:gap-1">
          {top.map((signal) => (
            <li key={signal.id}>
              <kit.Link href={signal.href} className={SHEET_ROW}>
                {signal.title}
              </kit.Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gt:px-1 gt:text-body gt:text-muted-foreground">Nothing needs you right now.</p>
      )}
      {unchecked.length > 0 && (
        <p className="gt:mt-2 gt:px-1 gt:text-caption gt:text-muted-foreground">Some sources did not answer in time.</p>
      )}
    </Sheet>
  );
}

export function Tray() {
  const { org } = kit.useManifest();
  const signals = kit.useSignals();
  const count = signals?.count ?? 0;
  return (
    <div className="gt:flex gt:shrink-0 gt:items-center gt:gap-1">
      <NeedsYou signals={signals} />
      {/* In place before signals arrive, so a screen reader announces the count when it fills. */}
      <span role="status" className="gt:sr-only">
        {count > 0 ? `${count} ${count === 1 ? "thing needs" : "things need"} you` : ""}
      </span>
      <StatusLinks items={org.status} className="gt:hidden gt:items-center gt:gap-1 gt:medium:flex" />
      <UserMenu />
    </div>
  );
}

/**
 * The 48 px band above the page: the mark, which opens the dashboard when
 * the manifest's nav has one, the context path with its switchers, and the
 * tray.
 */
import type { Id } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { ContextPath } from "./context-path";
import { Tray } from "./tray";

const MARK = "gt:inline-flex gt:size-9 gt:shrink-0 gt:items-center gt:justify-center gt:rounded-md gt:text-title gt:text-primary gt:pointer-coarse:size-11";

/** The dashboard's nav id (src/lib/organization-directory/surface.ts, which keeps it if the page moves to a view); if it changes, revisit. */
const DASHBOARD = "org.today";

/** `app` is the current app's nav id, which a switch keeps where it can. */
export function TitleBar({ app }: { app: Id | null }) {
  const view = kit.useView();
  const { org } = kit.useManifest();
  // A GUI links only where the host points (conformance check 6), so the mark follows the dashboard's nav entry.
  const today = org.nav.find((entry) => entry.id === DASHBOARD);
  const home = today && view.href(today);
  return (
    <header className="gt:col-span-full gt:flex gt:h-12 gt:min-w-0 gt:items-center gt:gap-2 gt:border-b gt:border-border gt:bg-card gt:px-2 gt:medium:px-3">
      {home ? (
        <kit.Link href={home} className={cx(MARK, "gt:hover:bg-muted gt:focus-visible:outline-2 gt:focus-visible:outline-ring")}>
          <span aria-hidden="true">◆</span>
          <span className="gt:sr-only">{today.title}</span>
        </kit.Link>
      ) : (
        <span aria-hidden="true" className={MARK}>
          ◆
        </span>
      )}
      <ContextPath app={app} />
      <Tray />
    </header>
  );
}
